import { type Terminal, TerminalView, WebglBudget } from '@bancada/ui'
import { useEffect, useMemo, useState } from 'react'
import type { BenchConfig } from '../../../shared/api.js'
import { createConnect } from '../terminal-link.js'

/**
 * Proof (a): a 4x4 grid of terminals, fifteen replaying a recorded agent session and one echoing keystrokes, in the
 * window size of the author's laptop. The page measures what only it can see (echo latency, frame pacing, renderer
 * kinds, context losses); the driver in `bench/` measures CPU from outside. See docs/proofs/F0-a.md.
 */

export interface BenchStats {
  frames: number
  /** rAF deltas over 2 x 16.7 ms. */
  dropped: number
  deltas: { median: number; p95: number; max: number }
  echoLatencies: number[]
  echoMissed: number
}

export interface BenchHandle {
  /** Resolves when every terminal is live. */
  ready: Promise<void>
  /** Starts recording frames, echo latencies and context losses. */
  start(): void
  /** Resolves with the number of latencies recorded once there are `count` of them, or when `timeoutMs` passes. */
  waitEcho(count: number, timeoutMs: number): Promise<number>
  noteMissed(): void
  stop(): BenchStats
  renderers(): { webgl: number; dom: number; contextLoss: number; unsupported: number }
  sessionIds(): string[]
}

declare global {
  interface Window {
    __bench?: BenchHandle
  }
}

const FRAME_BUDGET_MS = 1000 / 60
const SESSION_TIMEOUT_MS = 60_000

function limitFor(config: BenchConfig): number {
  if (config.mode === 'all-webgl') return Number.POSITIVE_INFINITY
  if (config.mode === 'all-dom') return 0
  return config.webglLimit
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0
}

let spawned: Promise<string[]> | null = null

/** Once per page, even under StrictMode: sixteen sessions, never thirty-two. */
function spawnSessions(config: BenchConfig): Promise<string[]> {
  spawned ??= Promise.all(
    Array.from({ length: config.terminals }, (_, index) => {
      const echo = index === config.terminals - 1
      return window.bancada
        .spawn({
          cwd: config.cwd,
          command: config.execPath,
          args: echo
            ? [config.echoProgram]
            : [config.replayCli, '--file', config.cast, '--speed', String(config.speed), '--loop'],
          // Electron's binary runs the player and the echo program as plain Node.
          env: { ELECTRON_RUN_AS_NODE: '1' },
          cols: config.cols,
          rows: config.rows,
          meta: { bench: echo ? 'echo' : 'player' },
        })
        .then((session) => session.id)
    }),
  )
  return spawned
}

interface Internal {
  live: Set<number>
  kinds: Map<number, 'webgl' | 'dom'>
  counters: { contextLoss: number; unsupported: number }
  latencies: number[]
  echoWaiters: Set<() => void>
  readyResolve: () => void
  isRecording: () => boolean
}

function createBench(config: BenchConfig, sessions: string[]): { handle: BenchHandle; internal: Internal } {
  const kinds = new Map<number, 'webgl' | 'dom'>()
  const counters = { contextLoss: 0, unsupported: 0 }
  const latencies: number[] = []
  const echoWaiters = new Set<() => void>()
  let missed = 0
  let recording = false
  let frames = 0
  let dropped = 0
  const deltas: number[] = []
  let last = 0
  let rafId = 0
  let readyResolve: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve
  })

  const frame = (now: number): void => {
    if (last) {
      const delta = now - last
      frames++
      deltas.push(delta)
      if (delta > 2 * FRAME_BUDGET_MS) dropped++
    }
    last = now
    rafId = requestAnimationFrame(frame)
  }

  const handle: BenchHandle = {
    ready,
    start() {
      recording = true
      latencies.length = 0
      missed = 0
      frames = 0
      dropped = 0
      deltas.length = 0
      counters.contextLoss = 0
      last = 0
      rafId = requestAnimationFrame(frame)
    },
    waitEcho(count, timeoutMs) {
      return new Promise((resolve) => {
        const finish = (): void => {
          echoWaiters.delete(check)
          clearTimeout(timer)
          resolve(latencies.length)
        }
        const check = (): void => {
          if (latencies.length >= count) finish()
        }
        const timer = setTimeout(finish, timeoutMs)
        echoWaiters.add(check)
        check()
      })
    },
    noteMissed() {
      missed++
    },
    stop() {
      recording = false
      cancelAnimationFrame(rafId)
      const sorted = [...deltas].sort((a, b) => a - b)
      return {
        frames,
        dropped,
        deltas: { median: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? 0 },
        echoLatencies: [...latencies],
        echoMissed: missed,
      }
    },
    renderers() {
      let webgl = 0
      for (const kind of kinds.values()) if (kind === 'webgl') webgl++
      return { webgl, dom: config.terminals - webgl, ...counters }
    },
    sessionIds: () => sessions,
  }
  const internal: Internal = {
    live: new Set(),
    kinds,
    counters,
    latencies,
    echoWaiters,
    readyResolve,
    isRecording: () => recording,
  }
  return { handle, internal }
}

/**
 * The echo probe. The clock starts at the `keydown` that reaches the terminal's input element and stops in the first
 * animation frame after xterm has parsed the echoed glyph: `onWriteParsed` marks the moment the buffer holds it, and
 * xterm paints in the next frame (its render scheduling is `requestAnimationFrame`, so this callback runs after it).
 */
function probeEcho(term: Terminal, internal: Internal): void {
  const textarea = term.textarea
  if (!textarea) return
  let pending: { ch: string; t0: number } | null = null
  textarea.addEventListener(
    'keydown',
    (event) => {
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) pending = { ch: event.key, t0: performance.now() }
    },
    true,
  )
  term.onWriteParsed(() => {
    if (!pending) return
    const buffer = term.buffer.active
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)
    const cell = buffer.cursorX > 0 ? line?.getCell(buffer.cursorX - 1) : undefined
    if (cell?.getChars() !== pending.ch) return
    const { t0 } = pending
    pending = null
    requestAnimationFrame(() => {
      if (!internal.isRecording()) return
      internal.latencies.push(performance.now() - t0)
      for (const waiter of [...internal.echoWaiters]) waiter()
    })
  })
}

export function BenchApp({ config }: { config: BenchConfig }) {
  const [sessions, setSessions] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const budget = useMemo(() => new WebglBudget(limitFor(config)), [config])

  useEffect(() => {
    spawnSessions(config)
      .then(setSessions)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [config])

  const bench = useMemo(() => (sessions ? createBench(config, sessions) : null), [config, sessions])
  const handle = bench?.handle
  const internal = bench?.internal

  useEffect(() => {
    if (!handle) return
    window.__bench = handle
    const timer = setTimeout(() => console.error('bench: terminals not live in time'), SESSION_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [handle])

  const connects = useMemo(() => sessions?.map((id) => createConnect(window.bancada, id)) ?? [], [sessions])

  if (error) return <pre className="bench__error">{error}</pre>
  if (!sessions || !internal) return <div className="bench" />
  const columns = Math.round(Math.sqrt(config.terminals))

  return (
    <div className="bench" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {sessions.map((id, index) => {
        const echo = index === sessions.length - 1
        const connect = connects[index]
        if (!connect) return null
        return (
          <section className="bench__cell" key={id} data-testid="bench-cell" data-echo={echo}>
            <header className="bench__head">
              <span className="bench__swatch" aria-hidden="true" />
              <span>{echo ? 'echo' : `replay ${index + 1}`}</span>
            </header>
            <div className="bench__body">
              <TerminalView
                id={id}
                connect={connect}
                budget={budget}
                active={echo}
                onStatus={(status) => {
                  if (status !== 'live') return
                  internal.live.add(index)
                  if (internal.live.size === sessions.length) internal.readyResolve()
                }}
                onRenderer={(kind, reason) => {
                  internal.kinds.set(index, kind)
                  if (reason === 'context-loss') internal.counters.contextLoss++
                  if (reason === 'unsupported') internal.counters.unsupported++
                }}
                onTerminal={(term) => {
                  if (term && echo) probeEcho(term, internal)
                }}
              />
            </div>
          </section>
        )
      })}
    </div>
  )
}
