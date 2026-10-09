import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BoardFile } from '../shared/api.js'

/** Board ids become file names, so only a conservative character set is allowed. */
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Upper bound for one board file; a layout of hundreds of panels is far below this. */
const MAX_BOARD_BYTES = 5 * 1024 * 1024

export function boardsDir(dataDir: string): string {
  return path.join(dataDir, 'boards')
}

export function boardPath(dataDir: string, id: string): string {
  if (!BOARD_ID.test(id)) throw new Error(`Invalid board id: ${JSON.stringify(id)}`)
  return path.join(boardsDir(dataDir), `${id}.json`)
}

export function isBoardFile(value: unknown): value is BoardFile {
  if (typeof value !== 'object' || value === null) return false
  const board = value as Record<string, unknown>
  return board.version === 1 && typeof board.layout === 'object' && board.layout !== null
}

/** The saved board, or null when there is none or it is not a valid board file. */
export async function loadBoard(dataDir: string, id: string): Promise<BoardFile | null> {
  let source: string
  try {
    source = await readFile(boardPath(dataDir, id), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(source)
    return isBoardFile(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Write atomically (temp file in the same dir, then rename), so a crash never leaves half a board. */
export async function saveBoard(dataDir: string, id: string, board: unknown): Promise<void> {
  if (!isBoardFile(board)) throw new Error('Invalid board payload')
  const file = boardPath(dataDir, id)
  const body = JSON.stringify(board, null, 2)
  if (Buffer.byteLength(body) > MAX_BOARD_BYTES) throw new Error('Board is too large')
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, body, { mode: 0o600 })
  await rename(tmp, file)
}
