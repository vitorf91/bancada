// Headless part of proof F0-b: the host keeps terminals alive when the client goes away and the bundle is rebuilt.
//   pnpm --filter @bancada/pty-host proof:survive            (prints the tables)
//   ... -- --write ../../docs/proofs/F0-b-headless.md        (also writes the result document)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveHostLogPath } from '@bancada/protocol/paths'
import type { PtyClient } from '../src/client.js'
import { connectToHost, ensureHost, prepareRuntime } from '../src/runtime.js'
import { Mirror } from '../src/test-support/mirror.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = createRequire(import.meta.url)('electron') as string
const { values } = parseArgs({ options: { write: { type: 'string' } } })

const SESSIONS = 10

function buildBundle(outFile: string): void {
  execFileSync(process.execPath, [path.join(packageRoot, 'scripts/build.mjs'), '--out', outFile], { stdio: 'pipe' })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number
}

const fmt = (n: number, digits = 2): string => n.toFixed(digits)

/** The last `<prefix> <n>` line on the session's screen, via a snapshot restored into a headless terminal. */
async function lastNumber(client: PtyClient, id: string, prefix: string): Promise<number | null> {
  const snapshot = await client.snapshot(id)
  const mirror = new Mirror(snapshot.cols, snapshot.rows, 10_000)
  await mirror.write(snapshot.data)
  const numbers = mirror
    .lines()
    .filter((line) => line.startsWith(`${prefix} `))
    .map((line) => Number(line.slice(prefix.length + 1)))
  mirror.dispose()
  return numbers.length > 0 ? Math.max(...numbers) : null
}

function table(header: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]): string => `| ${cells.join(' | ')} |`
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n')
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join('/tmp', 'bancada-proof-'))
  const bundlePath = path.join(dataDir, 'bundle', 'pty-host.cjs')
  const options = { dataDir, bundlePath, electronPath, appVersion: '0.0.0-proof', clientName: 'proof' }
  let hostPid = 0
  let failed = false
  const report: string[] = []
  const log = (line = ''): void => {
    console.log(line)
    report.push(line)
  }
  const check = (ok: boolean, what: string): void => {
    if (!ok) failed = true
    log(`- ${ok ? 'PASS' : 'FAIL'}: ${what}`)
  }

  try {
    // 1. Start the host and ten sessions that each print a counter every 200 ms.
    buildBundle(bundlePath)
    const first = await ensureHost(options)
    hostPid = first.host?.pid ?? 0
    const script = `i=0; while :; do echo count $i; i=$((i+1)); sleep 0.2; done`
    const ids: string[] = []
    for (let i = 0; i < SESSIONS; i++) {
      const info = await first.spawn({
        cwd: '/tmp',
        cols: 100,
        rows: 30,
        command: '/bin/sh',
        args: ['-c', script],
      })
      ids.push(info.id)
    }
    await sleep(1500)
    const before = new Map<string, number>()
    for (const id of ids) before.set(id, (await lastNumber(first, id, 'count')) ?? -1)
    const clientGoneAt = Date.now()

    // 2. The client goes away; the bundle is deleted and rebuilt (different content, so a new runtime dir).
    first.close()
    const firstRuntime = fs.readdirSync(path.join(dataDir, 'runtime'))
    fs.rmSync(path.dirname(bundlePath), { recursive: true })
    buildBundle(bundlePath)
    fs.appendFileSync(bundlePath, `\n// rebuilt at ${new Date().toISOString()}\n`)
    prepareRuntime({ dataDir, bundlePath })
    await sleep(3000)

    // 3. A new client finds the same host (no second launch) and the sessions have kept running.
    const second = await ensureHost(options)
    const sameHost = second.host?.pid === hostPid
    const away = Date.now() - clientGoneAt
    const list = await second.list()
    const rows: (string | number)[][] = []
    let advanced = 0
    for (const id of ids) {
      const info = list.find((s) => s.id === id)
      const after = (await lastNumber(second, id, 'count')) ?? -1
      const delta = after - (before.get(id) ?? 0)
      if (info?.state === 'running' && delta > 0) advanced++
      rows.push([id.slice(0, 8), info?.pid ?? '-', info?.state ?? 'missing', before.get(id) ?? '-', after, delta])
    }
    const hostProcesses = execFileSync('pgrep', ['-f', `${dataDir}/runtime`], { encoding: 'utf8' })
      .trim()
      .split('\n').length
    const runtimes = fs.readdirSync(path.join(dataDir, 'runtime'))

    log('## Survive: client gone, bundle deleted and rebuilt')
    log()
    log(table(['session', 'pid', 'state', 'counter before', 'counter after', 'advanced'], rows))
    log()
    check(
      sameHost,
      `the new client reached the same host (pid ${hostPid}); no second host launched (${hostProcesses} host process)`,
    )
    check(hostProcesses === 1, 'exactly one pty-host process for the data dir')
    check(
      runtimes.length === 2 && firstRuntime.length === 1,
      `the rebuilt bundle got its own runtime dir (${runtimes.length} dirs), the running host kept its copy`,
    )
    check(
      advanced === SESSIONS,
      `${advanced}/${SESSIONS} sessions running with advanced counters after ${(away / 1000).toFixed(1)} s without a client`,
    )

    // 4. Serialize cost with a full 10,000-line scrollback.
    const rowsVisible = 40
    const total = 10_000 + rowsVisible
    const plain = await second.spawn({
      cwd: '/tmp',
      cols: 120,
      rows: rowsVisible,
      command: '/usr/bin/awk',
      args: [
        `BEGIN { for (i = 1; i <= ${total}; i++) printf "line %d: the quick brown fox jumps over the lazy dog, again and again\\n", i }`,
      ],
    })
    const colored = await second.spawn({
      cwd: '/tmp',
      cols: 120,
      rows: rowsVisible,
      command: '/usr/bin/awk',
      args: [
        `BEGIN { for (i = 1; i <= ${total}; i++) printf "\\033[3%dmline %d\\033[0m: \\033[1mthe quick\\033[22m brown \\033[4mfox\\033[24m jumps over the lazy dog, again and again\\n", i % 8, i }`,
      ],
    })
    await sleep(2500)
    const serializeRows: (string | number)[][] = []
    const logPath = resolveHostLogPath(dataDir)
    const variants: [string, typeof plain, number | undefined][] = [
      ['plain text, full scrollback', plain, undefined],
      ['colored (SGR on every line), full scrollback', colored, undefined],
      ['colored, attach with scrollback 5000', colored, 5000],
      ['colored, attach with scrollback 2000', colored, 2000],
      ['colored, attach with scrollback 1000', colored, 1000],
    ]
    for (const [label, info, scrollback] of variants) {
      const roundTrips: number[] = []
      let bytes = 0
      const logBefore = fs.readFileSync(logPath, 'utf8').split('\n').length
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now()
        const snapshot = await second.snapshot(info.id, { scrollback })
        roundTrips.push(performance.now() - t0)
        bytes = Buffer.byteLength(snapshot.data)
      }
      roundTrips.sort((a, b) => a - b)
      const hostMs = fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .slice(logBefore - 1)
        .filter((l) => l.includes('snapshot {') && l.includes(info.id))
        .map((l) => (JSON.parse(l.slice(l.indexOf('{'))) as { serialize_ms: number }).serialize_ms)
        .sort((a, b) => a - b)
      serializeRows.push([
        label,
        `${fmt(bytes / 1024, 0)} KiB`,
        fmt(percentile(hostMs, 50)),
        fmt(hostMs.at(-1) as number),
        fmt(percentile(roundTrips, 50)),
        fmt(roundTrips.at(-1) as number),
      ])
    }
    log()
    log('## Serialize time and snapshot size (20 snapshots each)')
    log()
    log(
      `Buffer: ${total} lines (10,000 scrollback + ${rowsVisible} rows), 120 columns. Serialize time is measured inside the host (it blocks the host while it runs); round trip is client-side.`,
    )
    log()
    log(
      table(
        [
          'content',
          'snapshot size',
          'serialize p50 (ms)',
          'serialize max (ms)',
          'round trip p50 (ms)',
          'round trip max (ms)',
        ],
        serializeRows,
      ),
    )

    // 5. Echo round trip: client -> host -> pty -> host -> client, one keystroke at a time.
    async function echoLatency(client: PtyClient, id: string): Promise<number[]> {
      let wake: (() => void) | null = null
      await client.attach(id, () => wake?.())
      const samples: number[] = []
      for (let i = 0; i < 200; i++) {
        const echoed = new Promise<void>((resolve) => {
          wake = resolve
        })
        const t0 = performance.now()
        client.write(id, 'x')
        await echoed
        samples.push(performance.now() - t0)
        await sleep(5)
      }
      await client.detach(id)
      return samples.sort((a, b) => a - b)
    }
    const cat = await second.spawn({ cwd: '/tmp', cols: 100, rows: 30, command: '/bin/cat', args: [] })
    const idle = await echoLatency(second, cat.id)
    const flood = await second.spawn({ cwd: '/tmp', cols: 100, rows: 30, command: '/usr/bin/yes', args: [] })
    const sink = await connectToHost(dataDir)
    await sink.attach(flood.id, () => {})
    const cat2 = await second.spawn({ cwd: '/tmp', cols: 100, rows: 30, command: '/bin/cat', args: [] })
    const loaded = await echoLatency(second, cat2.id)
    sink.close()
    const latencyRows = [
      ['idle host', 200, fmt(percentile(idle, 50)), fmt(percentile(idle, 95)), fmt(idle.at(-1) as number)],
      [
        'another session flooding output (`yes`, attached)',
        200,
        fmt(percentile(loaded, 50)),
        fmt(percentile(loaded, 95)),
        fmt(loaded.at(-1) as number),
      ],
    ]
    log()
    log(
      "Numbers vary run to run (the machine is shared; the first snapshots include JIT warm-up, which shows in the max column). Serialization runs on the host's event loop, so a long snapshot delays output for every session: attach with a smaller `scrollback` when the pane only needs recent history.",
    )
    log()
    log('## Echo round-trip latency (one keystroke at a time)')
    log()
    log(table(['condition', 'keystrokes', 'p50 (ms)', 'p95 (ms)', 'max (ms)'], latencyRows))

    // 6. Force shutdown.
    await second.shutdown(true)
    second.close()
    const deadline = Date.now() + 10_000
    while (alive(hostPid) && Date.now() < deadline) await sleep(50)
    log()
    check(!alive(hostPid), 'forced shutdown ended the host and removed its sessions')
    check(!fs.existsSync(path.join(dataDir, 'pty-host.sock')), 'socket removed on shutdown')
  } finally {
    if (hostPid && alive(hostPid)) process.kill(hostPid, 'SIGKILL')
    const versions = JSON.parse(
      execFileSync(electronPath, ['-e', 'console.log(JSON.stringify(process.versions))'], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }),
    ) as Record<string, string>
    const doc = [
      '# F0-b (headless): terminals survive the client and the bundle',
      '',
      'Generated by `pnpm --filter @bancada/pty-host proof:survive`. Host run through Electron node mode on a `mkdtemp` data dir; the client is plain Node.',
      '',
      `- Date: ${new Date().toISOString()}`,
      `- Machine: ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus()[0]?.model ?? 'unknown cpu'}, ${os.cpus().length} cores`,
      `- Host runtime: Electron node mode (node ${versions.node}, electron ${versions.electron}); client: node ${process.versions.node}`,
      '',
      'What this shows: the host process (not the client, not the bundle on disk) owns the terminals. Ten sessions keep counting while no client is connected and while the bundle is deleted and rebuilt, and a new client finds the same host without launching another. Mid-stream attach correctness is covered by `packages/pty-host/src/host.test.ts` (six runs of a 400,000-line counter, compared against the host snapshot). The GUI half of proof (b) (the Electron app closing and reopening) is separate.',
      '',
      ...report,
      '',
    ].join('\n')
    if (values.write) {
      const target = path.resolve(packageRoot, values.write)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, doc)
      console.log(`\nwrote ${target}`)
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  if (failed) process.exit(1)
}

void main()
