import { createHash } from 'node:crypto'
import path from 'node:path'

/**
 * Data dir, profile and pty-host socket rules from docs/ARCHITECTURE.md ("Data dir and profiles").
 * Pure: the environment, home dir and uid are parameters, so tests never read the real machine.
 */

export interface DataDirInput {
  env: Readonly<Record<string, string | undefined>>
  homeDir: string
}

/** macOS limits `sun_path` to 104 bytes; a socket path of this many bytes or more takes the fallback. */
export const SOCKET_PATH_LIMIT_BYTES = 100

export const DEFAULT_PROFILE = 'default'
export const SOCKET_FILE = 'pty-host.sock'
export const PID_FILE = 'pty-host.pid'

/** `BANCADA_PROFILE`, or `default`. The profile is a path segment, so separators and dot segments are rejected. */
export function resolveProfile(env: DataDirInput['env']): string {
  const profile = env.BANCADA_PROFILE?.trim()
  if (!profile) return DEFAULT_PROFILE
  if (profile === '.' || profile === '..' || /[/\\\0]/.test(profile)) {
    throw new Error(`Invalid BANCADA_PROFILE: ${JSON.stringify(profile)}`)
  }
  return profile
}

/** `BANCADA_DATA_DIR` wins; otherwise `<home>/Library/Application Support/Bancada/<profile>`. */
export function resolveDataDir({ env, homeDir }: DataDirInput): string {
  const override = env.BANCADA_DATA_DIR?.trim()
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new Error(`BANCADA_DATA_DIR must be an absolute path, got ${JSON.stringify(override)}`)
    }
    return path.resolve(override)
  }
  return path.join(homeDir, 'Library', 'Application Support', 'Bancada', resolveProfile(env))
}

/** Directory (mode 0700, created by whoever launches the host) that holds fallback sockets. */
export function fallbackSocketDir(uid: number): string {
  return `/tmp/bancada-${uid}`
}

/** `<dataDir>/pty-host.sock`, or `/tmp/bancada-<uid>/<first 12 hex of sha1(dataDir)>.sock` when that is too long. */
export function resolveSocketPath(dataDir: string, uid: number): string {
  const preferred = path.join(dataDir, SOCKET_FILE)
  if (Buffer.byteLength(preferred, 'utf8') < SOCKET_PATH_LIMIT_BYTES) return preferred
  const digest = createHash('sha1').update(dataDir).digest('hex').slice(0, 12)
  return path.join(fallbackSocketDir(uid), `${digest}.sock`)
}

/** `<dataDir>/pty-host.pid`: a second host for the same data dir refuses to start. */
export function resolvePidPath(dataDir: string): string {
  return path.join(dataDir, PID_FILE)
}
