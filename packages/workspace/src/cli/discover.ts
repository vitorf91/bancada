import path from 'node:path'
import { DEFAULT_COLLAPSED_WORKTREES } from '../config.js'
import { discoverWorkspace } from '../discovery.js'
import type { DiscoveredRepo } from '../types.js'
import { readOrcaRepos } from './orca-cli.js'

// Usage: pnpm --filter @bancada/workspace discover [--orca | <path>...]
// Read-only. Prints one line of counts per project (worktrees by kind, errors), never branch names or contents.

function countsOf(repos: DiscoveredRepo[]): string {
  const worktrees = repos.flatMap((r) => r.worktrees)
  const by = (kind: string) => worktrees.filter((w) => w.kind === kind).length
  const errors = repos.filter((r) => r.error).length
  return `repos=${repos.length} main=${by('main')} regular=${by('regular')} ephemeral=${by('ephemeral-agent')} prunable=${worktrees.filter((w) => w.prunable).length} locked=${worktrees.filter((w) => w.locked).length} repoErrors=${errors}`
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  let projects: { path: string; name: string }[]
  if (args.includes('--orca')) {
    const repos = await readOrcaRepos()
    if (!repos) {
      console.error('The orca CLI was not found in PATH.')
      return 1
    }
    projects = repos.map((r) => ({ path: r.path, name: r.name }))
  } else {
    projects = args.filter((a) => !a.startsWith('-')).map((p) => ({ path: path.resolve(p), name: path.basename(p) }))
  }
  const [product] = await discoverWorkspace({
    products: [{ id: 'cli', name: 'cli', color: '#888888', projects }],
    options: { collapsedWorktrees: [...DEFAULT_COLLAPSED_WORKTREES] },
  })
  for (const project of product?.projects ?? []) {
    const error = project.error ? ` error=${JSON.stringify(project.error.slice(0, 80))}` : ''
    console.log(`${project.name}  kind=${project.kind}  ${countsOf(project.repos)}${error}`)
  }
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  },
)
