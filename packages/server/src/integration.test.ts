import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { controlRequest } from './control-client.js'
import { FileSecretStore } from './secrets.js'
import { type RunningServer, startServer } from './server.js'
import { openStream, pairDevice, request } from './test-support/http.js'
import { type FakePushEndpoint, startFakePushEndpoint } from './test-support/push-endpoint.js'
import { type RealHost, startRealHost } from './test-support/real-host.js'

let host: RealHost
let server: RunningServer
let push: FakePushEndpoint
let cookie: string
let workDir: string

beforeAll(async () => {
  host = await startRealHost()
  push = await startFakePushEndpoint()
  workDir = fs.mkdtempSync(path.join('/tmp', 'bancada-s-work-'))
  server = await startServer({
    dataDir: host.dataDir,
    port: 0,
    connector: host.connector,
    vapidStore: new FileSecretStore(path.join(host.dataDir, 'vapid.key')),
    pushAgent: push.agent,
    vapidSubject: 'https://example.invalid/bancada',
  })
  const { code } = await controlRequest<{ code: string }>(server.controlSocketPath, 'POST', '/v1/pairing')
  cookie = (await pairDevice(server.port, code)).cookie
})

afterAll(async () => {
  await server?.close()
  await push?.close()
  await host?.stop()
  fs.rmSync(workDir, { recursive: true, force: true })
})

async function spawnShell(name: string): Promise<string> {
  const cwd = path.join(workDir, name)
  fs.mkdirSync(cwd)
  const session = await host.client.spawn({
    cwd,
    command: '/bin/sh',
    args: ['-c', "PS1='$ ' exec /bin/sh"],
    cols: 100,
    rows: 30,
  })
  return session.id
}

describe('server + real pty-host', () => {
  it('lists the host sessions', async () => {
    const id = await spawnShell('acme-web')
    const res = await request(server.port, 'GET', '/api/sessions', { cookie })
    expect(res.status).toBe(200)
    const sessions = res.json<{ sessions: { id: string; cwdName: string; cols: number; state: string }[] }>().sessions
    expect(sessions.find((s) => s.id === id)).toMatchObject({ cwdName: 'acme-web', cols: 100, state: 'running' })
  })

  it('attaches over WebSocket: snapshot with scrollback, live stream, input echoed back', async () => {
    const id = await spawnShell('echo-test')
    // History before the phone attaches must come back in the snapshot.
    host.client.write(id, 'echo history-line-one\r')
    await new Promise((r) => setTimeout(r, 500))

    const stream = await openStream(server.port, id, { cookie })
    const snapshot = await stream.waitForMessage('snapshot')
    expect(snapshot).toMatchObject({ cols: 100, rows: 30, state: 'running' })
    expect(String(snapshot.data)).toContain('history-line-one')

    const sent = Date.now()
    stream.ws.send(JSON.stringify({ type: 'input', data: 'echo from-the-phone\r' }))
    await stream.waitForBinary('from-the-phone')
    const echoMs = Date.now() - sent
    console.info(`[metric] WS input -> output echo: ${echoMs} ms`)
    expect(echoMs).toBeLessThan(2000)

    // No duplicates between snapshot and stream: the snapshot text is not replayed on the stream.
    expect(Buffer.concat(stream.binary).toString('utf8')).not.toContain('history-line-one')
    stream.ws.close()
  })

  it('serves two phones on the same session', async () => {
    const id = await spawnShell('two-viewers')
    const a = await openStream(server.port, id, { cookie })
    const b = await openStream(server.port, id, { cookie })
    await Promise.all([a.waitForMessage('snapshot'), b.waitForMessage('snapshot')])
    a.ws.send(JSON.stringify({ type: 'input', data: 'echo shared-output\r' }))
    await Promise.all([a.waitForBinary('shared-output'), b.waitForBinary('shared-output')])
    a.ws.close()
    b.ws.close()
  })

  it('never lets the phone resize the pty', async () => {
    const id = await spawnShell('no-resize')
    const stream = await openStream(server.port, id, { cookie })
    await stream.waitForMessage('snapshot')
    stream.ws.send(JSON.stringify({ type: 'resize', cols: 20, rows: 5 }))
    await new Promise((r) => setTimeout(r, 200))
    const info = (await host.client.list()).find((s) => s.id === id)
    expect(info).toMatchObject({ cols: 100, rows: 30 })
    stream.ws.close()
  })

  it('pushes on BEL (debounced per session), not on an OSC title, and the payload decrypts', async () => {
    // Subscribe the fake endpoint as this device's push service.
    const sub = await request(server.port, 'POST', '/api/push/subscribe', {
      cookie,
      body: { subscription: push.subscription },
    })
    expect(sub.status).toBe(200)

    const id = await spawnShell('bell-project')
    await new Promise((r) => setTimeout(r, 300))

    // An OSC title ends with BEL but must not notify.
    host.client.write(id, "printf '\\033]0;a title\\007'\r")
    await new Promise((r) => setTimeout(r, 600))
    expect(push.received).toHaveLength(0)

    const typedAt = Date.now()
    host.client.write(id, "printf '\\a'\r")
    const [first] = await push.waitFor(1)
    const delay = (first?.receivedAt ?? 0) - typedAt
    console.info(`[metric] BEL typed -> push received by the endpoint: ${delay} ms`)
    expect(first?.payload).toEqual({
      title: 'a title', // the session title set by the OSC above
      body: 'Sino do terminal',
      url: `/#/s/${id}`,
      tag: `bell-${id}`,
    })

    // A second bell inside the 30 s window is swallowed.
    host.client.write(id, "printf '\\a'\r")
    await new Promise((r) => setTimeout(r, 800))
    expect(push.received).toHaveLength(1)
  })

  it('notify through the control socket reaches the subscription with a session title', async () => {
    const before = push.received.length
    const result = await controlRequest<{ sent: number }>(server.controlSocketPath, 'POST', '/v1/notify', {
      text: 'build finished',
    })
    expect(result.sent).toBe(1)
    const received = await push.waitFor(before + 1)
    expect(received.at(-1)?.payload).toEqual({ title: 'Bancada', body: 'build finished', url: '/' })
  })

  it('reconnects its monitor (relaunching the host) after the pty-host dies', async () => {
    const status = (): Promise<{ hostConnected: boolean }> =>
      controlRequest(server.controlSocketPath, 'GET', '/v1/status')
    expect((await status()).hostConnected).toBe(true)
    process.kill(host.hostPid, 'SIGKILL')
    const deadline = Date.now() + 20_000
    let back = false
    while (Date.now() < deadline && !back) {
      await new Promise((r) => setTimeout(r, 200))
      back =
        (await status()).hostConnected &&
        !(await request(server.port, 'GET', '/api/sessions', { cookie })).text.includes('"state"')
    }
    expect(back).toBe(true)
    expect((await request(server.port, 'GET', '/api/sessions', { cookie })).status).toBe(200)
  })
})
