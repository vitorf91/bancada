import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** A throwaway directory under /tmp (never inside the repo). Returned as a real path: /tmp is a symlink on macOS. */
export function makeTempDir(prefix = 'bancada-ws-'): string {
  return realpathSync(mkdtempSync(path.join('/tmp', prefix)))
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

export function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_IDENTITY,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !(key in GIT_IDENTITY) && key !== 'GIT_CONFIG_GLOBAL' && key !== 'GIT_CONFIG_SYSTEM')
      delete env[key]
  }
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** `git init` + one commit on branch `main`. */
export function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--initial-branch=main')
  writeFileSync(path.join(dir, 'README.md'), '# test\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init')
  return dir
}

/** `git worktree add -b <branch> <target>` from `repo`. */
export function addWorktree(repo: string, target: string, branch: string): string {
  mkdirSync(path.dirname(target), { recursive: true })
  git(repo, 'worktree', 'add', '-b', branch, target)
  return target
}
