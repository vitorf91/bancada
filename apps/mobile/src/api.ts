export interface SessionSummary {
  id: string
  title: string | null
  cwdName: string
  state: 'running' | 'exited' | 'lost'
  cols: number
  rows: number
  createdAt: number
  lastOutputAt: number | null
  exitCode: number | null
}

export interface DeviceInfo {
  id: string
  name: string
}

export class ApiError extends Error {
  override name = 'ApiError'
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`${status} ${code}`)
  }
}

/** The server could not be reached at all (Tailscale off, Mac asleep). */
export class NetworkError extends Error {
  override name = 'NetworkError'
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new NetworkError('network')
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // not JSON (a proxy error page): treated as an empty body
  }
  if (!res.ok) {
    const parsed = json as { error?: string; retryAfterSeconds?: number } | null
    throw new ApiError(res.status, parsed?.error ?? 'error', parsed?.retryAfterSeconds)
  }
  return json as T
}

export const api = {
  me: () => call<{ device: DeviceInfo; push: { subscribed: boolean } }>('GET', '/api/me'),
  pair: (code: string, name: string) => call<{ device: DeviceInfo }>('POST', '/api/pair', { code, name }),
  sessions: () => call<{ sessions: SessionSummary[] }>('GET', '/api/sessions'),
  pushKey: () => call<{ publicKey: string }>('GET', '/api/push/key'),
  pushSubscribe: (subscription: PushSubscriptionJSON) =>
    call<{ ok: true }>('POST', '/api/push/subscribe', { subscription }),
  pushUnsubscribe: () => call<{ ok: true }>('POST', '/api/push/unsubscribe', {}),
  logout: () => call<{ ok: true }>('POST', '/api/logout', {}),
}
