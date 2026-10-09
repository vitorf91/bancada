import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

export class HostAlreadyRunningError extends Error {
  override name = 'HostAlreadyRunningError'
  constructor(
    readonly pid: number,
    pidPath: string,
  ) {
    super(`A pty-host is already running for this data dir (pid ${pid}, lock ${pidPath})`)
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A recycled pid belongs to some other program: only a process whose command line mentions pty-host counts. */
function looksLikeHost(pid: number): boolean {
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    return command.includes('pty-host')
  } catch {
    return true
  }
}

function readPid(pidPath: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Takes the `<dataDir>/pty-host.pid` lock. The file is created complete and atomically (written to a temp file,
 * then hard-linked into place), so a racing host never reads a half-written pid. A pid file whose process is
 * gone is stale and replaced. Returns a release function that only removes the file if it still holds our pid.
 */
export function acquirePidLock(pidPath: string, pid = process.pid): () => void {
  const temp = `${pidPath}.${pid}.tmp`
  fs.writeFileSync(temp, `${pid}\n`, { mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.linkSync(temp, pidPath)
        return () => {
          if (readPid(pidPath) === pid) fs.rmSync(pidPath, { force: true })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const holder = readPid(pidPath)
      if (holder !== null && holder !== pid && pidIsAlive(holder) && looksLikeHost(holder)) {
        throw new HostAlreadyRunningError(holder, pidPath)
      }
      fs.rmSync(pidPath, { force: true })
    }
    throw new Error(`Could not take the pty-host lock at ${pidPath}`)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}
