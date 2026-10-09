import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * Electron downloads its binary lazily on the first `require('electron')` when the install did not (CI does not run the
 * postinstall). Test files that launch hosts do that at the same time, and parallel downloads into one directory
 * corrupt each other (a host "exited with code null"). Do it once, here, before any project starts.
 */
export default function setup(): void {
  const hostPackage = path.resolve(import.meta.dirname, 'packages/pty-host/package.json')
  createRequire(hostPackage)('electron')
}
