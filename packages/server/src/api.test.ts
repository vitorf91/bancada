import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { controlRequest } from './control-client.js'
import { COOKIE_NAME } from './http-util.js'
import { FileSecretStore } from './secrets.js'
import { type RunningServer, startServer } from './server.js'
import { FakeHost } from './test-support/fake-host.js'
import { openStream, pairDevice, rawStatusLine, rawUpgrade, request } from './test-support/http.js'

let dir: string
let pwaDir: string
let host: FakeHost
let server: RunningServer
let clock: number

async function boot(options: { maxFailures?: number } = {}): Promise<void> {
  server = await startServer({
    dataDir: dir,
    port: 0,
    connector: host.connector,
    vapidStore: new FileSecretStore(path.join(dir, 'vapid.key')),
    pwaDir,
    now: () => clock,
    pairing: options,
  })
}

async function newCode(): Promise<string> {
  return (await controlRequest<{ code: string }>(server.controlSocketPath, 'POST', '/v1/pairing')).code
}

async function paired(): Promise<{ cookie: string; deviceId: string }> {
  return pairDevice(server.port, await newCode())
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join('/tmp', 'bancada-t-api-'))
  pwaDir = path.join(dir, 'pwa')
  fs.mkdirSync(pwaDir)
  fs.writeFileSync(path.join(pwaDir, 'index.html'), '<!doctype html><title>Bancada</title>')
  clock = Date.now()
  host = new FakeHost()
  host.addSession({ id: 's1', cwd: '/tmp/acme-web', title: 'Fix login' })
  await boot()
})

afterEach(async () => {
  await server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('listeners', () => {
  it('binds the public API to 127.0.0.1 only', () => {
    const address = server.api.server.address()
    expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' })
  })

  it('puts the control socket in the data dir with mode 0600, and the control API is not on the TCP port', async () => {
    expect(server.controlSocketPath).toBe(path.join(dir, 'server.sock'))
    expect(fs.statSync(server.controlSocketPath).mode & 0o777).toBe(0o600)
    const res = await request(server.port, 'POST', '/v1/pairing')
    expect(res.status).toBe(404)
    expect(res.text).not.toMatch(/code/)
  })

  it('refuses a second server on the same data dir and leaves the first one alone', async () => {
    await expect(
      startServer({
        dataDir: dir,
        port: 0,
        connector: host.connector,
        vapidStore: new FileSecretStore(path.join(dir, 'vapid.key')),
      }),
    ).rejects.toThrow(/already running/)
    expect(fs.existsSync(server.controlSocketPath)).toBe(true)
    await expect(controlRequest(server.controlSocketPath, 'GET', '/v1/status')).resolves.toMatchObject({
      hostConnected: true,
    })
  })

  it('replaces a socket file left behind by a dead server', async () => {
    await server.close()
    fs.writeFileSync(path.join(dir, 'server.sock'), '')
    await boot()
    await expect(controlRequest(server.controlSocketPath, 'GET', '/v1/status')).resolves.toBeTruthy()
  })
})

describe('authentication', () => {
  it('requires the cookie on every API route, and localhost is not a trust signal', async () => {
    for (const [method, url] of [
      ['GET', '/api/me'],
      ['GET', '/api/sessions'],
      ['GET', '/api/push/key'],
      ['POST', '/api/push/subscribe'],
      ['POST', '/api/logout'],
      ['GET', '/api/does-not-exist'],
      ['DELETE', '/api/sessions/s1'],
    ] as const) {
      const res = await request(server.port, method, url, {
        headers: { host: 'localhost' },
        origin: 'http://localhost',
      })
      expect(res.status, `${method} ${url}`).toBe(401)
    }
    const forwarded = await request(server.port, 'GET', '/api/sessions', {
      headers: { host: 'localhost', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost' },
    })
    expect(forwarded.status).toBe(401)
  })

  it('serves the PWA shell without a cookie (it holds no data) with a restrictive CSP', async () => {
    const res = await request(server.port, 'GET', '/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('Bancada')
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
    expect((await request(server.port, 'GET', '/../../etc/passwd')).status).toBe(404)
    expect((await request(server.port, 'GET', '/%2e%2e/%2e%2e/etc/passwd')).status).toBe(404)
  })

  it('pairs with a one-time code and sets an HttpOnly, Secure, SameSite=Strict, host-only cookie', async () => {
    const res = await request(server.port, 'POST', '/api/pair', { body: { code: await newCode(), name: 'iPhone' } })
    expect(res.status).toBe(200)
    const cookie = res.headers['set-cookie']?.[0] ?? ''
    expect(cookie).toMatch(new RegExp(`^${COOKIE_NAME}=[A-Za-z0-9_-]{43};`))
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toContain('Domain')
    expect(cookie.startsWith('__Host-')).toBe(true)
    const token = cookie.split(';')[0]?.split('=')[1] as string
    expect(res.text).not.toContain(token) // the body never carries the token

    const file = fs.readFileSync(path.join(dir, 'devices.json'), 'utf8')
    expect(file).not.toContain(token)
    expect(fs.statSync(path.join(dir, 'devices.json')).mode & 0o777).toBe(0o600)

    const me = await request(server.port, 'GET', '/api/me', { cookie: `${COOKIE_NAME}=${token}` })
    expect(me.status).toBe(200)
    expect(me.json<{ device: { name: string } }>().device.name).toBe('iPhone')
  })

  it('rejects a bad code, a replayed code and an expired code', async () => {
    const code = await newCode()
    expect((await request(server.port, 'POST', '/api/pair', { body: { code: 'AAAA-BBBB' } })).status).toBe(401)
    expect((await request(server.port, 'POST', '/api/pair', { body: { code } })).status).toBe(200)
    expect((await request(server.port, 'POST', '/api/pair', { body: { code } })).status).toBe(401)
    const late = await newCode()
    clock += 5 * 60_000 + 1
    expect((await request(server.port, 'POST', '/api/pair', { body: { code: late } })).status).toBe(401)
  })

  it('rate limits pairing attempts (429 with Retry-After), even for a valid code', async () => {
    const code = await newCode()
    for (let i = 0; i < 5; i++) {
      expect((await request(server.port, 'POST', '/api/pair', { body: { code: `WRONG00${i}` } })).status).toBe(401)
    }
    const blocked = await request(server.port, 'POST', '/api/pair', { body: { code } })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('refuses cross-origin state changes and requests with no Origin', async () => {
    const { cookie } = await paired()
    const code = await newCode()
    expect(
      (await request(server.port, 'POST', '/api/pair', { body: { code }, origin: 'https://evil.example' })).status,
    ).toBe(403)
    expect((await request(server.port, 'POST', '/api/pair', { body: { code }, origin: null })).status).toBe(403)
    expect(
      (await request(server.port, 'POST', '/api/pair', { body: { code }, headers: { 'sec-fetch-site': 'cross-site' } }))
        .status,
    ).toBe(403)
    expect(
      (await request(server.port, 'POST', '/api/push/unsubscribe', { cookie, origin: 'https://evil.example' })).status,
    ).toBe(403)
    // behind tailscale serve the Origin is the tailnet name, carried in X-Forwarded-Host
    const ok = await request(server.port, 'POST', '/api/pair', {
      body: { code },
      origin: 'https://mac.tailnet.ts.net',
      headers: { 'x-forwarded-host': 'mac.tailnet.ts.net' },
    })
    expect(ok.status).toBe(200)
    // the cookie names are host-only; a WebSocket from another origin is refused too
    await expect(openStream(server.port, 's1', { cookie, origin: 'https://evil.example' })).rejects.toMatchObject({
      status: 403,
    })
  })

  it('logout revokes the calling device', async () => {
    const { cookie } = await paired()
    expect((await request(server.port, 'POST', '/api/logout', { cookie })).status).toBe(200)
    expect((await request(server.port, 'GET', '/api/me', { cookie })).status).toBe(401)
  })
})

describe('sessions API', () => {
  it('lists sessions with title, cwd basename and last activity, and nothing sensitive', async () => {
    const { cookie } = await paired()
    const first = host.sessions[0]
    if (first) first.lastOutputAt = 1_700_000_000_000
    const res = await request(server.port, 'GET', '/api/sessions', { cookie })
    expect(res.status).toBe(200)
    const { sessions } = res.json<{ sessions: Record<string, unknown>[] }>()
    expect(sessions).toEqual([
      {
        id: 's1',
        title: 'Fix login',
        cwdName: 'acme-web',
        state: 'running',
        cols: 80,
        rows: 24,
        createdAt: expect.any(Number),
        lastOutputAt: 1_700_000_000_000,
        exitCode: null,
      },
    ])
    expect(res.text).not.toContain('/tmp/acme-web')
    expect(res.text).not.toContain('/bin/sh')
  })

  it('answers 503 when the pty-host is down', async () => {
    const { cookie } = await paired()
    for (const client of host.clients) client.close()
    host.failConnect = true
    const res = await request(server.port, 'GET', '/api/sessions', { cookie })
    expect(res.status).toBe(503)
  })

  it('exposes no kill, dispose, spawn or resize route', async () => {
    const { cookie } = await paired()
    for (const [method, url] of [
      ['DELETE', '/api/sessions/s1'],
      ['POST', '/api/sessions/s1/kill'],
      ['POST', '/api/sessions/s1/dispose'],
      ['POST', '/api/sessions/s1/resize'],
      ['POST', '/api/sessions'],
      ['PUT', '/api/sessions/s1'],
    ] as const) {
      const res = await request(server.port, method, url, { cookie, body: {} })
      expect(res.status, `${method} ${url}`).toBe(404)
    }
    expect(host.forbidden).toEqual([])
  })
})

describe('malformed request targets', () => {
  it('answers 400 to a WebSocket upgrade it cannot parse, before and after authentication, and keeps serving', async () => {
    const { cookie } = await paired()
    for (const [target, withCookie] of [
      ['//', false],
      ['//', true],
      ['/api/sessions/%E0%A4%A/stream', false],
      ['/api/sessions/%E0%A4%A/stream', true],
    ] as const) {
      const line = await rawStatusLine(server.port, rawUpgrade(server.port, target, withCookie ? cookie : undefined))
      // Without a cookie the percent-escape is never decoded, so the answer is 401; with one it must be 400.
      const expected = target === '//' || withCookie ? 'HTTP/1.1 400 Bad Request' : 'HTTP/1.1 401 Unauthorized'
      expect(line, `${target} cookie=${withCookie}`).toBe(expected)
    }
    expect((await request(server.port, 'GET', '/')).status).toBe(200)
  })

  it('answers 400 to an HTTP request target it cannot parse, and keeps serving', async () => {
    for (const target of ['//', '//api/me', '*']) {
      const line = await rawStatusLine(server.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
      expect(line, target).toBe('HTTP/1.1 400 Bad Request')
    }
    expect((await request(server.port, 'GET', '/%E0%A4%A')).status).toBe(404)
    expect((await request(server.port, 'GET', '/')).status).toBe(200)
  })
})

describe('session stream (WebSocket)', () => {
  it('refuses the upgrade without a valid cookie', async () => {
    await expect(openStream(server.port, 's1')).rejects.toMatchObject({ status: 401 })
    await expect(openStream(server.port, 's1', { cookie: `${COOKIE_NAME}=${'a'.repeat(43)}` })).rejects.toMatchObject({
      status: 401,
    })
  })

  it('sends a snapshot (scrollback 500), then live output, and relays input as typed', async () => {
    const { cookie } = await paired()
    const stream = await openStream(server.port, 's1', { cookie })
    const snapshot = await stream.waitForMessage('snapshot')
    expect(snapshot).toMatchObject({ cols: 80, rows: 24, data: 'screen of s1', title: 'Fix login', state: 'running' })
    host.output('s1', 'live line\r\n')
    await stream.waitForBinary('live line')

    stream.ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }))
    await stream.waitForBinary('ls\r')
    const viewer = host.liveClients().find((c) => c.writes.length > 0)
    expect(viewer?.writes).toEqual([{ id: 's1', data: 'ls\r' }])
    stream.ws.close()
  })

  it('has no resize, kill or dispose message, and bounds the input size', async () => {
    const { cookie } = await paired()
    const stream = await openStream(server.port, 's1', { cookie })
    await stream.waitForMessage('snapshot')
    for (const message of [
      { type: 'resize', cols: 10, rows: 5 },
      { type: 'kill' },
      { type: 'dispose' },
      { type: 'input', data: 'x'.repeat(20_000) },
      { type: 'input', data: 42 },
    ]) {
      stream.ws.send(JSON.stringify(message))
    }
    stream.ws.send(Buffer.from([1, 2, 3]))
    stream.ws.send('not json')
    await new Promise((r) => setTimeout(r, 100))
    const errors = stream.messages
      .filter((m) => (m as { type: string }).type === 'error')
      .map((m) => (m as { code: string }).code)
    expect(errors).toEqual([
      'unsupported',
      'unsupported',
      'unsupported',
      'invalid_input',
      'invalid_input',
      'unsupported',
      'invalid_json',
    ])
    expect(host.forbidden).toEqual([])
    expect(host.liveClients().flatMap((c) => c.writes)).toEqual([])
    stream.ws.close()
  })

  it('reports an unknown session and a session that exited', async () => {
    const { cookie } = await paired()
    const missing = await openStream(server.port, 'nope', { cookie })
    expect(await missing.waitForMessage('error')).toMatchObject({ code: 'not_found' })
    expect((await missing.closed).code).toBe(4404)

    host.addSession({ id: 's2', cwd: '/tmp/api', state: 'exited', exitCode: 0 })
    const exited = await openStream(server.port, 's2', { cookie })
    expect(await exited.waitForMessage('snapshot')).toMatchObject({ state: 'exited' })
    exited.ws.send(JSON.stringify({ type: 'input', data: 'x' }))
    await new Promise((r) => setTimeout(r, 50))
    expect(exited.messages.some((m) => (m as { code?: string }).code === 'session_exited')).toBe(true)
    exited.ws.close()
  })

  it('closes the socket and its host connection when the pty-host goes away', async () => {
    const { cookie } = await paired()
    const stream = await openStream(server.port, 's1', { cookie })
    await stream.waitForMessage('snapshot')
    const viewer = host
      .liveClients()
      .find((c) => c.attached.has('s1') && c.writes.length === 0 && c !== host.clients[0])
    viewer?.close()
    expect((await stream.closed).code).toBe(1011)
  })
})

describe('revocation', () => {
  it('closes every open socket of the device at once and frees its host connections', async () => {
    const a = await paired()
    const b = await paired()
    const first = await openStream(server.port, 's1', { cookie: a.cookie })
    const second = await openStream(server.port, 's1', { cookie: a.cookie })
    const other = await openStream(server.port, 's1', { cookie: b.cookie })
    await Promise.all([first, second, other].map((s) => s.waitForMessage('snapshot')))
    const before = host.liveClients().length

    const startedAt = Date.now()
    await controlRequest(server.controlSocketPath, 'DELETE', `/v1/devices/${a.deviceId.slice(0, 8)}`)
    const [c1, c2] = await Promise.all([first.closed, second.closed])
    expect(c1.code).toBe(4401)
    expect(c2.code).toBe(4401)
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(host.liveClients().length).toBe(before - 2)

    // the other device is untouched; the revoked cookie is dead for HTTP and for new sockets
    expect(other.ws.readyState).toBe(other.ws.OPEN)
    expect((await request(server.port, 'GET', '/api/sessions', { cookie: a.cookie })).status).toBe(401)
    await expect(openStream(server.port, 's1', { cookie: a.cookie })).rejects.toMatchObject({ status: 401 })
    expect((await request(server.port, 'GET', '/api/sessions', { cookie: b.cookie })).status).toBe(200)
    other.ws.close()
  })

  it('input from a socket that was being revoked never reaches the pty', async () => {
    const { cookie, deviceId } = await paired()
    const stream = await openStream(server.port, 's1', { cookie })
    await stream.waitForMessage('snapshot')
    server.devices.revoke(deviceId)
    stream.ws.send(JSON.stringify({ type: 'input', data: 'rm -rf\r' }))
    await stream.closed
    expect(host.liveClients().flatMap((c) => c.writes)).toEqual([])
  })

  it('also drops the device push subscription and survives a server restart', async () => {
    const { cookie, deviceId } = await paired()
    const sub = { endpoint: 'https://push.example/x', keys: { p256dh: 'BPk', auth: 'abc' } }
    expect(
      (await request(server.port, 'POST', '/api/push/subscribe', { cookie, body: { subscription: sub } })).status,
    ).toBe(200)
    expect(server.subscriptions.hasDevice(deviceId)).toBe(true)
    expect(fs.statSync(path.join(dir, 'push.json')).mode & 0o777).toBe(0o600)
    await server.close()
    await boot()
    expect((await request(server.port, 'GET', '/api/me', { cookie })).status).toBe(200) // devices.json persisted
    server.devices.revoke(deviceId)
    expect(server.subscriptions.hasDevice(deviceId)).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'push.json'), 'utf8')).subscriptions).toEqual([])
  })

  it('rejects subscriptions that are not https endpoints', async () => {
    const { cookie } = await paired()
    const res = await request(server.port, 'POST', '/api/push/subscribe', {
      cookie,
      body: { subscription: { endpoint: 'http://push.example/x', keys: { p256dh: 'a', auth: 'b' } } },
    })
    expect(res.status).toBe(400)
  })
})
