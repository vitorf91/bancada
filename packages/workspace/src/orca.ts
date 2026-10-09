import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface OrcaRepo {
  id: string
  name: string
  path: string
}

/**
 * Parse `orca repo list`: one repo per line, `<id>  <name>  <path>`, columns separated by two or more spaces.
 * Lines that do not fit (headers, blank lines, notes) are skipped.
 */
export function parseOrcaRepoList(output: string): OrcaRepo[] {
  const repos: OrcaRepo[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s{2,}(.+?)\s{2,}((?:\/|~).*?)\s*$/.exec(line.trim())
    if (match) repos.push({ id: match[1] as string, name: match[2] as string, path: match[3] as string })
  }
  return repos
}

const PALETTE = ['#4f8cff', '#e5734a', '#3fb67a', '#b072e0', '#d9a441', '#3ab0c4', '#e05d8a', '#8a94a6']

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'project'
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** `/Users/me/code/x` becomes `~/code/x` so the suggestion does not hard-code a home dir. */
export function tildify(p: string, homeDir: string): string {
  if (p === homeDir) return '~'
  return p.startsWith(`${homeDir}/`) ? `~/${p.slice(homeDir.length + 1)}` : p
}

/** A starting-point config: one product per Orca repo. The user is expected to regroup them by hand. */
export function suggestConfigToml(repos: OrcaRepo[], homeDir: string): string {
  const lines = [
    '# Suggested by `pnpm --filter @bancada/workspace import-orca`.',
    '# One product per Orca repo; regroup projects into products and adjust colors as you like.',
    '',
    '[options]',
    '# collapsedWorktrees = ["**/.claude/worktrees/**"]',
    '',
  ]
  const usedIds = new Map<string, number>()
  repos.forEach((repo, index) => {
    const base = slugify(repo.name)
    const count = (usedIds.get(base) ?? 0) + 1
    usedIds.set(base, count)
    lines.push(
      '[[products]]',
      `id = ${tomlString(count === 1 ? base : `${base}-${count}`)}`,
      `name = ${tomlString(repo.name)}`,
      `color = ${tomlString(PALETTE[index % PALETTE.length] as string)}`,
      '',
      '[[products.projects]]',
      `path = ${tomlString(tildify(repo.path, homeDir))}`,
      '',
    )
  })
  return lines.join('\n')
}

/** Write `content` to `target` only if it does not exist yet. Never overwrites. Returns false if it exists. */
export async function writeIfAbsent(target: string, content: string): Promise<boolean> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  try {
    await writeFile(target, content, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}
