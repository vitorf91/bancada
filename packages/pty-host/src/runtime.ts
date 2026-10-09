import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { resolveHostLogPath, resolveHostRuntimeDir, resolveSocketPath } from '@bancada/protocol/paths'
import { version as hostVersion } from '../package.json'
import { PtyClient, PtyHostError } from './client.js'

/** File name of the host bundle inside a runtime dir. */
export const HOST_ENTRY_FILE = 'pty-host.cjs'
const READY_MARKER = '.ready'

export interface PrepareRuntimeOptions {
  dataDir: string
  /** The esbuild output (one file, node-pty external). */
  bundlePath: string
  /** The node-pty package dir. Defaults to the one that resolves from this package. */
  nodePtyDir?: string
}

export interface PreparedRuntime {
  /** `<dataDir>/runtime/pty-host-<version>` */
  dir: string
  /** The bundle copy inside `dir`: what the host runs. */
  entry: string
  /** `<package version>-<10 hex of the content hash>` */
  version: string
}

function defaultNodePtyDir(): string {
  return path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
}

/**
 * Copies the bundle and node-pty (package.json, lib, the platform prebuilds) to
 * `<dataDir>/runtime/pty-host-<version>/`. The version carries a content hash, so a rebuilt bundle lands in its
 * own dir and a running host keeps executing (and keeps its `pty.node` mapped from) files nobody rewrites.
 * The dir is assembled aside and renamed into place, so a half-copied runtime is never visible.
 */
export function prepareRuntime({
  dataDir,
  bundlePath,
  nodePtyDir = defaultNodePtyDir(),
}: PrepareRuntimeOptions): PreparedRuntime {
  const bundle = fs.readFileSync(bundlePath)
  const nodePtyVersion = (
    JSON.parse(fs.readFileSync(path.join(nodePtyDir, 'package.json'), 'utf8')) as { version: string }
  ).version
  const hash = createHash('sha256').update(bundle).update(nodePtyVersion).digest('hex').slice(0, 10)
  const version = `${hostVersion}-${hash}`
  const dir = resolveHostRuntimeDir(dataDir, version)
  const entry = path.join(dir, HOST_ENTRY_FILE)
  if (fs.existsSync(path.join(dir, READY_MARKER))) return { dir, entry, version }

  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 })
  const staging = `${dir}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(staging, HOST_ENTRY_FILE), bundle, { mode: 0o644 })

    const target = path.join(staging, 'node_modules', 'node-pty')
    fs.mkdirSync(target, { recursive: true })
    fs.copyFileSync(path.join(nodePtyDir, 'package.json'), path.join(target, 'package.json'))
    fs.cpSync(path.join(nodePtyDir, 'lib'), path.join(target, 'lib'), { recursive: true, dereference: true })
    const prebuilds = path.join(nodePtyDir, 'prebuilds')
    for (const name of fs.readdirSync(prebuilds)) {
      if (!name.startsWith(`${process.platform}-`)) continue
      fs.cpSync(path.join(prebuilds, name), path.join(target, 'prebuilds', name), {
        recursive: true,
        dereference: true,
      })
      // The package manager unpacks spawn-helper without the exec bit, and node-pty fails with "posix_spawnp failed".
      const helper = path.join(target, 'prebuilds', name, 'spawn-helper')
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
    }
    if (!fs.existsSync(path.join(target, 'prebuilds', `${process.platform}-${process.arch}`))) {
      throw new Error(`node-pty at ${nodePtyDir} has no prebuilt binary for ${process.platform}-${process.arch}`)
    }
    fs.writeFileSync(path.join(staging, READY_MARKER), `${version}\n`)
    try {
      fs.renameSync(staging, dir)
    } catch (error) {
      // A concurrent caller published the same content first: theirs is identical, keep it.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  return { dir, entry, version }
}

export interface LaunchHostOptions {
  dataDir: string
  /** `PreparedRuntime.entry`. */
  entry: string
  /** Electron's binary: `require('electron')` in tests and dev, `process.execPath` in the packaged app. */
  electronPath: string
  /** Reported to sessions as `TERM_PROGRAM_VERSION`. */
  appVersion?: string
  /** The host's environment; sessions inherit it minus the stripped variables. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

export interface LaunchedHost {
  pid: number
  /** Set once the launched process has exited (a second host for the same data dir exits at once). */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/** Starts the host detached from this process (`ELECTRON_RUN_AS_NODE=1`), so it outlives the caller. */
export function launchHost({
  dataDir,
  entry,
  electronPath,
  appVersion,
  env = process.env,
}: LaunchHostOptions): LaunchedHost {
  const hostEnv: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', BANCADA_DATA_DIR: dataDir }
  if (appVersion) hostEnv.BANCADA_APP_VERSION = appVersion
  const child = spawn(electronPath, [entry], { detached: true, stdio: 'ignore', env: hostEnv, cwd: dataDir })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', () => resolve({ code: null, signal: null }))
  })
  child.unref()
  if (child.pid === undefined) throw new Error(`Could not launch ${electronPath}`)
  return { pid: child.pid, exit }
}

export interface EnsureHostOptions extends Omit<LaunchHostOptions, 'entry'>, Omit<PrepareRuntimeOptions, 'dataDir'> {
  /** Total time to wait for a launched host to accept connections. Default 15000 ms. */
  timeoutMs?: number
  clientName?: string
}

const inFlight = new Map<string, Promise<PtyClient>>()

function isNoHost(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

/** Connects to the host of `dataDir`. Rejects with ENOENT / ECONNREFUSED when none is running. */
export function connectToHost(
  dataDir: string,
  options: { clientName?: string; timeoutMs?: number } = {},
): Promise<PtyClient> {
  return PtyClient.connect({ socketPath: resolveSocketPath(dataDir, process.getuid?.() ?? 0), ...options })
}

/**
 * A client of the running host, launching one first when there is none. Concurrent calls in this process share
 * one launch; a host started by someone else at the same moment wins the pid lock and everybody connects to it.
 */
export function ensureHost(options: EnsureHostOptions): Promise<PtyClient> {
  const existing = inFlight.get(options.dataDir)
  if (existing) return existing
  const attempt = doEnsureHost(options).finally(() => inFlight.delete(options.dataDir))
  inFlight.set(options.dataDir, attempt)
  return attempt
}

async function doEnsureHost(options: EnsureHostOptions): Promise<PtyClient> {
  const { dataDir, timeoutMs = 15_000, clientName } = options
  try {
    return await connectToHost(dataDir, { clientName, timeoutMs: 2000 })
  } catch (error) {
    if (!isNoHost(error)) throw error
  }

  const runtime = prepareRuntime({ dataDir, bundlePath: options.bundlePath, nodePtyDir: options.nodePtyDir })
  const launched = launchHost({ ...options, entry: runtime.entry })
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    try {
      return await connectToHost(dataDir, { clientName, timeoutMs: 2000 })
    } catch (error) {
      if (!isNoHost(error)) throw error
      lastError = error
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  const exited = await Promise.race([launched.exit, Promise.resolve(null)])
  throw new PtyHostError(
    'connection_closed',
    `The pty-host did not accept connections within ${timeoutMs} ms (${String(lastError)}${
      exited ? `; the launched process exited with code ${String(exited.code)}` : ''
    }). See ${resolveHostLogPath(dataDir)}`,
  )
}
