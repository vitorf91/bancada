import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Writes JSON with mode 0600 through a temp file and a rename, so a reader never sees half a file. */
export function writeJsonPrivate(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** The parsed file, or `fallback` when it is missing or unreadable (a corrupt file never crashes the server). */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}
