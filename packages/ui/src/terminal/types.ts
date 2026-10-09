/** What a terminal view needs from a transport. The desktop implements it over a MessagePort, the phone later over a WebSocket. */

export interface TerminalSnapshot {
  cols: number
  rows: number
  /** Serialized screen and scrollback: write it into a fresh terminal of `cols` x `rows`. */
  data: string
}

export type TerminalEvent =
  /** The stream restarted (another view of the same session attached): reset and write this. */
  | ({ type: 'snapshot' } & TerminalSnapshot)
  /** The process ended; the session (and its last screen) may still exist in the host. */
  | { type: 'exit'; exitCode: number | null; signal: number | null }
  /** The transport went away (host connection lost). */
  | { type: 'closed' }

export interface TerminalLink {
  /** The screen at attach time. Every byte after it arrives through `onOutput`, in order, with no gap and no overlap. */
  readonly snapshot: TerminalSnapshot
  onOutput(listener: (bytes: Uint8Array) => void): void
  onEvent(listener: (event: TerminalEvent) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Detach: stop the stream for this view. The session keeps running. */
  close(): void
}

export interface TerminalConnectOptions {
  /** Lines of history requested with the snapshot. */
  scrollback: number
}

export type TerminalConnect = (options: TerminalConnectOptions) => Promise<TerminalLink>

/** `connect` rejects with this when the session does not exist (any more). */
export class TerminalGoneError extends Error {
  override name = 'TerminalGoneError'
}

export type TerminalStatus = 'connecting' | 'live' | 'detached' | 'ended' | 'error'

export interface TerminalStatusDetail {
  exitCode?: number | null
  message?: string
}

export type TerminalRendererKind = 'webgl' | 'dom'
export type TerminalRendererReason = 'granted' | 'budget' | 'context-loss' | 'unsupported' | 'init'

/** Attach this many lines of history by default: measured ~4 ms to serialize, against 30 ms and more for 10,000. */
export const DEFAULT_SCROLLBACK_LINES = 2000
