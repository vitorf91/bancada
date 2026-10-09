import fs from 'node:fs'
import path from 'node:path'

const MAX_LOG_BYTES = 5 * 1024 * 1024

export interface HostLogger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/**
 * Appends one line per event to the log file. Callers pass ids, counts and timings only: never terminal
 * input or output, command lines, or environment values.
 */
export function createLogger(logPath: string): HostLogger {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 })
  try {
    if (fs.statSync(logPath).size > MAX_LOG_BYTES) fs.renameSync(logPath, `${logPath}.1`)
  } catch {
    // no log yet
  }
  const fd = fs.openSync(logPath, 'a', 0o600)
  const write = (level: string, message: string, fields?: Record<string, unknown>): void => {
    const line = `${new Date().toISOString()} ${level} ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}\n`
    try {
      fs.writeSync(fd, line)
    } catch {
      // logging must never take the host down
    }
  }
  return {
    info: (message, fields) => write('INFO', message, fields),
    warn: (message, fields) => write('WARN', message, fields),
    error: (message, fields) => write('ERROR', message, fields),
  }
}
