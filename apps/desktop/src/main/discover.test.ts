import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discover } from './discover.js'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp('/tmp/bancada-discover-')
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('discover', () => {
  it('reports a missing config as empty, not as an error', async () => {
    const dir = await tempDir()
    const result = await discover({ env: { BANCADA_CONFIG: path.join(dir, 'none.toml') }, homeDir: dir })
    expect(result).toMatchObject({ configMissing: true, products: [] })
    expect(result.configError).toBeUndefined()
  })

  it('reports an invalid config in the result instead of throwing', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'config.toml')
    await writeFile(file, 'products = [')
    const result = await discover({ env: { BANCADA_CONFIG: file }, homeDir: dir })
    expect(result.configError).toMatch(/Invalid TOML/)
    expect(result.products).toEqual([])
  })

  it('scans plain folders from the config', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'config.toml')
    await writeFile(file, `[[products]]\nid = "a"\nname = "A"\ncolor = "#fff"\nprojects = [{ path = "${dir}" }]\n`)
    const result = await discover({ env: { BANCADA_CONFIG: file }, homeDir: dir })
    expect(result.products[0]?.projects[0]).toMatchObject({ kind: 'folder', path: dir })
  })
})
