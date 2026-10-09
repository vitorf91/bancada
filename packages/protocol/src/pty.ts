/**
 * pty-host protocol v1. See docs/ARCHITECTURE.md for transport and semantics.
 * Changing a type here is a protocol change: bump PTY_PROTOCOL_VERSION when it breaks clients.
 */

export const PTY_PROTOCOL_VERSION = 1

export type SessionId = string

export enum FrameKind {
  /** UTF-8 JSON: ClientRequest (client → host) or HostMessage (host → client). */
  Control = 1,
  /** host → client: u8 idLength | id (ASCII) | raw output bytes. */
  Output = 2,
  /** client → host: u8 idLength | id (ASCII) | raw input bytes. */
  Input = 3,
}

export interface SpawnSpec {
  /** Optional client-chosen id (ASCII, ≤ 64 chars). The host generates one when absent. */
  id?: SessionId
  cwd: string
  /** Defaults to the user's login shell with `-l`. */
  command?: string
  args?: string[]
  /** Applied after the host's hygiene step (see docs/ARCHITECTURE.md). */
  env?: Record<string, string>
  cols: number
  rows: number
  /** Opaque labels the host stores and returns (product, project, worktree, agent kind…). */
  meta?: Record<string, string>
}

export type SessionState = 'running' | 'exited' | 'lost'

export interface SessionInfo {
  id: SessionId
  pid: number | null
  cwd: string
  command: string
  args: string[]
  cols: number
  rows: number
  state: SessionState
  createdAt: number
  exitedAt?: number
  exitCode?: number | null
  signal?: number | null
  title?: string
  lastOutputAt?: number
  meta: Record<string, string>
}

export interface HelloResult {
  protocol: number
  hostVersion: string
  pid: number
  startedAt: number
}

export interface Snapshot {
  id: SessionId
  cols: number
  rows: number
  /** SerializeAddon output: write it into a fresh terminal of the same size to restore the screen and scrollback. */
  data: string
}

export interface ProtocolError {
  code: 'protocol_mismatch' | 'not_found' | 'invalid_request' | 'spawn_failed' | 'sessions_alive' | 'internal'
  message: string
}

export type ClientRequest =
  | { type: 'hello'; reqId: number; client: string; protocol: number }
  | { type: 'spawn'; reqId: number; spec: SpawnSpec }
  | { type: 'list'; reqId: number }
  | { type: 'attach'; reqId: number; id: SessionId; scrollback?: number }
  | { type: 'detach'; reqId: number; id: SessionId }
  | { type: 'resize'; reqId: number; id: SessionId; cols: number; rows: number }
  | { type: 'kill'; reqId: number; id: SessionId; signal?: NodeJS.Signals }
  | { type: 'dispose'; reqId: number; id: SessionId }
  | { type: 'snapshot'; reqId: number; id: SessionId; scrollback?: number }
  | { type: 'shutdown'; reqId: number; force?: boolean }

export type HostEvent =
  | { type: 'event'; event: 'session-added'; session: SessionInfo }
  | { type: 'event'; event: 'session-exited'; id: SessionId; exitCode: number | null; signal: number | null }
  | { type: 'event'; event: 'session-title'; id: SessionId; title: string }
  | { type: 'event'; event: 'session-removed'; id: SessionId }

export type HostMessage =
  | { type: 'reply'; reqId: number; ok: true; result?: unknown }
  | { type: 'reply'; reqId: number; ok: false; error: ProtocolError }
  | HostEvent

/** What every pty-host client exposes (desktop main, server, CLI). */
export interface PtyHostClient {
  hello(): Promise<HelloResult>
  spawn(spec: SpawnSpec): Promise<SessionInfo>
  list(): Promise<SessionInfo[]>
  /** Resolves with the snapshot; `onData` then receives every byte after the cutoff, in order. */
  attach(id: SessionId, onData: (bytes: Uint8Array) => void, opts?: { scrollback?: number }): Promise<Snapshot>
  detach(id: SessionId): Promise<void>
  write(id: SessionId, data: string | Uint8Array): void
  resize(id: SessionId, cols: number, rows: number): Promise<void>
  kill(id: SessionId, signal?: NodeJS.Signals): Promise<void>
  dispose(id: SessionId): Promise<void>
  snapshot(id: SessionId, opts?: { scrollback?: number }): Promise<Snapshot>
  onEvent(listener: (event: HostEvent) => void): () => void
  close(): void
}

/** Env var prefixes and names the host strips from every session (docs/ARCHITECTURE.md, "Session environment hygiene"). */
export const STRIPPED_ENV_PREFIXES = [
  'ORCA_',
  'CLAUDE_CODE_',
  'VSCODE_',
  'ITERM_',
  'GHOSTTY_',
  'KITTY_',
  'WEZTERM_',
] as const
export const STRIPPED_ENV_NAMES = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TMUX',
  'TMUX_PANE',
] as const
