import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { SessionInfo } from '@bancada/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type PtyClient, PtyHostError } from './client.js'
import { FrameDecoder } from './frame.js'
import { connectToHost, ensureHost, launchHost, prepareRuntime } from './runtime.js'
import {
  buildBundle,
  cleanupHosts,
  electronBinary,
  OutputCollector,
  processAlive,
  startHost,
  type TestHost,
  waitUntil,
} from './test-support/host.js'
import { firstGap, Mirror, numericLines } from './test-support/mirror.js'

// Data dirs and cwds live under /tmp, never the long per-user $TMPDIR (macOS sun_path limit).
const tmp = '/tmp'
let host: TestHost

beforeAll(async () => {
  // The host's own environment is contaminated on purpose: sessions must not inherit these.
  host = await startHost({ env: { ORCA_TEST: '1', CLAUDECODE: '1', SHELL: '/bin/sh' } })
})

afterAll(async () => {
  host.client.close()
  await cleanupHosts()
})

function exited(client: PtyClient, id: string): Promise<{ exitCode: number | null; signal: number | null }> {
  return new Promise((resolve) => {
    const off = client.onEvent((event) => {
      if (event.type === 'event' && event.event === 'session-exited' && event.id === id) {
        off()
        resolve({ exitCode: event.exitCode, signal: event.signal })
      }
    })
  })
}

let counter = 0
function spec(overrides: Partial<Parameters<PtyClient['spawn']>[0]> = {}): Parameters<PtyClient['spawn']>[0] {
  return { id: `t${++counter}`, cwd: tmp, cols: 80, rows: 24, command: '/bin/sh', args: [], ...overrides }
}

describe('basics', () => {
  it('answers hello with protocol, version, pid and start time', async () => {
    const hello = await host.client.hello()
    expect(hello.protocol).toBe(1)
    expect(hello.pid).toBe(host.pid)
    expect(hello.hostVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(hello.startedAt).toBeLessThanOrEqual(Date.now())
  })

  it('binds a socket with mode 0600 and writes the pid file', () => {
    expect(fs.statSync(path.join(host.dataDir, 'pty-host.sock')).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(host.dataDir, 'pty-host.pid'), 'utf8').trim()).toBe(String(host.pid))
  })

  it('logs to <dataDir>/logs/pty-host.log', () => {
    const log = fs.readFileSync(path.join(host.dataDir, 'logs', 'pty-host.log'), 'utf8')
    expect(log).toContain('pty-host started')
  })

  it('refuses requests before hello and rejects a protocol mismatch without stopping the host', async () => {
    const socketPath = path.join(host.dataDir, 'pty-host.sock')
    const { createConnection } = await import('node:net')
    const { encodeControl, decodeControl } = await import('./frame.js')
    const talk = (message: object): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const socket = createConnection(socketPath)
        const decoder = new FrameDecoder()
        socket.on('data', (chunk) => {
          const [frame] = decoder.push(chunk)
          if (frame) {
            socket.destroy()
            resolve(decodeControl(frame))
          }
        })
        socket.on('error', reject)
        socket.on('connect', () => socket.write(encodeControl(message as never)))
      })
    expect(await talk({ type: 'list', reqId: 1 })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(await talk({ type: 'hello', reqId: 1, client: 'x', protocol: 99 })).toMatchObject({
      ok: false,
      error: { code: 'protocol_mismatch' },
    })
    expect((await host.client.hello()).pid).toBe(host.pid)
  })

  it('reports errors for unknown sessions, bad cwd and bad ids', async () => {
    await expect(host.client.attach('nope', () => {})).rejects.toMatchObject({ code: 'not_found' })
    await expect(host.client.resize('nope', 80, 24)).rejects.toMatchObject({ code: 'not_found' })
    await expect(host.client.spawn(spec({ cwd: '/definitely/not/here' }))).rejects.toMatchObject({
      code: 'spawn_failed',
    })
    await expect(host.client.spawn(spec({ id: 'bad id!' }))).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(host.client.spawn(spec({ cols: 0 }))).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(host.client.spawn(spec({ command: '/no/such/binary' }))).rejects.toMatchObject({
      code: 'spawn_failed',
    })
    expect((await host.client.list()).some((s) => s.command === '/no/such/binary')).toBe(false)
    const first = await host.client.spawn(spec())
    await expect(host.client.spawn(spec({ id: first.id }))).rejects.toMatchObject({ code: 'invalid_request' })
    await host.client.dispose(first.id)
  })
})

describe('spawn, list, write', () => {
  it('echoes typed input and keeps the exited session until dispose', async () => {
    const events: string[] = []
    const off = host.client.onEvent((event) => events.push(event.event))
    const info = await host.client.spawn(spec({ meta: { product: 'bancada' } }))
    expect(info).toMatchObject({ state: 'running', cols: 80, rows: 24, cwd: tmp, meta: { product: 'bancada' } })
    expect(info.pid).toBeGreaterThan(0)

    const out = new OutputCollector()
    await host.client.attach(info.id, out.onData)
    host.client.write(info.id, 'echo round-trip-$((6*7))\r')
    await out.waitFor('round-trip-42')

    const listed = (await host.client.list()).find((s: SessionInfo) => s.id === info.id)
    expect(listed).toMatchObject({ id: info.id, state: 'running' })
    expect(listed?.lastOutputAt).toBeGreaterThan(0)

    const done = exited(host.client, info.id)
    host.client.write(info.id, 'exit 3\r')
    expect(await done).toEqual({ exitCode: 3, signal: null })

    const after = (await host.client.list()).find((s) => s.id === info.id)
    expect(after).toMatchObject({ state: 'exited', exitCode: 3, pid: null })
    const snapshot = await host.client.snapshot(info.id)
    const mirror = new Mirror(snapshot.cols, snapshot.rows, 10_000)
    await mirror.write(snapshot.data)
    expect(mirror.lines().join('\n')).toContain('round-trip-42')

    await host.client.dispose(info.id)
    expect((await host.client.list()).some((s) => s.id === info.id)).toBe(false)
    off()
    expect(events).toEqual(expect.arrayContaining(['session-added', 'session-exited', 'session-removed']))
  })

  it('defaults to the login shell with -l', async () => {
    const info = await host.client.spawn({ cwd: tmp, cols: 80, rows: 24 })
    expect(info).toMatchObject({ command: '/bin/sh', args: ['-l'] })
    await host.client.dispose(info.id)
  })

  it('kills a session with a signal', async () => {
    const info = await host.client.spawn(spec())
    const done = exited(host.client, info.id)
    await host.client.kill(info.id, 'SIGKILL')
    expect(await done).toMatchObject({ signal: 9 })
    await host.client.dispose(info.id)
  })

  it('broadcasts title changes from the terminal', async () => {
    const info = await host.client.spawn(spec())
    const title = new Promise<string>((resolve) => {
      const off = host.client.onEvent((event) => {
        if (event.type === 'event' && event.event === 'session-title' && event.id === info.id) {
          off()
          resolve(event.title)
        }
      })
    })
    host.client.write(info.id, "printf '\\033]0;my topic\\007'\r")
    expect(await title).toBe('my topic')
    expect((await host.client.list()).find((s) => s.id === info.id)?.title).toBe('my topic')
    await host.client.dispose(info.id)
  })

  it('reflects resize inside the session (last one wins)', async () => {
    const info = await host.client.spawn(spec())
    const out = new OutputCollector()
    await host.client.attach(info.id, out.onData)
    host.client.write(info.id, 'stty size\r')
    await out.waitFor(/\r\n24 80\r\n/)
    await host.client.resize(info.id, 120, 40)
    host.client.write(info.id, 'stty size\r')
    await out.waitFor(/\r\n40 120\r\n/)
    await host.client.resize(info.id, 100, 30)
    await host.client.resize(info.id, 90, 31)
    host.client.write(info.id, 'stty size\r')
    await out.waitFor(/\r\n31 90\r\n/)
    expect((await host.client.snapshot(info.id)).cols).toBe(90)
    await host.client.dispose(info.id)
  })
})

describe('environment hygiene', () => {
  it('strips terminal-app and agent variables and sets the Bancada ones', async () => {
    const envFile = path.join(host.dataDir, 'session-env.txt')
    const info = await host.client.spawn(
      spec({ args: ['-c', 'env > "$ENV_OUT"'], env: { ENV_OUT: envFile, ORCA_EXPLICIT: 'kept-because-explicit' } }),
    )
    await waitUntil(() => fs.existsSync(envFile) && fs.readFileSync(envFile, 'utf8').includes('BANCADA_SESSION_ID'))
    const env = Object.fromEntries(
      fs
        .readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
    // Contaminated on purpose in the host's environment (see beforeAll), present here only if hygiene failed.
    expect(env.ORCA_TEST).toBeUndefined()
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.BANCADA_DATA_DIR).toBeUndefined()
    expect(env.BANCADA_APP_VERSION).toBeUndefined()
    expect(
      Object.keys(env).filter((k) => k.startsWith('CLAUDE_CODE_') || (k.startsWith('ORCA_') && k !== 'ORCA_EXPLICIT')),
    ).toEqual([])
    expect(env).toMatchObject({
      TERM_PROGRAM: 'Bancada',
      TERM_PROGRAM_VERSION: '0.0.0-test',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      BANCADA_SESSION_ID: info.id,
      BANCADA_PROFILE: 'default',
      ORCA_EXPLICIT: 'kept-because-explicit',
    })
    await host.client.dispose(info.id)
  })
})

const LINES = 400_000

/** `stty -echo`, print READY, wait for a line, then count 1..LINES as fast as awk can. */
function counterSpec(lines = LINES): Parameters<PtyClient['spawn']>[0] {
  const script = `stty -echo; echo READY; read go; exec awk 'BEGIN { for (i = 1; i <= ${lines}; i++) print i }'`
  return spec({ args: ['-c', script] })
}

describe('attach cutoff', () => {
  for (let run = 1; run <= 6; run++) {
    it(`attaching mid-stream loses and repeats nothing (run ${run})`, async () => {
      const info = await host.client.spawn(counterSpec())
      const watcher = new OutputCollector()
      await host.client.attach(info.id, watcher.onData)
      await watcher.waitFor('READY')
      const done = exited(host.client, info.id)
      host.client.write(info.id, '\r')
      await waitUntil(() => watcher.bytes > 200_000, 20_000, 'the counter to be mid-stream')

      // The late client: a second connection, as the phone would be.
      const late = await host.connect()
      const reconstructed = new Mirror(80, 24, 1_000_000) // deep enough to see every line
      const same = new Mirror(80, 24, 10_000) // the host's own configuration
      const streamed: Uint8Array[] = []
      let streamedBytes = 0
      const snapshot = await late.attach(info.id, (bytes) => {
        streamed.push(bytes)
        streamedBytes += bytes.byteLength
      })
      await reconstructed.write(snapshot.data)
      await same.write(snapshot.data)
      const lastInSnapshot = numericLines(reconstructed.lines()).at(-1) ?? 0
      expect(lastInSnapshot, 'the snapshot was taken mid-stream').toBeGreaterThan(0)
      expect(lastInSnapshot).toBeLessThan(LINES)

      await done
      await waitUntil(() => watcher.text.includes(`\n${LINES}\r\n`), 20_000, 'the last number')
      // Everything the host sent after the exit event has arrived once the host snapshot's bytes are in.
      const hostSnapshot = await late.snapshot(info.id)
      await waitUntil(() => streamedBytes > 0 && Buffer.concat(streamed).toString().includes(`${LINES}\r\n`), 20_000)
      for (const bytes of streamed) {
        await reconstructed.write(bytes)
        await same.write(bytes)
      }

      const numbers = numericLines(reconstructed.lines())
      expect(firstGap(numbers), `gap or duplicate near ${numbers[firstGap(numbers)]}`).toBe(-1)
      expect(numbers.at(-1)).toBe(LINES)
      expect(streamedBytes).toBeGreaterThan(0)

      const hostMirror = new Mirror(hostSnapshot.cols, hostSnapshot.rows, 10_000)
      await hostMirror.write(hostSnapshot.data)
      expect(same.lines()).toEqual(hostMirror.lines())

      for (const m of [reconstructed, same, hostMirror]) m.dispose()
      late.close()
      await host.client.dispose(info.id)
    })
  }

  it('delivers all output to two clients attached at once', async () => {
    const lines = 60_000
    const info = await host.client.spawn(counterSpec(lines))
    const other = await host.connect()
    const a = new OutputCollector()
    const b = new OutputCollector()
    await host.client.attach(info.id, a.onData)
    await other.attach(info.id, b.onData)
    await a.waitFor('READY')
    await b.waitFor('READY')
    host.client.write(info.id, '\r')
    await a.waitFor(`\n${lines}\r\n`, 20_000)
    await b.waitFor(`\n${lines}\r\n`, 20_000)
    const numbersOf = (c: OutputCollector): number[] =>
      c.text
        .replaceAll('\r', '')
        .split('\n')
        .filter((l) => /^\d+$/.test(l))
        .map(Number)
    expect(numbersOf(a)).toHaveLength(lines)
    expect(firstGap(numbersOf(a))).toBe(-1)
    expect(b.text).toBe(a.text)

    // Any client can write: input from the second connection reaches the session.
    const echo = new OutputCollector()
    const shell = await host.client.spawn(spec())
    await other.attach(shell.id, echo.onData)
    other.write(shell.id, 'echo from-the-other-client\r')
    await echo.waitFor('from-the-other-client')
    other.close()
    await host.client.dispose(info.id)
    await host.client.dispose(shell.id)
  })

  it('keeps a session and its output when an attached client process is SIGKILLed', async () => {
    const childBundle = path.join(host.dataDir, 'child', 'attach-child.cjs')
    buildBundle(childBundle, 'src/test-support/attach-child.ts', '')
    const info = await host.client.spawn(
      spec({ args: ['-c', 'i=0; while :; do echo tick $i; i=$((i+1)); sleep 0.05; done'] }),
    )
    const watcher = new OutputCollector()
    await host.client.attach(info.id, watcher.onData)

    const socketPath = path.join(host.dataDir, 'pty-host.sock')
    const child: ChildProcess = spawn(process.execPath, [childBundle, socketPath, info.id], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', (d: Buffer) => d.toString().includes('attached') && resolve())
      child.once('exit', () => reject(new Error('child exited before attaching')))
    })
    const lastTick = (): number => Math.max(...[...watcher.text.matchAll(/tick (\d+)/g)].map((m) => Number(m[1])))
    const tickAtKill = lastTick()
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))

    await waitUntil(() => lastTick() >= tickAtKill + 6, 10_000, 'output produced after the kill')
    expect((await host.client.hello()).pid).toBe(host.pid)
    expect((await host.client.list()).find((s) => s.id === info.id)?.state).toBe('running')

    const fresh = await host.connect()
    const mirror = new Mirror(80, 24, 10_000)
    const snapshot = await fresh.attach(info.id, () => {})
    await mirror.write(snapshot.data)
    const ticks = mirror.lines().flatMap((l) => (l.startsWith('tick ') ? [Number(l.slice(5))] : []))
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(tickAtKill + 6)
    expect(firstGap(ticks.slice(-20))).toBe(-1)
    mirror.dispose()
    fresh.close()
    await host.client.dispose(info.id)
  })
})

describe('host lifecycle', () => {
  it('runs from the runtime copy: deleting the original bundle changes nothing', async () => {
    const own = await startHost()
    const runtimeDirs = fs.readdirSync(path.join(own.dataDir, 'runtime'))
    expect(runtimeDirs).toHaveLength(1)
    expect(runtimeDirs[0]).toMatch(/^pty-host-\d+\.\d+\.\d+-[0-9a-f]{10}$/)
    expect(
      fs.existsSync(path.join(own.dataDir, 'runtime', runtimeDirs[0] as string, 'node_modules/node-pty/prebuilds')),
    ).toBe(true)
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(own.pid)], { encoding: 'utf8' })
    expect(command).toContain(`runtime/${runtimeDirs[0]}/pty-host.cjs`)

    fs.rmSync(path.dirname(own.bundlePath), { recursive: true, force: true })
    expect(fs.existsSync(own.bundlePath)).toBe(false)

    const info = await own.client.spawn(spec())
    const out = new OutputCollector()
    await own.client.attach(info.id, out.onData)
    own.client.write(info.id, 'echo still-alive\r')
    await out.waitFor('still-alive')

    // A new caller finds the running host without needing the bundle at all.
    const again = await ensureHost({ dataDir: own.dataDir, bundlePath: own.bundlePath, electronPath: electronBinary() })
    expect(again.host?.pid).toBe(own.pid)
    again.close()
    own.client.close()
  })

  it('prepareRuntime is idempotent and a changed bundle gets its own dir', async () => {
    const dataDir = fs.mkdtempSync(path.join(tmp, 'bancada-t-'))
    try {
      const bundle = path.join(dataDir, 'b.cjs')
      fs.writeFileSync(bundle, '// one')
      const first = prepareRuntime({ dataDir, bundlePath: bundle })
      expect(prepareRuntime({ dataDir, bundlePath: bundle }).dir).toBe(first.dir)
      fs.writeFileSync(bundle, '// two')
      const second = prepareRuntime({ dataDir, bundlePath: bundle })
      expect(second.dir).not.toBe(first.dir)
      expect(fs.readFileSync(first.entry, 'utf8')).toBe('// one')
      const helper = path.join(
        second.dir,
        'node_modules/node-pty/prebuilds',
        `${process.platform}-${process.arch}`,
        'spawn-helper',
      )
      expect(fs.statSync(helper).mode & 0o111).not.toBe(0)
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('refuses a second host for the same data dir with a clear error and leaves the first alone', async () => {
    const own = await startHost()
    const runtime = prepareRuntime({ dataDir: own.dataDir, bundlePath: own.bundlePath })
    const second = launchHost({ dataDir: own.dataDir, entry: runtime.entry, electronPath: electronBinary() })
    const result = await second.exit
    expect(result.code).toBe(3)
    expect(fs.readFileSync(path.join(own.dataDir, 'logs', 'pty-host.log'), 'utf8')).toContain(
      'another pty-host owns this data dir',
    )
    expect(processAlive(own.pid)).toBe(true)
    expect((await own.client.hello()).pid).toBe(own.pid)
    own.client.close()
  })

  it('replaces a stale pid file and socket left by a dead host', async () => {
    const own = await startHost()
    process.kill(own.pid, 'SIGKILL')
    await waitUntil(() => !processAlive(own.pid), 5000, 'host to die')
    expect(fs.existsSync(path.join(own.dataDir, 'pty-host.pid'))).toBe(true)
    own.client.close()
    const revived = await ensureHost({
      dataDir: own.dataDir,
      bundlePath: own.bundlePath,
      electronPath: electronBinary(),
    })
    expect(revived.host?.pid).not.toBe(own.pid)
    expect(processAlive(revived.host?.pid as number)).toBe(true)
    revived.close()
    // cleanupHosts only knows the first pid; this one is stopped here.
    process.kill(revived.host?.pid as number, 'SIGKILL')
  })

  it('shares one launch between concurrent ensureHost calls', async () => {
    const dataDir = fs.mkdtempSync(path.join(tmp, 'bancada-t-'))
    const bundlePath = path.join(dataDir, 'bundle', 'pty-host.cjs')
    buildBundle(bundlePath)
    const options = { dataDir, bundlePath, electronPath: electronBinary() }
    const clients = await Promise.all([ensureHost(options), ensureHost(options), ensureHost(options)])
    const pids = new Set(clients.map((c) => c.host?.pid))
    expect(pids.size).toBe(1)
    const pid = [...pids][0] as number
    for (const c of clients) c.close()
    process.kill(pid, 'SIGKILL')
    await waitUntil(() => !processAlive(pid), 5000)
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('surfaces connection close and rejects pending work', async () => {
    const own = await startHost()
    const client = await own.connect()
    const closed = new Promise<Error | undefined>((resolve) => client.onClose(resolve))
    process.kill(own.pid, 'SIGKILL')
    await closed
    expect(client.closed).toBe(true)
    await expect(client.list()).rejects.toBeInstanceOf(PtyHostError)
    own.client.close()
  })

  it('refuses shutdown while sessions are alive and stops with force', async () => {
    const own = await startHost()
    const info = await own.client.spawn(spec())
    await expect(own.client.shutdown()).rejects.toMatchObject({ code: 'sessions_alive' })
    expect((await own.client.hello()).pid).toBe(own.pid)

    // An exited session does not count as alive.
    const done = exited(own.client, info.id)
    await own.client.kill(info.id, 'SIGKILL')
    await done
    const stillThere = await own.connect()
    const second = await own.client.spawn(spec())
    await expect(stillThere.shutdown()).rejects.toMatchObject({ code: 'sessions_alive' })
    await own.client.shutdown(true)
    await waitUntil(() => !processAlive(own.pid), 10_000, 'the host to exit')
    expect(fs.existsSync(path.join(own.dataDir, 'pty-host.sock'))).toBe(false)
    expect(fs.existsSync(path.join(own.dataDir, 'pty-host.pid'))).toBe(false)
    await expect(connectToHost(own.dataDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(second.pid).toBeGreaterThan(0)
    expect(processAlive(second.pid as number)).toBe(false)
  })

  it('force shutdown also ends a session that ignores SIGHUP', async () => {
    const own = await startHost()
    const stubborn = await own.client.spawn(spec({ args: ['-c', 'trap "" HUP; while :; do sleep 1; done'] }))
    await new Promise((resolve) => setTimeout(resolve, 300)) // let the shell install its trap
    const pid = stubborn.pid as number
    expect(processAlive(pid)).toBe(true)
    await own.client.shutdown(true)
    await waitUntil(() => !processAlive(own.pid), 10_000, 'the host to exit')
    expect(processAlive(pid)).toBe(false)
  })

  it('shuts down without force when no session is running', async () => {
    const own = await startHost()
    await own.client.shutdown()
    await waitUntil(() => !processAlive(own.pid), 10_000, 'the host to exit')
  })

  it('uses the /tmp fallback socket when the data dir path is too long', async () => {
    const long = fs.mkdtempSync(path.join(tmp, `bancada-t-${'x'.repeat(80)}-`))
    try {
      const own = await startHost({ dataDir: long })
      const { resolveSocketPath } = await import('@bancada/protocol/paths')
      const socket = resolveSocketPath(long, process.getuid?.() ?? 0)
      expect(socket.startsWith(`/tmp/bancada-${process.getuid?.()}/`)).toBe(true)
      expect(fs.statSync(socket).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(socket)).mode & 0o777).toBe(0o700)
      expect((await own.client.hello()).pid).toBe(own.pid)
      await own.client.shutdown()
      await waitUntil(() => !processAlive(own.pid), 10_000)
      expect(fs.existsSync(socket)).toBe(false)
      own.client.close()
      try {
        fs.rmdirSync(path.dirname(socket)) // only succeeds when empty, so a live app's sockets are safe
      } catch {
        // in use by another profile
      }
    } finally {
      fs.rmSync(long, { recursive: true, force: true })
    }
  })
})
