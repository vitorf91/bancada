import { execFile } from 'node:child_process'

/** One record of `git worktree list --porcelain`, before classification. */
export interface RawWorktree {
  path: string
  head: string
  /** Short branch name, or null when detached (or bare). */
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

/** Git prints "unusual" paths C-quoted (`"/a/b\303\251"`); undo that. */
function unquote(value: string): string {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value
  const bytes: number[] = []
  const inner = value.slice(1, -1)
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charAt(i)
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'))
      continue
    }
    const next = inner.charAt(++i)
    const octal = inner.slice(i, i + 3)
    if (/^[0-3][0-7]{2}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8))
      i += 2
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }
      bytes.push(...Buffer.from(map[next] ?? next, 'utf8'))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Parse `git worktree list --porcelain`. The first record is the main worktree. */
export function parseWorktreePorcelain(output: string): RawWorktree[] {
  const result: RawWorktree[] = []
  for (const block of output.split(/\r?\n\r?\n/)) {
    let current: RawWorktree | undefined
    for (const line of block.split(/\r?\n/)) {
      if (line === '') continue
      const space = line.indexOf(' ')
      const key = space === -1 ? line : line.slice(0, space)
      const value = space === -1 ? '' : line.slice(space + 1)
      if (key === 'worktree') {
        current = {
          path: unquote(value),
          head: '',
          branch: null,
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        }
        continue
      }
      if (!current) continue
      if (key === 'HEAD') current.head = value
      else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
      else if (key === 'detached') current.detached = true
      else if (key === 'bare') current.bare = true
      else if (key === 'locked') current.locked = true
      else if (key === 'prunable') current.prunable = true
    }
    if (current) result.push(current)
  }
  return result
}

/** Environment for read-only git calls: no inherited GIT_* repo pointers, no prompts, no index lock. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

export interface RunGitOptions {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** Run git in `cwd` and resolve with stdout. Rejects with git's stderr in the message. */
export function runGit(cwd: string, args: string[], { timeoutMs = 15_000, env }: RunGitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: env ?? gitEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message
          reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${detail}`))
          return
        }
        resolve(stdout)
      },
    )
  })
}

export async function listWorktrees(repoPath: string): Promise<RawWorktree[]> {
  return parseWorktreePorcelain(await runGit(repoPath, ['worktree', 'list', '--porcelain']))
}
