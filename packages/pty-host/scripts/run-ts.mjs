// Runs a TypeScript script under system Node: bundles it with esbuild into dist/, then executes the bundle.
//   node scripts/run-ts.mjs scripts/proof-survive.ts [script args...]
// (Workspace packages export TypeScript source with `.js` import specifiers, which Node cannot run directly.)
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [script, ...rest] = process.argv.slice(2)
if (!script) {
  console.error('usage: node scripts/run-ts.mjs <script.ts> [args...]')
  process.exit(2)
}

const outfile = path.join(root, 'dist', `${path.basename(script, path.extname(script))}.mjs`)
await build({
  entryPoints: [path.resolve(root, script)],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  target: 'node24',
  external: ['electron'],
  logLevel: 'warning',
})
const result = spawnSync(process.execPath, [outfile, ...rest], { stdio: 'inherit', cwd: root })
process.exit(result.status ?? 1)
