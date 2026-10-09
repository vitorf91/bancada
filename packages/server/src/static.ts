import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { decodeSegment, requestPath } from './http-util.js'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
}

/** The PWA shell is public: it holds no data, and the pairing screen has to load before there is a cookie. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ')

export function securityHeaders(): Record<string, string> {
  return {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  }
}

/** Serves a file of `root` for GET/HEAD. Returns false when there is no such file (the caller answers 404). */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const raw = requestPath(req)
  const pathname = raw === null ? null : decodeSegment(raw)
  if (pathname === null || pathname.includes('\0')) return false
  const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname
  const file = path.join(root, path.normalize(relative))
  if (file !== root && !file.startsWith(root + path.sep)) return false
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return false
  }
  if (!stat.isFile()) return false

  const immutable = relative.startsWith('/assets/')
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  fs.createReadStream(file).pipe(res)
  return true
}
