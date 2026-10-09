import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { DeviceStore } from './devices.js'
import type { HostLink } from './host-link.js'
import { HttpError, readJsonBody, sendJson } from './http-util.js'
import type { PairingService } from './pairing.js'
import { PAIRING_TTL_MS } from './pairing.js'
import { ensureSocketDir } from './paths.js'
import { type PushService, type SubscriptionStore, textPayload } from './push.js'

export interface ControlApiOptions {
  socketPath: string
  uid: number
  devices: DeviceStore
  pairing: PairingService
  push: PushService
  subscriptions: SubscriptionStore
  link: HostLink
  publicPort: () => number
  log: (message: string) => void
}

/** Is a server already listening on this control socket? Also used by the CLI to tell "not running" from "stale file". */
export function socketIsAlive(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(file)) return resolve(false)
    const probe = http.request({ socketPath: file, path: '/v1/status', timeout: 1500 }, (res) => {
      res.resume()
      resolve(true)
    })
    probe.on('error', () => resolve(false))
    probe.on('timeout', () => {
      probe.destroy()
      resolve(false)
    })
    probe.end()
  })
}

/**
 * The local control API for the CLI, on a Unix socket (mode 0600) and nowhere else: pairing codes, devices, notify.
 * Reaching the socket is the authority, so it is never exposed on a TCP port.
 */
export class ControlApi {
  readonly server: http.Server
  private listening = false

  constructor(private readonly options: ControlApiOptions) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        if (error instanceof HttpError) sendJson(res, error.status, { error: error.code })
        else {
          options.log(`control request failed (${error instanceof Error ? error.message : String(error)})`)
          sendJson(res, 500, { error: 'internal' })
        }
      })
    })
  }

  async listen(): Promise<void> {
    const { socketPath, uid } = this.options
    ensureSocketDir(socketPath, uid)
    if (await socketIsAlive(socketPath)) throw new Error(`A Bancada server is already running (${socketPath})`)
    fs.rmSync(socketPath, { force: true }) // a leftover file from a server that died
    const previousUmask = process.umask(0o177)
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(socketPath, () => {
          this.server.off('error', reject)
          resolve()
        })
      })
    } finally {
      process.umask(previousUmask)
    }
    this.listening = true
    fs.chmodSync(socketPath, 0o600)
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    // Never remove a socket this instance did not create: it may belong to the server that is already running.
    if (this.listening) fs.rmSync(this.options.socketPath, { force: true })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const method = req.method ?? 'GET'
    const { devices, pairing, push, subscriptions, link } = this.options

    if (url.pathname === '/v1/status' && method === 'GET') {
      sendJson(res, 200, {
        port: this.options.publicPort(),
        devices: devices.list().length,
        subscriptions: subscriptions.all().length,
        hostConnected: link.connected,
      })
      return
    }
    if (url.pathname === '/v1/pairing' && method === 'POST') {
      const { code, expiresAt } = pairing.createCode()
      sendJson(res, 200, { code, expiresAt, ttlSeconds: PAIRING_TTL_MS / 1000 })
      return
    }
    if (url.pathname === '/v1/devices' && method === 'GET') {
      sendJson(res, 200, {
        devices: devices.list().map((d) => ({ ...d, push: subscriptions.hasDevice(d.id) })),
      })
      return
    }
    const device = /^\/v1\/devices\/([^/]+)$/.exec(url.pathname)
    if (device && method === 'DELETE') {
      const id = devices.resolveId(decodeURIComponent(device[1] as string))
      if (!id) throw new HttpError(404, 'not_found')
      devices.revoke(id)
      sendJson(res, 200, { ok: true, id })
      return
    }
    if (url.pathname === '/v1/notify' && method === 'POST') {
      const body = (await readJsonBody(req)) as { text?: unknown; sessionId?: unknown }
      if (typeof body.text !== 'string' || body.text.trim() === '') throw new HttpError(400, 'text_required')
      let payload = textPayload(body.text.trim())
      if (typeof body.sessionId === 'string') {
        const session = await link.find(body.sessionId)
        if (!session) throw new HttpError(404, 'session_not_found')
        payload = textPayload(body.text.trim(), session)
      }
      sendJson(res, 200, await push.notify(payload))
      return
    }
    throw new HttpError(404, 'not_found')
  }
}
