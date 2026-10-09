import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import type { SessionInfo } from '@bancada/protocol'
import { type RawData, WebSocket, WebSocketServer } from 'ws'
import type { DeviceInfo, DeviceStore } from './devices.js'
import { type HostLink, HostUnavailableError } from './host-link.js'
import {
  clearedCookie,
  deviceCookie,
  HttpError,
  isSameOrigin,
  readJsonBody,
  sendJson,
  tokenFromRequest,
} from './http-util.js'
import type { PairingService } from './pairing.js'
import { type PushService, parseSubscription, type SubscriptionStore } from './push.js'
import { securityHeaders, serveStatic } from './static.js'

export const SNAPSHOT_SCROLLBACK = 500
const MAX_INPUT_CHARS = 16 * 1024
const MAX_VIEWERS_PER_DEVICE = 8
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const PING_INTERVAL_MS = 25_000

export interface SessionSummary {
  id: string
  title: string | null
  cwdName: string
  state: SessionInfo['state']
  cols: number
  rows: number
  createdAt: number
  lastOutputAt: number | null
  exitCode: number | null
}

/** What the phone gets to know about a session: no pid, command line, environment, or full path. */
export function summarize(session: SessionInfo): SessionSummary {
  return {
    id: session.id,
    title: session.title?.trim() || null,
    cwdName: path.basename(session.cwd) || session.cwd,
    state: session.state,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    lastOutputAt: session.lastOutputAt ?? null,
    exitCode: session.exitCode ?? null,
  }
}

export interface PublicApiOptions {
  devices: DeviceStore
  pairing: PairingService
  link: HostLink
  push: PushService
  subscriptions: SubscriptionStore
  pwaDir: string | undefined
  log: (message: string) => void
}

interface ViewerConn {
  ws: WebSocket
  deviceId: string
  closed: boolean
  alive: boolean
  close(reason: string): void
}

/**
 * The API the phone talks to. Every route but `POST /api/pair` and the static PWA shell needs a valid device cookie;
 * requests from 127.0.0.1 get no special treatment, because `tailscale serve` proxies every tailnet request from there.
 * Nothing here can kill, dispose, spawn or resize a session.
 */
export class PublicApi {
  readonly server: http.Server
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  private readonly viewers = new Map<string, Set<ViewerConn>>()
  private readonly pingTimer: NodeJS.Timeout

  constructor(private readonly options: PublicApiOptions) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => this.fail(res, error))
    })
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
    options.devices.onRevoked((device) => this.dropDevice(device))
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS)
    this.pingTimer.unref()
  }

  get viewerCount(): number {
    let n = 0
    for (const set of this.viewers.values()) n += set.size
    return n
  }

  close(): void {
    clearInterval(this.pingTimer)
    for (const set of this.viewers.values()) for (const conn of [...set]) conn.close('shutdown')
    this.wss.close()
    this.server.closeAllConnections()
  }

  private authenticate(req: IncomingMessage): DeviceInfo | null {
    return this.options.devices.authenticate(tokenFromRequest(req))
  }

  private fail(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (error instanceof HttpError) sendJson(res, error.status, { error: error.code })
    else if (error instanceof HostUnavailableError) sendJson(res, 503, { error: 'host_unavailable' })
    else {
      this.options.log(`request failed (${error instanceof Error ? error.message : String(error)})`)
      sendJson(res, 500, { error: 'internal' })
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const method = req.method ?? 'GET'

    if (!url.pathname.startsWith('/api/')) {
      if (this.options.pwaDir && serveStatic(this.options.pwaDir, req, res)) return
      res.writeHead(404, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }

    if (url.pathname === '/api/pair') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed')
      if (!isSameOrigin(req)) throw new HttpError(403, 'bad_origin')
      const body = (await readJsonBody(req)) as { code?: unknown; name?: unknown }
      const result = this.options.pairing.redeem(body.code, body.name)
      if (!result.ok) {
        if (result.reason === 'rate_limited') {
          const retry = Math.ceil(result.retryAfterMs / 1000)
          sendJson(res, 429, { error: 'rate_limited', retryAfterSeconds: retry }, { 'retry-after': String(retry) })
          return
        }
        sendJson(res, 401, { error: 'invalid_code' })
        return
      }
      this.options.log(`paired a device (${result.device.name})`)
      sendJson(res, 200, { device: result.device }, { 'set-cookie': deviceCookie(result.token) })
      return
    }

    const device = this.authenticate(req)
    if (!device) {
      sendJson(res, 401, { error: 'unauthorized' }, { 'set-cookie': clearedCookie() })
      return
    }
    if (method !== 'GET' && method !== 'HEAD' && !isSameOrigin(req)) throw new HttpError(403, 'bad_origin')

    if (url.pathname === '/api/me' && method === 'GET') {
      sendJson(res, 200, { device, push: { subscribed: this.options.subscriptions.hasDevice(device.id) } })
      return
    }
    if (url.pathname === '/api/logout' && method === 'POST') {
      this.options.devices.revoke(device.id)
      sendJson(res, 200, { ok: true }, { 'set-cookie': clearedCookie() })
      return
    }
    if (url.pathname === '/api/sessions' && method === 'GET') {
      const sessions = await this.options.link.list()
      sendJson(res, 200, { sessions: sessions.map(summarize) })
      return
    }
    if (url.pathname === '/api/push/key' && method === 'GET') {
      sendJson(res, 200, { publicKey: this.options.push.publicKey })
      return
    }
    if (url.pathname === '/api/push/subscribe' && method === 'POST') {
      const body = (await readJsonBody(req)) as { subscription?: unknown }
      const subscription = parseSubscription(body.subscription)
      if (!subscription) throw new HttpError(400, 'invalid_subscription')
      if (!this.options.subscriptions.set(device.id, subscription)) throw new HttpError(409, 'too_many_subscriptions')
      sendJson(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/api/push/unsubscribe' && method === 'POST') {
      this.options.subscriptions.removeDevice(device.id)
      sendJson(res, 200, { ok: true })
      return
    }
    throw new HttpError(404, 'not_found')
  }

  // WebSocket ---------------------------------------------------------------------------------------------------

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number, text: string): void => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    const match = /^\/api\/sessions\/([^/]{1,64})\/stream$/.exec(new URL(req.url ?? '/', 'http://x').pathname)
    if (!match) {
      reject(404, 'Not Found')
      return
    }
    if (!isSameOrigin(req)) {
      reject(403, 'Forbidden')
      return
    }
    const device = this.authenticate(req)
    if (!device) {
      reject(401, 'Unauthorized')
      return
    }
    if ((this.viewers.get(device.id)?.size ?? 0) >= MAX_VIEWERS_PER_DEVICE) {
      reject(429, 'Too Many Requests')
      return
    }
    const sessionId = decodeURIComponent(match[1] as string)
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.stream(ws, device, sessionId)
    })
  }

  private register(conn: ViewerConn): void {
    let set = this.viewers.get(conn.deviceId)
    if (!set) {
      set = new Set()
      this.viewers.set(conn.deviceId, set)
    }
    set.add(conn)
  }

  private unregister(conn: ViewerConn): void {
    const set = this.viewers.get(conn.deviceId)
    set?.delete(conn)
    if (set?.size === 0) this.viewers.delete(conn.deviceId)
  }

  /** Closes every open socket of a revoked device at once; each socket's own host connection goes with it. */
  private dropDevice(device: DeviceInfo): void {
    for (const conn of [...(this.viewers.get(device.id) ?? [])]) conn.close('revoked')
    this.options.subscriptions.removeDevice(device.id)
  }

  private ping(): void {
    for (const set of this.viewers.values()) {
      for (const conn of set) {
        if (!conn.alive) {
          conn.ws.terminate()
          continue
        }
        conn.alive = false
        conn.ws.ping()
      }
    }
  }

  private async stream(ws: WebSocket, device: DeviceInfo, sessionId: string): Promise<void> {
    const state: { viewer: Awaited<ReturnType<HostLink['connectViewer']>> | null; exited: boolean; ready: boolean } = {
      viewer: null,
      exited: false,
      ready: false,
    }
    const pending: { data: RawData; isBinary: boolean }[] = []
    const conn: ViewerConn = {
      ws,
      deviceId: device.id,
      closed: false,
      alive: true,
      close: (reason) => {
        if (conn.closed) return
        conn.closed = true
        this.unregister(conn)
        state.viewer?.close()
        if (reason === 'revoked') {
          try {
            ws.close(4401, 'revoked')
          } catch {
            // already closing
          }
          // A client that ignores the close handshake does not get to keep the socket.
          setTimeout(() => ws.terminate(), 1000).unref()
        } else if (ws.readyState === WebSocket.OPEN) ws.close(reason === 'shutdown' ? 1001 : 1011, reason)
      },
    }
    this.register(conn)
    ws.on('pong', () => {
      conn.alive = true
    })
    ws.on('close', () => {
      conn.closed = true
      this.unregister(conn)
      state.viewer?.close()
    })
    ws.on('error', () => ws.terminate())
    ws.on('message', (data, isBinary) => {
      if (conn.closed) return
      if (state.ready) this.onMessage(ws, conn, state, sessionId, data, isBinary)
      else pending.push({ data, isBinary })
    })

    const send = (message: unknown): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    }
    try {
      const info = await this.options.link.find(sessionId)
      if (!info) {
        send({ type: 'error', code: 'not_found' })
        ws.close(4404, 'not_found')
        return
      }
      const viewer = await this.options.link.connectViewer()
      if (conn.closed) {
        viewer.close()
        return
      }
      state.viewer = viewer
      viewer.onClose(() => conn.close('host_gone'))
      viewer.onEvent((event) => {
        if (event.event === 'session-title' && event.id === sessionId) send({ type: 'title', title: event.title })
        else if (event.event === 'session-exited' && event.id === sessionId) {
          state.exited = true
          send({ type: 'exit', exitCode: event.exitCode })
        } else if (event.event === 'session-removed' && event.id === sessionId) conn.close('session_removed')
      })
      const snapshot = await viewer.attach(
        sessionId,
        (bytes) => {
          if (conn.closed || ws.readyState !== WebSocket.OPEN) return
          if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            conn.close('too_slow')
            return
          }
          ws.send(bytes, { binary: true })
        },
        { scrollback: SNAPSHOT_SCROLLBACK },
      )
      state.exited = info.state !== 'running'
      send({
        type: 'snapshot',
        id: sessionId,
        cols: snapshot.cols,
        rows: snapshot.rows,
        data: snapshot.data,
        title: this.options.link.cached(sessionId)?.title ?? null,
        state: info.state,
      })
      state.ready = true
      for (const item of pending.splice(0)) this.onMessage(ws, conn, state, sessionId, item.data, item.isBinary)
    } catch (error) {
      this.options.log(`stream failed (${error instanceof Error ? error.message : String(error)})`)
      send({ type: 'error', code: 'internal' })
      conn.close('internal')
    }
  }

  private onMessage(
    ws: WebSocket,
    conn: ViewerConn,
    state: { viewer: { write(id: string, data: string): void } | null; exited: boolean },
    sessionId: string,
    data: RawData,
    isBinary: boolean,
  ): void {
    const reply = (code: string): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', code }))
    }
    if (isBinary) {
      reply('unsupported')
      return
    }
    let message: { type?: unknown; data?: unknown }
    try {
      message = JSON.parse(data.toString('utf8')) as typeof message
    } catch {
      reply('invalid_json')
      return
    }
    // The phone can type and nothing else: no resize (the session keeps its own size), no kill, no dispose.
    if (message.type !== 'input') {
      reply('unsupported')
      return
    }
    if (typeof message.data !== 'string' || message.data.length === 0 || message.data.length > MAX_INPUT_CHARS) {
      reply('invalid_input')
      return
    }
    if (state.exited || conn.closed) {
      reply('session_exited')
      return
    }
    state.viewer?.write(sessionId, message.data)
  }
}
