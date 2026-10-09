import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardPath, loadBoard, saveBoard } from './boards.js'

const dirs: string[] = []
async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp('/tmp/bancada-boards-')
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('boards', () => {
  it('returns null when no board was saved', async () => {
    expect(await loadBoard(await tempDataDir(), 'default')).toBeNull()
  })

  it('round-trips a board under <dataDir>/boards and leaves no temp files', async () => {
    const dir = await tempDataDir()
    const board = { version: 1 as const, layout: { grid: { root: {} }, panels: { a: { id: 'a' } } } }
    await saveBoard(dir, 'default', board)
    expect(await loadBoard(dir, 'default')).toEqual(board)
    expect(await readdir(path.join(dir, 'boards'))).toEqual(['default.json'])
  })

  it('treats a corrupt or foreign file as no board', async () => {
    const dir = await tempDataDir()
    await saveBoard(dir, 'default', { version: 1, layout: {} })
    await writeFile(boardPath(dir, 'default'), '{ not json')
    expect(await loadBoard(dir, 'default')).toBeNull()
    await writeFile(boardPath(dir, 'default'), JSON.stringify({ version: 2, layout: {} }))
    expect(await loadBoard(dir, 'default')).toBeNull()
  })

  it('rejects ids that could leave the boards dir and payloads of the wrong shape', async () => {
    const dir = await tempDataDir()
    for (const id of ['../x', 'a/b', '', '.hidden', 'a b']) {
      expect(() => boardPath(dir, id)).toThrow(/Invalid board id/)
    }
    await expect(saveBoard(dir, 'default', { version: 1 })).rejects.toThrow(/Invalid board payload/)
    await expect(saveBoard(dir, 'default', 'text')).rejects.toThrow(/Invalid board payload/)
  })
})
