import type { DiscoveryResult } from '@bancada/workspace/types'

/** IPC channel names. Main registers a handler for each; the preload invokes them. */
export const IPC = {
  discoverWorkspace: 'workspace:discover',
  loadBoard: 'board:load',
  saveBoard: 'board:save',
} as const

/** A saved board: dockview's own serialized layout plus a format version. */
export interface BoardFile {
  version: 1
  /** `DockviewApi.toJSON()` output. Opaque to main; only the renderer reads it. */
  layout: unknown
}

/** What the renderer may ask of the main process. Exposed as `window.bancada` by the preload. */
export interface BancadaApi {
  /** Read the config file and scan its projects. Never rejects: problems are in the result. */
  discoverWorkspace(): Promise<DiscoveryResult>
  /** The saved board, or null when none exists (or the file is unreadable). */
  loadBoard(id: string): Promise<BoardFile | null>
  saveBoard(id: string, board: BoardFile): Promise<void>
}
