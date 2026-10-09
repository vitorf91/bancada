import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, expandPath, loadConfig, parseConfig, resolveConfigPath } from './config.js'

const HOME = '/home/tester'

describe('resolveConfigPath', () => {
  it('defaults to ~/.config/bancada/config.toml', () => {
    expect(resolveConfigPath({ env: {}, homeDir: HOME })).toBe('/home/tester/.config/bancada/config.toml')
  })
  it('honors BANCADA_CONFIG and rejects relative values', () => {
    expect(resolveConfigPath({ env: { BANCADA_CONFIG: '/tmp/x/c.toml' }, homeDir: HOME })).toBe('/tmp/x/c.toml')
    expect(() => resolveConfigPath({ env: { BANCADA_CONFIG: 'c.toml' }, homeDir: HOME })).toThrow(ConfigError)
  })
})

describe('expandPath', () => {
  it('expands ~ and strips trailing slashes', () => {
    expect(expandPath('~/code/acme-api/', HOME, 'p')).toBe('/home/tester/code/acme-api')
    expect(expandPath('~', HOME, 'p')).toBe('/home/tester')
  })
  it('rejects relative paths', () => {
    expect(() => expandPath('code/acme', HOME, 'p')).toThrow(/absolute/)
  })
})

describe('parseConfig', () => {
  it('parses products, projects and options', () => {
    const config = parseConfig(
      `
[options]
worktreeRoot = "~/code/.worktrees"
collapsedWorktrees = ["**/tmp/**"]

[[products]]
id = "acme"
name = "Acme"
color = "#3b82f6"

[[products.projects]]
path = "~/code/acme-api"
name = "API"

[[products.projects]]
path = "/srv/acme-web"
`,
      HOME,
    )
    expect(config.options).toEqual({ worktreeRoot: '/home/tester/code/.worktrees', collapsedWorktrees: ['**/tmp/**'] })
    expect(config.products).toEqual([
      {
        id: 'acme',
        name: 'Acme',
        color: '#3b82f6',
        projects: [{ path: '/home/tester/code/acme-api', name: 'API' }, { path: '/srv/acme-web' }],
      },
    ])
  })

  it('defaults the collapsed globs to agent worktrees and accepts an empty file', () => {
    const config = parseConfig('', HOME)
    expect(config.products).toEqual([])
    expect(config.options.collapsedWorktrees).toEqual(['**/.claude/worktrees/**'])
    expect(config.options.worktreeRoot).toBeUndefined()
  })

  it.each([
    ['broken TOML', 'products = [', /Invalid TOML/],
    ['missing name', '[[products]]\nid = "a"\ncolor = "red"', /products\[0\]\.name/],
    ['bad id', '[[products]]\nid = "a b"\nname = "A"\ncolor = "red"', /products\[0\]\.id/],
    [
      'duplicate id',
      '[[products]]\nid = "a"\nname = "A"\ncolor = "red"\n[[products]]\nid = "a"\nname = "B"\ncolor = "red"',
      /duplicate id/,
    ],
    [
      'relative project path',
      '[[products]]\nid = "a"\nname = "A"\ncolor = "red"\nprojects = [{ path = "x" }]',
      /absolute/,
    ],
    ['bad globs', '[options]\ncollapsedWorktrees = "x"', /collapsedWorktrees/],
  ])('rejects %s with a readable message', (_label, source, message) => {
    expect(() => parseConfig(source, HOME)).toThrow(message)
  })
})

describe('loadConfig', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  it('reports a missing file as missing, not as an error', async () => {
    const dir = await mkdtemp('/tmp/bancada-cfg-')
    dirs.push(dir)
    const loaded = await loadConfig(path.join(dir, 'nope.toml'), HOME)
    expect(loaded.missing).toBe(true)
    expect(loaded.config.products).toEqual([])
  })

  it('reads a file from disk', async () => {
    const dir = await mkdtemp('/tmp/bancada-cfg-')
    dirs.push(dir)
    const file = path.join(dir, 'config.toml')
    await writeFile(file, '[[products]]\nid = "a"\nname = "A"\ncolor = "red"\n')
    const loaded = await loadConfig(file, HOME)
    expect(loaded.missing).toBe(false)
    expect(loaded.config.products.map((p) => p.id)).toEqual(['a'])
  })
})
