import type { HostEvent, SessionInfo } from '@bancada/protocol'
import type { DiscoveryResult } from '@bancada/workspace/types'

/** IPC channel names. Main registers a handler for each; the preload invokes them. */
export const IPC = {
  discoverWorkspace: 'workspace:discover',
  loadBoard: 'board:load',
  saveBoard: 'board:save',
  terminalSpawn: 'terminal:spawn',
  terminalList: 'terminal:list',
  terminalAttach: 'terminal:attach',
  terminalDetach: 'terminal:detach',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalKill: 'terminal:kill',
  /** main → renderer: carries the MessagePort of one attached view (transferred, see `PORT_WINDOW_CHANNEL`). */
  terminalPort: 'terminal:port',
  /** main → renderer: session lifecycle events from the pty-host. */
  terminalEvent: 'terminal:event',
  benchConfig: 'bench:config',
} as const

/** `type` of the window message the preload posts to the page to hand over a view's MessagePort. */
export const PORT_WINDOW_CHANNEL = 'bancada:terminal-port'

/** Lines of history an attach asks for by default (measured ~4 ms to serialize, against 30 ms+ for 10,000). */
export const DEFAULT_ATTACH_SCROLLBACK = 2000

/** A saved board: dockview's own serialized layout plus a format version. */
export interface BoardFile {
  version: 1
  /** `DockviewApi.toJSON()` output. Opaque to main; only the renderer reads it. */
  layout: unknown
}

/** What the renderer may ask the pty-host to start. Sessions are shells unless `command` says otherwise. */
export interface TerminalSpawnRequest {
  cwd: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cols?: number
  rows?: number
  /** Opaque labels the host stores with the session (product, worktree…). */
  meta?: Record<string, string>
}

export interface TerminalAttachOptions {
  scrollback?: number
}

/**
 * What flows through the MessagePort of an attached view, main → renderer. Terminal output is a bare `Uint8Array`
 * (no JSON, no base64); everything else is one of these objects. The first message is always a `snapshot`.
 */
export type TerminalPortMessage =
  | { t: 'snapshot'; cols: number; rows: number; data: string }
  | { t: 'exit'; exitCode: number | null; signal: number | null }
  | { t: 'closed' }

export interface BenchConfig {
  mode: 'all-webgl' | 'all-dom' | 'hybrid'
  /** WebGL slots for `hybrid`: the focused terminal plus the most recently active ones. */
  webglLimit: number
  /** Replay speed for the 15 player terminals. */
  speed: number
  terminals: number
  cols: number
  rows: number
  execPath: string
  replayCli: string
  cast: string
  echoProgram: string
  cwd: string
}

/** What the renderer may ask of the main process. Exposed as `window.bancada` by the preload. */
export interface BancadaApi {
  /** Read the config file and scan its projects. Never rejects: problems are in the result. */
  discoverWorkspace(): Promise<DiscoveryResult>
  /** The saved board, or null when none exists (or the file is unreadable). */
  loadBoard(id: string): Promise<BoardFile | null>
  saveBoard(id: string, board: BoardFile): Promise<void>

  /** Starts a session in the pty-host. */
  spawn(request: TerminalSpawnRequest): Promise<SessionInfo>
  list(): Promise<SessionInfo[]>
  /**
   * Attaches one view (`viewId`, chosen by the caller) to a session. Resolves once main has posted the view's
   * MessagePort, which reaches the page as a window message (`PORT_WINDOW_CHANNEL`); a MessagePort cannot cross
   * contextBridge, so `src/renderer/src/terminal-link.ts` wraps both halves. Rejects with code `not_found` for a
   * session that does not exist.
   */
  attach(sessionId: string, viewId: string, options?: TerminalAttachOptions): Promise<void>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  /** Stops the stream to one view. The session keeps running. */
  detach(viewId: string): Promise<void>
  kill(sessionId: string, signal?: 'SIGHUP' | 'SIGTERM' | 'SIGKILL'): Promise<void>
  onSessionEvent(listener: (event: HostEvent) => void): () => void

  /** True in an e2e run (`BANCADA_TEST_HOOKS=1`): the renderer then exposes its terminals on `window`. */
  testMode: boolean
  /** The bench configuration, or null in a normal run. */
  benchConfig(): Promise<BenchConfig | null>
}
