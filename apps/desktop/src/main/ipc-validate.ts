import type { SpawnSpec } from '@bancada/protocol'
import type { TerminalAttachOptions } from '../shared/api.js'

/** Spawn defaults for a pane that has not been measured yet; the view resizes the session right after attaching. */
export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 32

const MAX_DIMENSION = 1000
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_SCROLLBACK = 100_000
const SIGNALS = new Set(['SIGHUP', 'SIGTERM', 'SIGKILL'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringRecord(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new Error(`${name} must be an object of strings`)
  }
  return value as Record<string, string>
}

function dimension(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_DIMENSION}`)
  }
  return value
}

export function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error(`Invalid ${name}`)
  return value
}

/** The renderer is sandboxed but still untrusted input: check the shape before it reaches the host. */
export function parseSpawnRequest(value: unknown): SpawnSpec {
  if (!isRecord(value)) throw new Error('spawn needs a request object')
  const spec: SpawnSpec = {
    cwd: asString(value.cwd, 'cwd'),
    cols: dimension(value.cols, 'cols', DEFAULT_COLS),
    rows: dimension(value.rows, 'rows', DEFAULT_ROWS),
  }
  if (value.command !== undefined) spec.command = asString(value.command, 'command')
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.some((a) => typeof a !== 'string')) throw new Error('Invalid args')
    spec.args = value.args as string[]
  }
  const env = stringRecord(value.env, 'env')
  if (env) spec.env = env
  const meta = stringRecord(value.meta, 'meta')
  if (meta) spec.meta = meta
  return spec
}

export function parseAttachOptions(value: unknown): { scrollback?: number } {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error('Invalid attach options')
  const scrollback = (value as TerminalAttachOptions).scrollback
  if (scrollback === undefined) return {}
  if (
    typeof scrollback !== 'number' ||
    !Number.isInteger(scrollback) ||
    scrollback < 0 ||
    scrollback > MAX_SCROLLBACK
  ) {
    throw new Error('Invalid scrollback')
  }
  return { scrollback }
}

export function parseWrite(data: unknown): string {
  if (typeof data !== 'string' || data.length > MAX_WRITE_BYTES) throw new Error('Invalid input')
  return data
}

export function parseSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  return { cols: dimension(cols, 'cols', 0) || 80, rows: dimension(rows, 'rows', 0) || 24 }
}

export function parseSignal(value: unknown): NodeJS.Signals | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !SIGNALS.has(value)) throw new Error('Invalid signal')
  return value as NodeJS.Signals
}
