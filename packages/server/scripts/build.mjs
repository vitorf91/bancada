// Bundles the server (and its CLI) into dist/server.mjs, an ES module for Electron's node mode.
//   node scripts/build.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const outfile = path.join(root, 'dist', 'server.mjs')

export async function buildServer() {
  await build({
    entryPoints: [path.join(root, 'src/main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // CommonJS dependencies (ws, web-push) call require() and the bundled pty-host client reads import.meta.url.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    target: 'node24',
    // Optional native speedups of ws, and electron (only the launcher imports it).
    external: ['electron', 'bufferutil', 'utf-8-validate'],
    logLevel: 'warning',
    legalComments: 'none',
  })
  return outfile
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`built ${path.relative(process.cwd(), await buildServer())}`)
}
