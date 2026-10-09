// Launcher for the recorder. node-pty only ever runs under Electron's binary in node mode (see AGENTS.md):
// this script builds the bundle, then starts it with ELECTRON_RUN_AS_NODE=1. It never rebuilds native code.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAll } from './build.mjs'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// node-pty's prebuilt spawn-helper is shipped without the executable bit; posix_spawnp fails until it has it.
const prebuilds = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds')
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}

await buildAll()

const electron = require('electron')
const child = spawn(electron, [join(root, 'dist/record-main.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
