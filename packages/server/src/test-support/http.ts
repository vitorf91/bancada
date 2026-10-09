import { randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { WebSocket } from 'ws'

export interface Response {
  status: number
  headers: http.IncomingHttpHeaders
  text: string
  json<T = unknown>(): T
}

/** A plain HTTP request with full control over the headers (Host, Origin, Cookie), unlike `fetch`. */
export function request(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown; cookie?: string; origin?: string | null } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const headers: Record<string, string> = { ...options.headers }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload))
    }
    if (options.cookie) headers.cookie = options.cookie
    const origin = options.origin === undefined ? `http://127.0.0.1:${port}` : options.origin
    if (origin) headers.origin = origin
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: <T>() => JSON.parse(text) as T })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/** Pairs a device against a running server; returns the Cookie header value. */
export async function pairDevice(
  port: number,
  code: string,
  name = 'iPhone',
): Promise<{ cookie: string; deviceId: string }> {
  const res = await request(port, 'POST', '/api/pair', { body: { code, name } })
  if (res.status !== 200) throw new Error(`pairing failed with ${res.status}: ${res.text}`)
  const setCookie = res.headers['set-cookie']?.[0]
  if (!setCookie) throw new Error('no cookie')
  return {
    cookie: (setCookie.split(';')[0] as string).trim(),
    deviceId: res.json<{ device: { id: string } }>().device.id,
  }
}

export interface WsHarness {
  ws: WebSocket
  messages: unknown[]
  binary: Buffer[]
  closed: Promise<{ code: number; reason: string }>
  waitForMessage(type: string, timeoutMs?: number): Promise<Record<string, unknown>>
  waitForBinary(text: string, timeoutMs?: number): Promise<void>
}

export function openStream(
  port: number,
  sessionId: string,
  options: { cookie?: string; origin?: string | null } = {},
): Promise<WsHarness> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (options.cookie) headers.cookie = options.cookie
    const origin = options.origin === undefined ? `http://127.0.0.1:${port}` : options.origin
    if (origin) headers.origin = origin
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/stream`, { headers })
    const messages: unknown[] = []
    const binary: Buffer[] = []
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.on('close', (code, reason) => res({ code, reason: reason.toString('utf8') }))
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) binary.push(data as Buffer)
      else messages.push(JSON.parse(data.toString('utf8')))
    })
    const poll = async <T>(find: () => T | undefined, what: string, timeoutMs: number): Promise<T> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = find()
        if (found !== undefined) return found
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    ws.once('open', () =>
      resolve({
        ws,
        messages,
        binary,
        closed,
        waitForMessage: (type, timeoutMs = 10_000) =>
          poll(
            () => messages.find((m) => (m as { type?: string }).type === type) as Record<string, unknown> | undefined,
            `message ${type}`,
            timeoutMs,
          ),
        waitForBinary: async (text, timeoutMs = 10_000) => {
          await poll(
            () => (Buffer.concat(binary).toString('utf8').includes(text) ? true : undefined),
            `output ${text}`,
            timeoutMs,
          )
        },
      }),
    )
    ws.once('unexpected-response', (_req, res) =>
      reject(Object.assign(new Error(`upgrade refused: ${res.statusCode}`), { status: res.statusCode })),
    )
    ws.once('error', reject)
  })
}

/** Sends raw bytes and returns the status line of the answer (or '' when the server closed without one). */
export function rawStatusLine(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(raw))
    let text = ''
    socket.on('data', (c) => {
      text += c.toString('latin1')
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(text.split('\r\n')[0] ?? ''))
  })
}

/** A WebSocket upgrade request with a hand-written request target, which `ws` and `fetch` would normalize. */
export function rawUpgrade(port: number, target: string, cookie?: string): string {
  return [
    `GET ${target} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    `Origin: http://127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    'Sec-WebSocket-Version: 13',
    ...(cookie ? [`Cookie: ${cookie}`] : []),
    '',
    '',
  ].join('\r\n')
}
