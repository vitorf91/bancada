import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { connectToHost, launchApp, makeTempDir, shutdownHost } from '../e2e/helpers.js'
import { averageCpu, childrenCpuSeconds, latencyStats, type MetricSample, processCpuSeconds } from './measure.js'
import { chooseDefault, type RunResult, type RunSpec, renderReport } from './report.js'

// Proof (a): 16 terminals in a 4x4 grid (15 replaying an agent session, 1 echoing keys) in a 1512x982 window.
// `pnpm --filter @bancada/desktop bench` writes docs/proofs/F0-a.md. BANCADA_BENCH_ONLY=<name,name> runs a subset
// (and prints instead of writing the report). BANCADA_BENCH_SECONDS shortens the measured window for debugging.

// Resolved from this package so pnpm's strict layout finds the Electron binary.
const electronPath = createRequire(import.meta.url)('electron') as string
const repoRoot = path.resolve(import.meta.dirname, '../../..')
const desktopDir = path.resolve(import.meta.dirname, '..')
const PRIVATE_CAST = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Bancada',
  'fixtures',
  'claude-session-1.cast',
)
const SYNTHETIC_CAST = path.join(repoRoot, 'tools', 'replay', 'fixtures', 'synthetic', 'agent-like.cast')
const REPLAY_CLI = path.join(repoRoot, 'tools', 'replay', 'dist', 'cli.mjs')
const ECHO_PROGRAM = path.join(desktopDir, 'bench', 'echo.cjs')
const REPORT = path.join(repoRoot, 'docs', 'proofs', 'F0-a.md')

const WINDOW_SECONDS = Number(process.env.BANCADA_BENCH_SECONDS ?? 60)
const WARMUP_SECONDS = 8
const TYPING_START_SECONDS = 3
const KEYS = Number(process.env.BANCADA_BENCH_KEYS ?? 300)
const KEY_GAP_MS = 80
const ECHO_TIMEOUT_MS = 1000
const TERMINALS = 16

const SPECS: RunSpec[] = [
  { name: 'all-webgl', label: 'all WebGL', mode: 'all-webgl', webglLimit: TERMINALS, speed: 1 },
  { name: 'all-dom', label: 'all DOM', mode: 'all-dom', webglLimit: 0, speed: 1 },
  { name: 'hybrid-4', label: 'hybrid, 4 WebGL (focused + 3 most recent)', mode: 'hybrid', webglLimit: 4, speed: 1 },
  { name: 'hybrid-8', label: 'hybrid, 8 WebGL (focused + 7 most recent)', mode: 'hybrid', webglLimit: 8, speed: 1 },
]

function castFile(): { file: string; privateFixture: boolean } {
  return existsSync(PRIVATE_CAST)
    ? { file: PRIVATE_CAST, privateFixture: true }
    : { file: SYNTHETIC_CAST, privateFixture: false }
}

async function metrics(app: ElectronApplication): Promise<MetricSample[]> {
  return app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage })),
  )
}

async function runOnce(spec: RunSpec, cast: string): Promise<RunResult> {
  const dataDir = makeTempDir('bancada-bench-')
  const cwd = makeTempDir('bancada-bench-cwd-')
  const config = {
    mode: spec.mode,
    webglLimit: spec.webglLimit,
    speed: spec.speed,
    terminals: TERMINALS,
    cols: 60,
    rows: 12,
    execPath: electronPath,
    replayCli: REPLAY_CLI,
    cast,
    echoProgram: ECHO_PROGRAM,
    cwd,
  }
  const app = await launchApp(dataDir, path.join(dataDir, 'no-config.toml'), {
    BANCADA_BENCH_CONFIG: JSON.stringify(config),
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => window.__bench !== undefined, undefined, { timeout: 60_000 })
    await page.evaluate(() => window.__bench?.ready)

    // The host and its session processes, for the CPU that Electron's own metrics do not cover.
    const client = await connectToHost(dataDir)
    const hostPid = client.host?.pid ?? 0
    client.close()

    await page.waitForTimeout(WARMUP_SECONDS * 1000)
    await page.locator('[data-echo="true"] .xterm-helper-textarea').focus()

    await metrics(app) // getAppMetrics reports CPU "since the last call": discard this one
    const hostBefore = processCpuSeconds(hostPid)
    const childrenBefore = childrenCpuSeconds(hostPid)
    const startedAt = Date.now()
    await page.evaluate(() => window.__bench?.start())

    const samples: MetricSample[][] = []
    const sampler = (async () => {
      while ((Date.now() - startedAt) / 1000 < WINDOW_SECONDS) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        samples.push(await metrics(app))
      }
    })()

    const typer = (async () => {
      await new Promise((resolve) => setTimeout(resolve, TYPING_START_SECONDS * 1000))
      const letters = 'abcdefghijklmnopqrstuvwxyz'
      let have = 0
      for (let i = 0; i < KEYS && (Date.now() - startedAt) / 1000 < WINDOW_SECONDS - 1; i++) {
        await page.keyboard.press(letters[i % letters.length] ?? 'a')
        const got = await page.evaluate(([n, t]) => window.__bench?.waitEcho(n ?? 0, t ?? 0), [
          have + 1,
          ECHO_TIMEOUT_MS,
        ] as const)
        if ((got ?? 0) > have) have = got ?? have
        else await page.evaluate(() => window.__bench?.noteMissed())
        await new Promise((resolve) => setTimeout(resolve, KEY_GAP_MS))
      }
    })()

    await Promise.all([sampler, typer])
    const elapsed = (Date.now() - startedAt) / 1000
    const shot = process.env.BANCADA_BENCH_SCREENSHOT
    // The replay is a private recording: a screenshot is for a look on this machine, never for the repo.
    if (shot) await page.screenshot({ path: path.join(shot, `${spec.name}.png`) })
    const stats = await page.evaluate(() => window.__bench?.stop())
    const renderers = await page.evaluate(() => window.__bench?.renderers())
    const hostAfter = processCpuSeconds(hostPid)
    const childrenAfter = childrenCpuSeconds(hostPid)
    if (!stats || !renderers) throw new Error('bench page returned nothing')

    const cpu = averageCpu(samples)
    const versions = await app.evaluate(() => ({
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
    }))
    return {
      spec,
      versions,
      seconds: elapsed,
      latency: latencyStats(stats.echoLatencies),
      echoMissed: stats.echoMissed,
      frames: {
        total: stats.frames,
        dropped: stats.dropped,
        droppedPct: stats.frames === 0 ? 0 : (stats.dropped / stats.frames) * 100,
        medianDelta: stats.deltas.median,
        p95Delta: stats.deltas.p95,
        maxDelta: stats.deltas.max,
      },
      cpu,
      hostCpu: ((hostAfter - hostBefore) / elapsed) * 100,
      sessionsCpu: ((childrenAfter - childrenBefore) / elapsed) * 100,
      renderers,
    }
  } finally {
    await app.close().catch(() => undefined)
    await shutdownHost(dataDir, 3000)
    await rm(dataDir, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
}

test('proof (a): 16 terminals with continuous agent-like output', async () => {
  const { file, privateFixture } = castFile()
  const only = process.env.BANCADA_BENCH_ONLY?.split(',').filter(Boolean)
  const specs = only ? SPECS.filter((s) => only.includes(s.name)) : SPECS
  const results: RunResult[] = []
  for (const spec of specs) {
    const result = await runOnce(spec, file)
    console.log(JSON.stringify({ name: spec.name, ...result, spec: undefined }))
    results.push(result)
  }

  const best = chooseDefault(results)
  let stress: RunResult | null = null
  if (best && !only) {
    const stressSpec: RunSpec = {
      ...best.spec,
      name: `${best.spec.name}-stress`,
      label: `${best.spec.label}, replay speed 4`,
      speed: 4,
    }
    stress = await runOnce(stressSpec, file)
    console.log(JSON.stringify({ name: stressSpec.name, ...stress, spec: undefined }))
  }

  const report = await renderReport({ results, best, stress, privateFixture, windowSeconds: WINDOW_SECONDS })
  if (only || WINDOW_SECONDS !== 60) {
    console.log(report)
  } else {
    await mkdir(path.dirname(REPORT), { recursive: true })
    await writeFile(REPORT, report)
    console.log(`wrote ${path.relative(repoRoot, REPORT)}`)
  }
  expect(results.length).toBeGreaterThan(0)
  // The report states pass or fail; the bench itself only fails when it could not measure.
  for (const result of results) expect(result.latency.n).toBeGreaterThanOrEqual(Math.min(200, KEYS))
})
