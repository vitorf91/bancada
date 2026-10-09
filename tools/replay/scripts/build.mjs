// Bundles the CLI and the recorder into dist/. node-pty and @xterm/headless stay external (native addon, CJS).
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

export async function buildAll() {
  await build({
    absWorkingDir: root,
    entryPoints: { cli: 'src/cli.ts', 'record-main': 'src/record-main.ts' },
    outdir: 'dist',
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['node-pty', '@xterm/headless'],
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'warning',
  })
}

if (import.meta.url === `file://${process.argv[1]}`) await buildAll()
