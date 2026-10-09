import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseConfig } from './config.js'
import { parseOrcaRepoList, slugify, suggestConfigToml, tildify, writeIfAbsent } from './orca.js'
import { makeTempDir } from './test-utils.js'

const HOME = '/home/tester'
const SAMPLE = [
  '00000000-0000-4000-8000-000000000001  acme-api  /home/tester/code/acme-api',
  '00000000-0000-4000-8000-000000000002  Acme Web  /home/tester/code/acme web',
  '',
  'not a repo line',
].join('\n')

describe('parseOrcaRepoList', () => {
  it('parses "<id>  <name>  <path>" lines, including spaces in names and paths', () => {
    expect(parseOrcaRepoList(SAMPLE)).toEqual([
      { id: '00000000-0000-4000-8000-000000000001', name: 'acme-api', path: '/home/tester/code/acme-api' },
      { id: '00000000-0000-4000-8000-000000000002', name: 'Acme Web', path: '/home/tester/code/acme web' },
    ])
  })
})

describe('suggestConfigToml', () => {
  it('produces a config that our own parser accepts, with ~ paths and unique ids', () => {
    const repos = [...parseOrcaRepoList(SAMPLE), { id: 'x', name: 'acme-api', path: '/home/tester/other/acme-api' }]
    const toml = suggestConfigToml(repos, HOME)
    expect(toml).toContain('path = "~/code/acme-api"')
    const config = parseConfig(toml, HOME)
    expect(config.products.map((p) => p.id)).toEqual(['acme-api', 'acme-web', 'acme-api-2'])
    expect(config.products[0]?.projects).toEqual([{ path: '/home/tester/code/acme-api' }])
  })
  it('helpers', () => {
    expect(slugify('  Hywork / Product! ')).toBe('hywork-product')
    expect(tildify('/home/tester', HOME)).toBe('~')
    expect(tildify('/srv/x', HOME)).toBe('/srv/x')
  })
})

describe('writeIfAbsent', () => {
  const dir = makeTempDir('bancada-orca-')
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('creates the file (and parents) when absent', async () => {
    const target = path.join(dir, 'nested', 'config.toml')
    expect(await writeIfAbsent(target, 'a = 1\n')).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('a = 1\n')
  })

  it('never overwrites an existing file', async () => {
    const target = path.join(dir, 'existing.toml')
    await mkdir(dir, { recursive: true })
    await writeFile(target, 'keep = true\n')
    expect(await writeIfAbsent(target, 'replaced = true\n')).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('keep = true\n')
  })
})
