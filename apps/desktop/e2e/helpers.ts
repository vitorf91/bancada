import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { type ElectronApplication, _electron as electron } from '@playwright/test'

const appDir = path.resolve(import.meta.dirname, '..')
// Resolved from this package so pnpm's strict layout finds the Electron binary.
const electronPath = createRequire(import.meta.url)('electron') as string

/** A throwaway directory directly under /tmp (the worktree path is too long for sockets, see ARCHITECTURE.md). */
export function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join('/tmp', prefix)))
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

function git(cwd: string, ...args: string[]): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...IDENTITY,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  execFileSync('git', args, { cwd, env, stdio: 'ignore' })
}

function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--initial-branch=main')
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init')
  return dir
}

function addWorktree(repo: string, target: string, branch: string): void {
  mkdirSync(path.dirname(target), { recursive: true })
  git(repo, 'worktree', 'add', '-b', branch, target)
}

export interface Fixture {
  root: string
  configPath: string
}

/**
 * Generic fixture, nothing from the real machine:
 * Acme: acme-api (repo with a feature worktree and a collapsed agent worktree), acme-web (repo with one worktree).
 * Labs: labs (non-git folder with two repos, one nested), notes (plain folder), ghost (path that does not exist).
 */
export function makeFixture(): Fixture {
  const root = makeTempDir('bancada-e2e-fx-')
  const api = makeRepo(path.join(root, 'acme-api'))
  addWorktree(api, path.join(root, 'acme-api-login'), 'feat/login')
  addWorktree(api, path.join(api, '.claude', 'worktrees', 'agent-1'), 'agent/one')
  const web = makeRepo(path.join(root, 'acme-web'))
  addWorktree(web, path.join(root, 'acme-web-nav'), 'fix/nav')
  makeRepo(path.join(root, 'labs', 'alpha'))
  makeRepo(path.join(root, 'labs', 'nested', 'beta'))
  mkdirSync(path.join(root, 'notes'))
  writeFileSync(path.join(root, 'notes', 'todo.md'), '- nothing\n')

  const configPath = path.join(root, 'config.toml')
  writeFileSync(
    configPath,
    `
[[products]]
id = "acme"
name = "Acme"
color = "#4f8cff"
projects = [
  { path = "${root}/acme-api", name = "API" },
  { path = "${root}/acme-web" },
]

[[products]]
id = "labs"
name = "Labs"
color = "#e5734a"
projects = [
  { path = "${root}/labs" },
  { path = "${root}/notes" },
  { path = "${root}/ghost" },
]
`,
  )
  return { root, configPath }
}

/** The parent shell may carry variables that would break or redirect the app (Electron-as-Node, other IDEs). */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('ORCA_') || key.startsWith('CLAUDE')) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

export function launchApp(dataDir: string, configPath: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: [appDir],
    env: cleanEnv({ BANCADA_DATA_DIR: dataDir, BANCADA_CONFIG: configPath }),
  })
}

// --- Saved board inspection -------------------------------------------------------------------------------

interface GridNode {
  type: 'branch' | 'leaf'
  data: GridNode[] | { views: string[]; id?: string }
}

export interface SavedBoard {
  version: number
  layout: {
    grid: { root: GridNode; orientation: string; width?: number; height?: number }
    panels: Record<string, { id: string; params?: { name?: string; branch?: string | null } }>
  }
}

export async function readSavedBoard(dataDir: string): Promise<SavedBoard | null> {
  try {
    return JSON.parse(await readFile(path.join(dataDir, 'boards', 'default.json'), 'utf8')) as SavedBoard
  } catch {
    return null
  }
}

/** The grid reduced to what a user perceives: nesting, orientation and which panels sit in each group. */
export type Shape = { split: string; children: Shape[] } | { panels: string[] }

export function gridShape(board: SavedBoard): Shape {
  const orientationAt = (depth: number): string => {
    const root = board.layout.grid.orientation
    return depth % 2 === 0 ? root : root === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL'
  }
  const walk = (node: GridNode, depth: number): Shape =>
    node.type === 'leaf'
      ? { panels: (node.data as { views: string[] }).views }
      : { split: orientationAt(depth), children: (node.data as GridNode[]).map((c) => walk(c, depth + 1)) }
  return walk(board.layout.grid.root, 0)
}

/** Compact form of a shape for polling and assertions: `H[L,V[L,L]]` is a row whose second cell is a column of two. */
export function outline(shape: Shape): string {
  if ('panels' in shape) return 'L'
  return `${shape.split === 'HORIZONTAL' ? 'H' : 'V'}[${shape.children.map(outline).join(',')}]`
}

/** Outline of the saved board, or '' when nothing is saved yet. */
export async function savedOutline(dataDir: string): Promise<string> {
  const board = await readSavedBoard(dataDir)
  return board ? outline(gridShape(board)) : ''
}
