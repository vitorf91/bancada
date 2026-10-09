import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fallbackSocketDir, SOCKET_PATH_LIMIT_BYTES } from '@bancada/protocol/paths'

export const CONTROL_SOCKET_FILE = 'server.sock'
export const DEVICES_FILE = 'devices.json'
export const PUSH_FILE = 'push.json'

/**
 * `<dataDir>/server.sock`, or `/tmp/bancada-<uid>/<first 12 hex of sha1(dataDir)>-server.sock` when the path would
 * reach macOS's 104-byte `sun_path` limit. Same rule as the pty-host socket (docs/ARCHITECTURE.md).
 */
export function resolveControlSocketPath(dataDir: string, uid: number): string {
  const preferred = path.join(dataDir, CONTROL_SOCKET_FILE)
  if (Buffer.byteLength(preferred, 'utf8') < SOCKET_PATH_LIMIT_BYTES) return preferred
  const digest = createHash('sha1').update(dataDir).digest('hex').slice(0, 12)
  return path.join(fallbackSocketDir(uid), `${digest}-server.sock`)
}

/** Creates the parent dir of a fallback socket (mode 0700) and refuses one that someone else owns or can open. */
export function ensureSocketDir(socketPath: string, uid: number): void {
  const dir = path.dirname(socketPath)
  if (dir !== fallbackSocketDir(uid)) return
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = fs.statSync(dir)
  if (stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} must be owned by uid ${uid} with mode 0700`)
  }
}
