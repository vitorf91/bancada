import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { listWorktrees, type RawWorktree } from './git.js'
import { matchesAnyGlob } from './glob.js'
import type {
  DiscoveredProduct,
  DiscoveredProject,
  DiscoveredRepo,
  OptionsConfig,
  ProjectConfig,
  WorkspaceConfig,
  Worktree,
  WorktreeKind,
} from './types.js'

/** How deep inside a non-git folder we look for repos: its children (1) and their children (2). */
export const GROUP_SCAN_DEPTH = 2

const SKIPPED_DIRS = new Set(['node_modules'])

/** True when `dir` holds a git checkout (`.git` is a directory, or a file for linked worktrees and submodules). */
async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    await stat(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIPPED_DIRS.has(e.name))
    .map((e) => path.join(dir, e.name))
    .sort()
}

/** Git repos under `root`, at most `depth` levels down. A repo is never searched inside. */
export async function findRepos(root: string, depth = GROUP_SCAN_DEPTH): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string, remaining: number): Promise<void> {
    if (remaining === 0) return
    for (const child of await subdirs(dir)) {
      if (await hasGitEntry(child)) found.push(child)
      else await walk(child, remaining - 1)
    }
  }
  await walk(root, depth)
  return found
}

export function classifyWorktree(raw: RawWorktree, index: number): WorktreeKind {
  if (index === 0 && !raw.bare) return 'main'
  if (raw.path.split(path.sep).join('/').includes('/.claude/worktrees/')) return 'ephemeral-agent'
  return 'regular'
}

function toWorktree(raw: RawWorktree, index: number, options: OptionsConfig): Worktree {
  return {
    path: raw.path,
    name: path.basename(raw.path),
    branch: raw.branch,
    head: raw.head,
    detached: raw.detached,
    locked: raw.locked,
    prunable: raw.prunable,
    kind: classifyWorktree(raw, index),
    collapsed: matchesAnyGlob(options.collapsedWorktrees, raw.path),
  }
}

async function discoverRepo(repoPath: string, options: OptionsConfig): Promise<DiscoveredRepo> {
  const repo: DiscoveredRepo = { path: repoPath, name: path.basename(repoPath), worktrees: [] }
  try {
    const raws = await listWorktrees(repoPath)
    repo.worktrees = raws
      .map((raw, index) => ({ raw, index }))
      .filter(({ raw }) => !raw.bare)
      .map(({ raw, index }) => toWorktree(raw, index, options))
  } catch (error) {
    repo.error = error instanceof Error ? error.message : String(error)
  }
  return repo
}

async function discoverProject(project: ProjectConfig, options: OptionsConfig): Promise<DiscoveredProject> {
  const name = project.name ?? path.basename(project.path)
  const base = { path: project.path, name }
  try {
    const info = await stat(project.path)
    if (!info.isDirectory()) return { ...base, kind: 'error', repos: [], error: 'Not a directory' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      ...base,
      kind: 'error',
      repos: [],
      error: code === 'ENOENT' ? 'Path does not exist' : `Cannot read path: ${String(error)}`,
    }
  }
  try {
    if (await hasGitEntry(project.path)) {
      return { ...base, kind: 'repo', repos: [await discoverRepo(project.path, options)] }
    }
    const repoPaths = await findRepos(project.path)
    if (repoPaths.length === 0) return { ...base, kind: 'folder', repos: [] }
    return { ...base, kind: 'group', repos: await Promise.all(repoPaths.map((p) => discoverRepo(p, options))) }
  } catch (error) {
    return { ...base, kind: 'error', repos: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Discover every product's projects. Failures are reported on the project (`kind: 'error'`, or `error` on an
 * inner repo) and never reject the whole call.
 */
export async function discoverWorkspace(config: WorkspaceConfig): Promise<DiscoveredProduct[]> {
  return Promise.all(
    config.products.map(async (product) => ({
      id: product.id,
      name: product.name,
      color: product.color,
      projects: await Promise.all(product.projects.map((project) => discoverProject(project, config.options))),
    })),
  )
}
