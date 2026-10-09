import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionId } from '@bancada/protocol'
import type { PtyClient } from '../client.js'
import { ensureHost, prepareRuntime } from '../runtime.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Electron's binary, the only runtime the host ever runs under. */
export function electronBinary(): string {
  return createRequire(import.meta.url)('electron') as string
}

/** Bundles `entry` (a path relative to the package) into `outFile` with the same script `pnpm build` uses. */
export function buildBundle(outFile: string, entry = 'src/host/main.ts', external = 'node-pty'): void {
  execFileSync(
    process.execPath,
    [path.join(packageRoot, 'scripts/build.mjs'), '--entry', entry, '--out', outFile, '--external', external],
    { stdio: 'pipe' },
  )
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitUntil(check: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export interface TestHost {
  dataDir: string
  bundlePath: string
  pid: number
  client: PtyClient
  /** Another client of the same host. */
  connect(): Promise<PtyClient>
}

const startedHosts: { pid: number; dataDir: string }[] = []

/**
 * Launches a real host through Electron's node mode on a fresh data dir under /tmp. Tests that start hosts call
 * `cleanupHosts()` in `afterAll`.
 */
export async function startHost(options: { env?: NodeJS.ProcessEnv; dataDir?: string } = {}): Promise<TestHost> {
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join('/tmp', 'bancada-t-'))
  const bundlePath = path.join(dataDir, 'bundle', 'pty-host.cjs')
  buildBundle(bundlePath)
  const client = await ensureHost({
    dataDir,
    bundlePath,
    electronPath: electronBinary(),
    appVersion: '0.0.0-test',
    env: { ...process.env, ...options.env },
  })
  const pid = client.host?.pid
  if (pid === undefined) throw new Error('hello did not report a pid')
  startedHosts.push({ pid, dataDir })
  const { connectToHost } = await import('../runtime.js')
  return { dataDir, bundlePath, pid, client, connect: () => connectToHost(dataDir) }
}

/** Kills every host this process started (SIGKILL by pid), removes their data dirs, and checks they are gone. */
export async function cleanupHosts(): Promise<void> {
  for (const { pid } of startedHosts) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const { pid } of startedHosts) await waitUntil(() => !processAlive(pid), 5000, `host ${pid} to die`)
  for (const { dataDir } of startedHosts) fs.rmSync(dataDir, { recursive: true, force: true })
  startedHosts.length = 0
}

/** Collects what a session prints, decoded as UTF-8. */
export class OutputCollector {
  text = ''
  bytes = 0
  private readonly decoder = new TextDecoder()
  readonly chunks: Uint8Array[] = []

  readonly onData = (data: Uint8Array): void => {
    this.chunks.push(data)
    this.bytes += data.byteLength
    this.text += this.decoder.decode(data, { stream: true })
  }

  waitFor(pattern: RegExp | string, timeoutMs = 10_000): Promise<void> {
    const matches = (): boolean => (typeof pattern === 'string' ? this.text.includes(pattern) : pattern.test(this.text))
    return waitUntil(matches, timeoutMs, `output matching ${String(pattern)}`)
  }
}

export function exitedSessions(client: PtyClient, id: SessionId): Promise<void> {
  return new Promise((resolve) => {
    const off = client.onEvent((event) => {
      if (event.type === 'event' && event.event === 'session-exited' && event.id === id) {
        off()
        resolve()
      }
    })
  })
}

export { prepareRuntime }
