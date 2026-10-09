import { createECDH } from 'node:crypto'
import type { Agent } from 'node:https'
import path from 'node:path'
import webpush from 'web-push'
import { readJson, writeJsonPrivate } from './fsutil.js'
import type { SecretStore } from './secrets.js'

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

/** `publicKey` is the uncompressed P-256 point of `privateKey`, both base64url (what `PushManager.subscribe` wants). */
export function vapidFromPrivate(privateKey: string): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'))
  return { privateKey, publicKey: ecdh.getPublicKey().toString('base64url') }
}

/** Reads the VAPID private key from the store, generating and storing one the first time. */
export async function loadOrCreateVapid(store: SecretStore): Promise<VapidKeys> {
  const existing = await store.read()
  if (existing) return vapidFromPrivate(existing)
  const generated = webpush.generateVAPIDKeys()
  await store.write(generated.privateKey)
  return vapidFromPrivate(generated.privateKey)
}

export interface PushSubscriptionJson {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface StoredSubscription extends PushSubscriptionJson {
  deviceId: string
  createdAt: number
}

interface PushFile {
  version: 1
  subscriptions: StoredSubscription[]
}

const MAX_SUBSCRIPTIONS = 20
const B64URL = /^[A-Za-z0-9_-]+$/

export function parseSubscription(raw: unknown): PushSubscriptionJson | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { endpoint, keys } = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return null
  try {
    if (new URL(endpoint).protocol !== 'https:') return null
  } catch {
    return null
  }
  const p256dh = keys?.p256dh
  const auth = keys?.auth
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null
  if (!B64URL.test(p256dh) || !B64URL.test(auth) || p256dh.length > 200 || auth.length > 64) return null
  return { endpoint, keys: { p256dh, auth } }
}

/** `<dataDir>/push.json` (mode 0600): one subscription per device. */
export class SubscriptionStore {
  private subscriptions: StoredSubscription[]

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.subscriptions = readJson<Partial<PushFile>>(file, {}).subscriptions ?? []
  }

  /** Replaces the device's subscription (a device has one). Returns false when the store is full. */
  set(deviceId: string, subscription: PushSubscriptionJson): boolean {
    const others = this.subscriptions.filter((s) => s.deviceId !== deviceId && s.endpoint !== subscription.endpoint)
    if (others.length >= MAX_SUBSCRIPTIONS) return false
    this.subscriptions = [...others, { ...subscription, deviceId, createdAt: this.now() }]
    this.save()
    return true
  }

  removeDevice(deviceId: string): void {
    const kept = this.subscriptions.filter((s) => s.deviceId !== deviceId)
    if (kept.length === this.subscriptions.length) return
    this.subscriptions = kept
    this.save()
  }

  removeEndpoint(endpoint: string): void {
    const kept = this.subscriptions.filter((s) => s.endpoint !== endpoint)
    if (kept.length === this.subscriptions.length) return
    this.subscriptions = kept
    this.save()
  }

  hasDevice(deviceId: string): boolean {
    return this.subscriptions.some((s) => s.deviceId === deviceId)
  }

  all(): StoredSubscription[] {
    return [...this.subscriptions]
  }

  private save(): void {
    const data: PushFile = { version: 1, subscriptions: this.subscriptions }
    writeJsonPrivate(this.file, data)
  }
}

export interface PushPayload {
  title: string
  body: string
  /** Where a tap on the notification goes: `/#/s/<id>` for a session. */
  url: string
  /** Notifications with the same tag replace each other. */
  tag?: string
}

export interface PushSessionRef {
  id: string
  title?: string
  cwd: string
}

export function sessionUrl(id: string): string {
  return `/#/s/${encodeURIComponent(id)}`
}

/** Title = the session's title, else its cwd's basename. */
export function sessionLabel(session: Pick<PushSessionRef, 'title' | 'cwd'>): string {
  const title = session.title?.trim()
  if (title) return title
  return path.basename(session.cwd) || 'Bancada'
}

export function bellPayload(session: PushSessionRef): PushPayload {
  return {
    title: sessionLabel(session),
    body: 'Sino do terminal',
    url: sessionUrl(session.id),
    tag: `bell-${session.id}`,
  }
}

export function textPayload(text: string, session?: PushSessionRef): PushPayload {
  const body = text.slice(0, 300)
  if (!session) return { title: 'Bancada', body, url: '/' }
  return { title: sessionLabel(session), body, url: sessionUrl(session.id) }
}

export interface PushServiceOptions {
  store: SubscriptionStore
  vapid: VapidKeys
  /** Must be a `mailto:` or `https:` URL; Apple rejects the token otherwise. */
  subject: string
  /** HTTPS agent for the push request. Tests point it at a fake endpoint with a self-signed certificate. */
  agent?: Agent
  timeoutMs?: number
  log?: (message: string) => void
}

export interface PushResult {
  sent: number
  failed: number
  removed: number
}

/** Sends Web Push (RFC 8030 + VAPID RFC 8292 + aes128gcm RFC 8291) to every stored subscription. */
export class PushService {
  constructor(private readonly options: PushServiceOptions) {}

  get publicKey(): string {
    return this.options.vapid.publicKey
  }

  async notify(payload: PushPayload): Promise<PushResult> {
    const { store, vapid, subject, agent, timeoutMs = 10_000, log } = this.options
    const body = JSON.stringify(payload)
    const result: PushResult = { sent: 0, failed: 0, removed: 0 }
    await Promise.all(
      store.all().map(async (subscription) => {
        try {
          await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, body, {
            vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
            TTL: 120,
            urgency: 'high',
            timeout: timeoutMs,
            agent,
          })
          result.sent++
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) {
            store.removeEndpoint(subscription.endpoint)
            result.removed++
          } else {
            result.failed++
          }
          log?.(`push to a subscription failed (${status ?? (error as Error).message})`)
        }
      }),
    )
    return result
  }
}
