import http from 'node:http'

export class ControlError extends Error {
  override name = 'ControlError'
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`)
  }
}

/** One request to the server's control socket. Rejects with `ENOENT`/`ECONNREFUSED` when no server is running. */
export function controlRequest<T>(socketPath: string, method: string, requestPath: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        socketPath,
        path: requestPath,
        method,
        timeout: 15_000,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            // fall through with null
          }
          const status = res.statusCode ?? 0
          if (status >= 200 && status < 300) resolve(parsed as T)
          else reject(new ControlError(status, (parsed as { error?: string } | null)?.error ?? 'error'))
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Timed out waiting for the server')))
    req.end(payload)
  })
}
