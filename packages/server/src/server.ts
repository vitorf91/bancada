import fs from 'node:fs'
import type { Agent } from 'node:https'
import path from 'node:path'
import { BellWatcher } from './bell.js'
import { ControlApi } from './control.js'
import { DeviceStore } from './devices.js'
import { type HostConnector, HostLink } from './host-link.js'
import { type PairingOptions, PairingService } from './pairing.js'
import { DEVICES_FILE, PUSH_FILE, resolveControlSocketPath } from './paths.js'
import { PublicApi } from './public-api.js'
import { bellPayload, loadOrCreateVapid, PushService, SubscriptionStore } from './push.js'
import type { SecretStore } from './secrets.js'

export const DEFAULT_PORT = 7655
export const DEFAULT_VAPID_SUBJECT = 'https://github.com/vitorf91/bancada'

export interface ServerOptions {
  dataDir: string
  connector: HostConnector
  vapidStore: SecretStore
  /** Public API port on 127.0.0.1. 0 picks a free one (tests). */
  port?: number
  /** Built PWA (`apps/mobile/dist`). Without it only the API is served. */
  pwaDir?: string
  vapidSubject?: string
  /** HTTPS agent for push requests (tests use it to reach a fake endpoint with a self-signed certificate). */
  pushAgent?: Agent
  now?: () => number
  bellWindowMs?: number
  pairing?: Pick<PairingOptions, 'ttlMs' | 'maxFailures' | 'windowMs'>
  log?: (message: string) => void
}

export interface RunningServer {
  /** The port the public API listens on (always 127.0.0.1). */
  port: number
  controlSocketPath: string
  devices: DeviceStore
  pairing: PairingService
  push: PushService
  subscriptions: SubscriptionStore
  link: HostLink
  api: PublicApi
  close(): Promise<void>
}

/** The public API listens on 127.0.0.1 only. `tailscale serve` is what makes it reachable from the phone. */
export const BIND_ADDRESS = '127.0.0.1'

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.log ?? (() => {})
  const { dataDir } = options
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const uid = process.getuid?.() ?? 0

  const devices = new DeviceStore(path.join(dataDir, DEVICES_FILE), options.now)
  const subscriptions = new SubscriptionStore(path.join(dataDir, PUSH_FILE), options.now)
  const vapid = await loadOrCreateVapid(options.vapidStore)
  const push = new PushService({
    store: subscriptions,
    vapid,
    subject: options.vapidSubject ?? DEFAULT_VAPID_SUBJECT,
    agent: options.pushAgent,
    log,
  })
  const pairing = new PairingService({ devices, now: options.now, ...options.pairing })

  const bells = new BellWatcher(
    (sessionId) => {
      const session = link.cached(sessionId)
      if (!session) return
      void push.notify(bellPayload(session)).then((result) => {
        log(`bell in a session: ${result.sent} push sent, ${result.failed} failed, ${result.removed} removed`)
      })
    },
    options.now,
    options.bellWindowMs,
  )
  const link = new HostLink(options.connector, {
    onOutput: (id, bytes) => bells.output(id, bytes),
    onSessionGone: (id) => bells.forget(id),
    log,
  })
  await link.start()

  const api = new PublicApi({ devices, pairing, link, push, subscriptions, pwaDir: options.pwaDir, log })
  const control = new ControlApi({
    socketPath: resolveControlSocketPath(dataDir, uid),
    uid,
    devices,
    pairing,
    push,
    subscriptions,
    link,
    publicPort: () => port,
    log,
  })
  let port = 0
  try {
    await control.listen()
    await new Promise<void>((resolve, reject) => {
      api.server.once('error', reject)
      api.server.listen(options.port ?? DEFAULT_PORT, BIND_ADDRESS, () => {
        api.server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    link.close()
    api.close()
    await control.close().catch(() => {})
    throw error
  }
  const address = api.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  log(`public API on http://${BIND_ADDRESS}:${port}, control socket ${resolveControlSocketPath(dataDir, uid)}`)

  return {
    port,
    controlSocketPath: resolveControlSocketPath(dataDir, uid),
    devices,
    pairing,
    push,
    subscriptions,
    link,
    api,
    async close() {
      link.close()
      api.close()
      await new Promise<void>((resolve) => api.server.close(() => resolve()))
      await control.close()
      devices.flush()
    },
  }
}
