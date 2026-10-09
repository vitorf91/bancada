export type Route = { name: 'list' } | { name: 'pair'; code: string } | { name: 'session'; id: string }

/** Hash routes: `#/`, `#/pair`, `#/pair/ABCD1234` (what the QR carries), `#/s/<session id>`. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '')
  const pair = /^\/pair(?:\/([^/]*))?$/.exec(path)
  if (pair) return { name: 'pair', code: decodeURIComponent(pair[1] ?? '') }
  const session = /^\/s\/([^/]+)$/.exec(path)
  if (session) return { name: 'session', id: decodeURIComponent(session[1] as string) }
  return { name: 'list' }
}

export function sessionHash(id: string): string {
  return `#/s/${encodeURIComponent(id)}`
}
