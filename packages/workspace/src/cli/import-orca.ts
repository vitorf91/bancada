import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolveConfigPath } from '../config.js'
import { suggestConfigToml, writeIfAbsent } from '../orca.js'
import { readOrcaRepos } from './orca-cli.js'

// Usage: pnpm --filter @bancada/workspace import-orca [--write]
// Prints a suggested config.toml built from `orca repo list`. With --write it creates the config file, but only
// when it does not exist yet: an existing config is never overwritten.

async function main(): Promise<number> {
  const write = process.argv.includes('--write')
  const home = homedir()
  const target = resolveConfigPath({ env: process.env, homeDir: home })

  const repos = await readOrcaRepos()
  if (repos === null) {
    console.error('The orca CLI was not found in PATH, so there is nothing to import.')
    return 1
  }
  if (repos.length === 0) {
    console.error('`orca repo list` returned no repositories.')
    return 1
  }
  const toml = suggestConfigToml(repos, home)

  if (!write) {
    const exists = await access(target).then(
      () => true,
      () => false,
    )
    process.stdout.write(toml)
    if (exists) console.error(`\n(${target} already exists and would not be overwritten by --write.)`)
    return 0
  }
  if (!(await writeIfAbsent(target, toml))) {
    console.error(`${target} already exists; not overwriting it. Merge the suggestion by hand (run without --write).`)
    return 1
  }
  console.log(`Wrote ${target} with ${repos.length} products. Edit it to group projects into products.`)
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
