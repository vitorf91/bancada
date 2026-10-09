import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PtyClient } from '@bancada/pty-host'
import { ensureHostConnector } from '../connector.js'
import type { HostConnector } from '../host-link.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const hostPackage = path.resolve(here, '../../../pty-host')
const require_ = createRequire(import.meta.url)

export function electronBinary(): string {
  return require_('electron') as string
}

/** The same directory `scripts/launch.mjs` hands to the server. */
export function nodePtyDir(): string {
  return path.dirname(createRequire(path.join(hostPackage, 'package.json')).resolve('node-pty/package.json'))
}

export function buildHostBundle(outFile: string): void {
  execFileSync(process.execPath, [path.join(hostPackage, 'scripts/build.mjs'), '--out', outFile], { stdio: 'pipe' })
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface RealHost {
  dataDir: string
  connector: HostConnector
  /** A client of the same host, for the test to spawn sessions and type into them. */
  client: PtyClient
  hostPid: number
  stop(): Promise<void>
}

/** A real pty-host launched through Electron's node mode on a fresh `/tmp/bancada-t-*` data dir, through `ensureHost`. */
export async function startRealHost(): Promise<RealHost> {
  const dataDir = fs.mkdtempSync(path.join('/tmp', 'bancada-t-srv-'))
  const bundlePath = path.join(dataDir, 'bundle', 'pty-host.cjs')
  buildHostBundle(bundlePath)
  const connector = ensureHostConnector({
    dataDir,
    bundlePath,
    nodePtyDir: nodePtyDir(),
    electronPath: electronBinary(),
    appVersion: '0.0.0-test',
  })
  const client = await connector.connect('test')
  const hostPid = client.host?.pid
  if (hostPid === undefined) throw new Error('hello did not report a pid')
  return {
    dataDir,
    connector,
    client,
    hostPid,
    async stop() {
      client.close()
      // The host that is running now may not be the one we started (a test can restart it): read the pid file.
      const pids = new Set([hostPid])
      try {
        pids.add(Number.parseInt(fs.readFileSync(path.join(dataDir, 'pty-host.pid'), 'utf8'), 10))
      } catch {
        // no pid file
      }
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
      const deadline = Date.now() + 5000
      while ([...pids].some(processAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
