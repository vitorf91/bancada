import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_COLLAPSED_WORKTREES } from './config.js'
import { discoverWorkspace, findRepos } from './discovery.js'
import { addWorktree, git, makeRepo, makeTempDir } from './test-utils.js'
import type { DiscoveredProject, WorkspaceConfig } from './types.js'

let root: string

beforeAll(() => {
  root = makeTempDir()
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function configFor(projects: { path: string; name?: string }[]): WorkspaceConfig {
  return {
    products: [{ id: 'acme', name: 'Acme', color: '#3b82f6', projects }],
    options: { collapsedWorktrees: [...DEFAULT_COLLAPSED_WORKTREES] },
  }
}

async function discoverOne(p: { path: string; name?: string }): Promise<DiscoveredProject> {
  const [product] = await discoverWorkspace(configFor([p]))
  const project = product?.projects[0]
  if (!project) throw new Error('no project')
  return project
}

describe('discoverWorkspace', () => {
  it('lists the main, regular and ephemeral-agent worktrees of a repo', async () => {
    const repo = makeRepo(path.join(root, 'acme-api'))
    const login = addWorktree(repo, path.join(root, 'acme-api-login'), 'feat/login')
    const agent = addWorktree(repo, path.join(repo, '.claude', 'worktrees', 'agent-1'), 'agent/one')
    const detached = path.join(root, 'acme-api-detached')
    git(repo, 'worktree', 'add', '--detach', detached)
    git(repo, 'worktree', 'lock', '--reason', 'testing', login)

    const project = await discoverOne({ path: repo, name: 'API' })
    expect(project).toMatchObject({ kind: 'repo', name: 'API', path: repo })
    const [only] = project.repos
    expect(only?.error).toBeUndefined()
    const byName = Object.fromEntries((only?.worktrees ?? []).map((w) => [w.name, w]))

    expect(byName['acme-api']).toMatchObject({ kind: 'main', branch: 'main', detached: false, collapsed: false })
    expect(byName['acme-api-login']).toMatchObject({
      kind: 'regular',
      branch: 'feat/login',
      locked: true,
      collapsed: false,
    })
    expect(byName['agent-1']).toMatchObject({ kind: 'ephemeral-agent', branch: 'agent/one', collapsed: true })
    expect(byName['acme-api-detached']).toMatchObject({ kind: 'regular', branch: null, detached: true })
    expect(byName['acme-api']?.head).toMatch(/^[0-9a-f]{40}$/)
    expect(login).toBe(byName['acme-api-login']?.path)
    expect(agent).toBe(byName['agent-1']?.path)
  })

  it('flags a worktree whose folder is gone as prunable', async () => {
    const repo = makeRepo(path.join(root, 'prune-repo'))
    const wt = addWorktree(repo, path.join(root, 'prune-wt'), 'gone')
    rmSync(wt, { recursive: true, force: true })
    const project = await discoverOne({ path: repo })
    expect(project.repos[0]?.worktrees.find((w) => w.name === 'prune-wt')?.prunable).toBe(true)
  })

  it('turns a non-git folder with repos up to 2 levels deep into a group', async () => {
    const suite = path.join(root, 'suite')
    makeRepo(path.join(suite, 'alpha'))
    const beta = makeRepo(path.join(suite, 'nested', 'beta'))
    addWorktree(beta, path.join(root, 'beta-wt'), 'beta-feature')
    makeRepo(path.join(suite, 'a', 'b', 'too-deep'))
    mkdirSync(path.join(suite, 'node_modules', 'dep', 'inner'), { recursive: true })

    const project = await discoverOne({ path: suite })
    expect(project.kind).toBe('group')
    expect(project.repos.map((r) => r.name)).toEqual(['alpha', 'beta'])
    expect(project.repos[1]?.worktrees.map((w) => w.kind)).toEqual(['main', 'regular'])
  })

  it('does not search inside a repo found while scanning a group', async () => {
    const group = path.join(root, 'group-no-recurse')
    const outer = makeRepo(path.join(group, 'outer'))
    makeRepo(path.join(outer, 'vendor', 'inner'))
    expect(await findRepos(group)).toEqual([outer])
  })

  it('treats a folder without repos as a plain folder', async () => {
    const notes = path.join(root, 'notes')
    mkdirSync(path.join(notes, 'sub'), { recursive: true })
    const project = await discoverOne({ path: notes })
    expect(project).toMatchObject({ kind: 'folder', name: 'notes', repos: [] })
  })

  it('reports errors per project without failing the rest', async () => {
    const repo = makeRepo(path.join(root, 'healthy'))
    const broken = path.join(root, 'broken')
    mkdirSync(path.join(broken, '.git'), { recursive: true }) // looks like a repo, is not one
    const missing = path.join(root, 'does-not-exist')

    const [product] = await discoverWorkspace(configFor([{ path: missing }, { path: broken }, { path: repo }]))
    const [gone, bad, good] = product?.projects ?? []
    expect(gone).toMatchObject({ kind: 'error', error: 'Path does not exist' })
    expect(bad?.kind).toBe('repo')
    expect(bad?.repos[0]?.error).toMatch(/git worktree list/)
    expect(bad?.repos[0]?.worktrees).toEqual([])
    expect(good?.repos[0]?.worktrees).toHaveLength(1)
  })

  it('reports a file path as an error', async () => {
    const repo = makeRepo(path.join(root, 'file-parent'))
    const project = await discoverOne({ path: path.join(repo, 'README.md') })
    expect(project).toMatchObject({ kind: 'error', error: 'Not a directory' })
  })
})
