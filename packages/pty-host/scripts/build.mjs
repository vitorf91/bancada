// Bundles a TypeScript entry into one CommonJS file for Electron's node mode.
//   node scripts/build.mjs [--entry src/host/main.ts] [--out dist/pty-host.cjs] [--external a,b]
// The host bundle keeps node-pty external (a native addon cannot be bundled); prepareRuntime copies it next to the bundle.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values: args } = parseArgs({
  options: { entry: { type: 'string' }, out: { type: 'string' }, external: { type: 'string' } },
})

const entry = path.resolve(root, args.entry ?? 'src/host/main.ts')
const outfile = path.resolve(root, args.out ?? 'dist/pty-host.cjs')
const external = args.external !== undefined ? args.external.split(',').filter(Boolean) : ['node-pty']

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external,
  logLevel: 'warning',
  legalComments: 'none',
})
console.log(`built ${path.relative(process.cwd(), outfile)}`)
