import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { connectToHost, launchApp, makeTempDir, screenText, shutdownHost } from './helpers.js'

// Proof (b) at app level: ten live shells survive closing the app, `kill -9` of its main process and a rebuild of
// the app, and the relaunched app shows them again with recent screens. The host-level numbers are in
// docs/proofs/F0-b-headless.md. With BANCADA_PROOF_B_OUT=<file> the result is written there (docs/proofs/F0-b.md).

const SESSIONS = 10
const desktopDir = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(desktopDir, '../..')
const COUNTER = 'i=0; while true; do i=$((i+1)); echo tick-$i; sleep 0.2; done'

interface Snapshot {
  id: string
  pid: number | null
  alive: boolean
  state: string
  counter: number
}

interface PhaseResult {
  name: string
  detail: string
  sessions: Snapshot[]
  checks: Array<{ ok: boolean; text: string }>
}

const phases: PhaseResult[] = []
let dataDir: string
let projectsDir: string
let configPath: string
const apps: ElectronApplication[] = []

test.beforeAll(() => {
  dataDir = makeTempDir('bancada-proof-b-')
  projectsDir = makeTempDir('bancada-proof-b-fx-')
  const folders = Array.from({ length: SESSIONS }, (_, i) => {
    const dir = path.join(projectsDir, `shell-${String(i + 1).padStart(2, '0')}`)
    mkdirSync(dir)
    return dir
  })
  configPath = path.join(projectsDir, 'config.toml')
  writeFileSync(
    configPath,
    `[[products]]\nid = "proof"\nname = "Proof"\ncolor = "#4f8cff"\nprojects = [\n${folders.map((dir) => `  { path = "${dir}" },`).join('\n')}\n]\n`,
  )
})

test.afterAll(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined)
  await shutdownHost(dataDir, 2000)
  await rm(dataDir, { recursive: true, force: true })
  await rm(projectsDir, { recursive: true, force: true })
})

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(dataDir, configPath)
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  return { app, page }
}

function lastTick(text: string): number {
  const ticks = [...text.matchAll(/tick-(\d+)/g)].map((m) => Number(m[1]))
  return ticks.length ? Math.max(...ticks) : 0
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Sessions as the host reports them, with the counter each one's screen shows in the page (when there is a page). */
async function snapshot(page: Page | null): Promise<Snapshot[]> {
  const client = await connectToHost(dataDir)
  try {
    const list = await client.list()
    const out: Snapshot[] = []
    for (const s of list) {
      const text = page ? await screenText(page, s.id) : (await client.snapshot(s.id)).data
      out.push({ id: s.id, pid: s.pid, alive: isAlive(s.pid), state: s.state, counter: lastTick(text) })
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  } finally {
    client.close()
  }
}

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10)
const bundles = (): string =>
  `app ${sha(path.join(desktopDir, 'out/main/index.js'))}, host ${sha(path.join(repoRoot, 'packages/pty-host/dist/pty-host.cjs'))}`

/** Relaunch and check: every session alive with its old pid, the panels live again, the screens recent. */
async function relaunchAndCheck(name: string, detail: string, before: Snapshot[], minAdvance: number): Promise<void> {
  const { page } = await open()
  await expect(page.getByTestId('panel')).toHaveCount(SESSIONS)
  await expect(page.locator('[data-testid="panel"][data-status="live"]')).toHaveCount(SESSIONS, { timeout: 20_000 })
  // Wait for every restored screen to show a counter beyond the one it had before.
  await expect
    .poll(
      async () => (await snapshot(page)).filter((s, i) => s.counter >= (before[i]?.counter ?? 0) + minAdvance).length,
      {
        timeout: 20_000,
      },
    )
    .toBe(SESSIONS)
  const after = await snapshot(page)
  const checks = [
    { ok: after.length === SESSIONS, text: `${after.length}/${SESSIONS} sessions listed by the host` },
    {
      ok: after.every((s, i) => s.pid === before[i]?.pid),
      text: 'same pids as before',
    },
    {
      ok: after.filter((s) => s.alive).length === SESSIONS,
      text: `${after.filter((s) => s.alive).length}/${SESSIONS} processes alive (kill -0)`,
    },
    { ok: after.every((s) => s.state === 'running'), text: 'all sessions running' },
    {
      ok: after.every((s, i) => s.counter >= (before[i]?.counter ?? 0) + minAdvance),
      text: `restored screens show counters at least ${minAdvance} beyond the last seen before`,
    },
  ]
  for (const check of checks) expect(check.ok, check.text).toBe(true)
  phases.push({ name, detail, sessions: after, checks })
}

test('ten live shells survive closing the app, kill -9 of its main process and a rebuild', async () => {
  test.setTimeout(10 * 60_000)

  // Setup: ten panels (a click on a sidebar row opens a shell), each running a counter every 200 ms.
  const first = await open()
  const rows = first.page.getByTestId('folder')
  await expect(rows).toHaveCount(SESSIONS)
  for (let i = 0; i < SESSIONS; i++) {
    await rows.nth(i).click()
    await expect(first.page.getByTestId('panel')).toHaveCount(i + 1)
  }
  const ids = await first.page
    .getByTestId('panel')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-session-id') ?? ''))
  expect(new Set(ids).size).toBe(SESSIONS)
  for (const id of ids) {
    await expect.poll(() => screenText(first.page, id), { timeout: 15_000 }).toMatch(/\$\s*$/)
    await first.page.evaluate(([sid, command]) => window.bancada.write(sid ?? '', `${command}\n`), [
      id,
      COUNTER,
    ] as const)
  }
  await expect
    .poll(async () => (await snapshot(first.page)).filter((s) => s.counter >= 5).length, { timeout: 30_000 })
    .toBe(SESSIONS)
  await first.page.waitForTimeout(800) // the debounced board save
  const start = await snapshot(first.page)
  expect(start.every((s) => s.alive && s.pid)).toBe(true)
  phases.push({
    name: 'setup',
    detail: `${SESSIONS} shells started from ${SESSIONS} sidebar clicks, each printing a counter every 200 ms; bundles: ${bundles()}`,
    sessions: start,
    checks: [
      { ok: true, text: `${SESSIONS} sessions running with ${new Set(start.map((s) => s.pid)).size} distinct pids` },
    ],
  })

  // 1. Close the app (the normal quit path), wait, reopen.
  let before = await snapshot(first.page)
  await apps.pop()?.close()
  await new Promise((resolve) => setTimeout(resolve, 3000))
  await relaunchAndCheck(
    '1. close and relaunch',
    'app closed, 3 s without a client, relaunched on the same data dir',
    before,
    8,
  )

  // 2. kill -9 of the Electron main process.
  const second = { page: (await apps[0]?.firstWindow()) as Page }
  before = await snapshot(second.page)
  const mainPid = apps[0]?.process().pid
  if (!mainPid) throw new Error('no main pid')
  process.kill(mainPid, 'SIGKILL')
  await apps
    .pop()
    ?.close()
    .catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 3000))
  expect(isAlive(mainPid)).toBe(false)
  await relaunchAndCheck(
    '2. kill -9 and relaunch',
    `SIGKILL to the main process (pid ${mainPid}), 3 s later relaunched`,
    before,
    8,
  )

  // 3. Rebuild the desktop app (and the host bundle) between close and relaunch.
  const third = { page: (await apps[0]?.firstWindow()) as Page }
  before = await snapshot(third.page)
  await apps.pop()?.close()
  const bundlesBefore = bundles()
  rmSync(path.join(desktopDir, 'out'), { recursive: true, force: true })
  rmSync(path.join(repoRoot, 'packages/pty-host/dist'), { recursive: true, force: true })
  execFileSync('pnpm', ['--filter', '@bancada/pty-host', 'build'], { cwd: repoRoot, stdio: 'ignore' })
  execFileSync('pnpm', ['exec', 'electron-vite', 'build', '--ignoreConfigWarning'], {
    cwd: desktopDir,
    stdio: 'ignore',
  })
  await relaunchAndCheck(
    '3. rebuild and relaunch',
    `out/ and packages/pty-host/dist deleted and rebuilt while no app ran (${bundlesBefore} before, ${bundles()} after; same source, same bytes)`,
    before,
    8,
  )

  // End: shut the host down with force and confirm nothing is left.
  const pids = (await snapshot(null)).map((s) => s.pid)
  await apps.pop()?.close()
  await shutdownHost(dataDir, 2000)
  await expect.poll(() => pids.filter((pid) => isAlive(pid)).length, { timeout: 10_000 }).toBe(0)
  phases.push({
    name: 'shutdown',
    detail: 'host shut down with force',
    sessions: [],
    checks: [
      { ok: true, text: `forced shutdown ended the host; ${pids.length}/${pids.length} session processes gone` },
    ],
  })

  const out = process.env.BANCADA_PROOF_B_OUT
  if (out) {
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, renderDoc())
  }
})

function renderDoc(): string {
  const cpus = os.cpus()
  const lines: string[] = []
  lines.push('# F0-b: ten live sessions survive the app (app level)')
  lines.push('')
  lines.push(
    'Generated by `pnpm --filter @bancada/desktop proof:survive` (Playwright `_electron`, `mkdtemp` data dir under `/tmp`).',
  )
  lines.push('')
  lines.push(`- Date: ${new Date().toISOString()}`)
  lines.push(`- Machine: ${os.type()} ${os.release()} ${os.arch()}, ${cpus[0]?.model ?? 'unknown CPU'}`)
  lines.push('')
  lines.push(
    `What this shows: the Electron app is a client. Ten shells run a counter every 200 ms; the app is closed, killed with \`kill -9\` and replaced by a rebuilt one, and each time the new app finds the same ten processes (same pids) and its panels re-attach and draw a recent screen. The host-level numbers (no client at all, serialize times, echo round trip) are in [F0-b-headless.md](F0-b-headless.md).`,
  )
  lines.push('')
  for (const phase of phases) {
    lines.push(`## ${phase.name}`)
    lines.push('')
    lines.push(phase.detail)
    lines.push('')
    if (phase.sessions.length > 0) {
      lines.push('| session | pid | state | alive | counter on screen |')
      lines.push('| --- | --- | --- | --- | --- |')
      for (const s of phase.sessions)
        lines.push(`| ${s.id} | ${s.pid} | ${s.state} | ${s.alive ? 'yes' : 'no'} | ${s.counter} |`)
      lines.push('')
    }
    for (const check of phase.checks) lines.push(`- ${check.ok ? 'PASS' : 'FAIL'}: ${check.text}`)
    lines.push('')
  }
  return lines.join('\n')
}
