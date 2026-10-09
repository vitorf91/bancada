import type { IncomingMessage, ServerResponse } from 'node:http'

export const COOKIE_NAME = '__Host-bancada_device'
const COOKIE_MAX_AGE_S = 365 * 24 * 3600

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (name && !(name in out)) out[name] = part.slice(eq + 1).trim()
  }
  return out
}

/** HttpOnly + Secure + SameSite=Strict, host-only (`__Host-`): JavaScript on the page never sees the token. */
export function deviceCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`
}

export function clearedCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

export function tokenFromRequest(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[COOKIE_NAME]
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return v?.split(',')[0]?.trim() || undefined
}

/**
 * CSRF / cross-site WebSocket guard for state-changing requests. Browsers send `Sec-Fetch-Site`, which a page cannot
 * forge: only `same-origin` passes. Without it, `Origin` must name this server's host (`X-Forwarded-Host` from
 * `tailscale serve`, or `Host`). A missing `Origin` fails. This is on top of SameSite=Strict, and it is not what
 * authenticates anything: the cookie does, and "the request came from localhost" is not a signal at all.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const site = firstHeader(req.headers['sec-fetch-site'])
  if (site !== undefined) return site === 'same-origin'
  const origin = firstHeader(req.headers.origin)
  if (!origin) return false
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  return host === firstHeader(req.headers['x-forwarded-host']) || host === firstHeader(req.headers.host)
}

/**
 * The path of a request target in origin-form (`/a/b?q`), or null when it is anything else. Peers send arbitrary bytes
 * here before any authentication, and `new URL` throws on some of them (`//`, for one), so nothing may call it
 * on `req.url` directly. A target that starts with `//` is refused as well: URL parsing would read it as a host.
 */
export function requestPath(req: IncomingMessage): string | null {
  const target = req.url ?? '/'
  if (!target.startsWith('/') || target.startsWith('//')) return null
  try {
    return new URL(target, 'http://x').pathname
  } catch {
    return null
  }
}

/** `decodeURIComponent` that answers null for malformed percent-escapes instead of throwing. */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

export async function readJsonBody(req: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  const type = req.headers['content-type'] ?? ''
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'payload_too_large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(payload)
}
