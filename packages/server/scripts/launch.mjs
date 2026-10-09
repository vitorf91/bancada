// Launches a server command the way the pty-host is launched: under Electron's binary in node mode.
//   node scripts/launch.mjs <start|pair|devices|revoke|notify> [args...]
// `start` first makes sure the pty-host bundle, the server bundle and the PWA are built, then passes their paths
// (and node-pty's) to the server through the environment.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from './build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(root, '../..')
const require = createRequire(import.meta.url)

const [command, ...rest] = process.argv.slice(2)
if (!command) {
  console.error('usage: node scripts/launch.mjs <start|pair|devices|revoke|notify> [args...]')
  process.exit(2)
}

function run(file, args, cwd) {
  const result = spawnSync(file, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
// pnpm hands the script a literal "--" before the user's arguments; the server's own parser handles the rest.

const bundle = await buildServer()
if (command === 'start') {
  const hostPackage = path.join(repo, 'packages/pty-host')
  run(process.execPath, [path.join(hostPackage, 'scripts/build.mjs')], hostPackage)
  env.BANCADA_PTY_HOST_BUNDLE ??= path.join(hostPackage, 'dist/pty-host.cjs')
  env.BANCADA_NODE_PTY_DIR ??= path.dirname(
    createRequire(path.join(hostPackage, 'package.json')).resolve('node-pty/package.json'),
  )
  const pwaDir = path.join(repo, 'apps/mobile/dist')
  if (!env.BANCADA_PWA_DIR) {
    if (!fs.existsSync(path.join(pwaDir, 'index.html'))) {
      console.log('building the PWA (apps/mobile)')
      run('pnpm', ['--filter', '@bancada/mobile', 'build'], repo)
    }
    env.BANCADA_PWA_DIR = pwaDir
  }
}

const child = spawn(require('electron'), [bundle, command, ...rest], { stdio: 'inherit', env })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
