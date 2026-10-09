import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as pty from 'node-pty'
import { type AsciicastEvent, type AsciicastHeader, byteLength, serializeAsciicast } from './asciicast.js'
import { buildSessionEnv } from './session-env.js'

export interface InputStep {
  /** Seconds after the start of the recording. */
  at: number
  data: string
}

export interface RecordOptions {
  out: string
  cmd: string
  cwd: string
  cols: number
  rows: number
  /** Seconds. The process is stopped when it runs out. */
  duration: number
  input?: InputStep[]
  env?: NodeJS.ProcessEnv
}

export interface RecordResult {
  durationSec: number
  outputBytes: number
  outputEvents: number
  inputEvents: number
  exitCode: number | null
  signal: number | null
  /** True when the process ended on its own before `duration`. */
  exitedEarly: boolean
}

export function parseInputScript(json: string): InputStep[] {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value)) throw new Error('input script must be a JSON array')
  return value.map((step, index) => {
    const s = step as { at?: unknown; data?: unknown }
    if (typeof s?.at !== 'number' || !Number.isFinite(s.at) || s.at < 0 || typeof s.data !== 'string') {
      throw new Error(`input script step ${index} needs a numeric "at" >= 0 and a string "data"`)
    }
    return { at: s.at, data: s.data }
  })
}

/** Runs `cmd` in a PTY for up to `duration` seconds and writes an asciicast v2 file. Must run where node-pty loads. */
export function record(options: RecordOptions): Promise<RecordResult> {
  const env = buildSessionEnv(options.env ?? process.env)
  // Set by the launcher to run node-pty under Electron; the recorded program must not inherit it.
  delete env.ELECTRON_RUN_AS_NODE
  const term = pty.spawn('/bin/sh', ['-c', `exec ${options.cmd}`], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env,
  })
  const events: AsciicastEvent[] = []
  const startedAt = performance.now()
  const now = (): number => (performance.now() - startedAt) / 1000
  let outputBytes = 0
  let outputEvents = 0
  let inputEvents = 0
  let timedOut = false

  term.onData((data) => {
    events.push({ time: now(), code: 'o', data })
    outputBytes += byteLength(data)
    outputEvents++
  })

  const timers: NodeJS.Timeout[] = []
  for (const step of options.input ?? []) {
    timers.push(
      setTimeout(() => {
        events.push({ time: now(), code: 'i', data: step.data })
        inputEvents++
        term.write(step.data)
      }, step.at * 1000),
    )
  }
  let killTimer: NodeJS.Timeout | undefined
  timers.push(
    setTimeout(() => {
      timedOut = true
      term.kill('SIGHUP')
      killTimer = setTimeout(() => process.kill(term.pid, 'SIGKILL'), 3000)
    }, options.duration * 1000),
  )

  const header: AsciicastHeader = {
    version: 2,
    width: options.cols,
    height: options.rows,
    timestamp: Math.floor(Date.now() / 1000),
    command: options.cmd,
    env: { TERM: env.TERM ?? 'xterm-256color', COLORTERM: env.COLORTERM ?? 'truecolor' },
  }

  return new Promise((resolve) => {
    term.onExit(({ exitCode, signal }) => {
      for (const timer of timers) clearTimeout(timer)
      clearTimeout(killTimer)
      const durationSec = now()
      header.duration = Math.round(durationSec * 1e6) / 1e6
      mkdirSync(dirname(options.out), { recursive: true })
      const tmp = `${options.out}.tmp`
      writeFileSync(tmp, serializeAsciicast({ header, events }), { mode: 0o600 })
      renameSync(tmp, options.out)
      resolve({
        durationSec,
        outputBytes,
        outputEvents,
        inputEvents,
        exitCode,
        signal: signal ?? null,
        exitedEarly: !timedOut,
      })
    })
  })
}
