import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// In dev the PWA is served by Vite and the API by the local server (`pnpm --filter @bancada/server start`).
const apiTarget = `http://127.0.0.1:${process.env.BANCADA_SERVER_PORT ?? '7655'}`

function listFiles(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')]
  })
}

/**
 * Emits `sw.js` from `src/sw.js` with the list of files of this build (bundle and public dir) and a hash of their
 * contents, so the worker caches exactly the shell it was built with and every new build replaces the old cache.
 */
function serviceWorker(): Plugin {
  let publicDir = ''
  return {
    name: 'bancada-service-worker',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const files = new Map<string, string | Uint8Array>()
        for (const item of Object.values(bundle)) {
          if (item.fileName.endsWith('.map')) continue
          files.set(item.fileName, item.type === 'chunk' ? item.code : item.source)
        }
        if (publicDir && fs.existsSync(publicDir)) {
          for (const name of listFiles(publicDir)) files.set(name, fs.readFileSync(path.join(publicDir, name)))
        }
        const names = [...files.keys()].sort()
        const hash = createHash('sha256')
        for (const name of names) {
          hash.update(`${name}\0`)
          hash.update(files.get(name) ?? '')
          hash.update('\0')
        }
        const shell = names.map((name) => (name === 'index.html' ? '/' : `/${name}`))

        const template = fs.readFileSync(path.resolve(import.meta.dirname, 'src/sw.js'), 'utf8')
        const version = "'__BANCADA_SW_VERSION__'"
        const list = "['__BANCADA_SW_SHELL__']"
        if (!template.includes(version) || !template.includes(list)) throw new Error('src/sw.js lost its placeholders')
        const source = template
          .replace(version, JSON.stringify(hash.digest('hex').slice(0, 16)))
          .replace(list, JSON.stringify(shell))
        this.emitFile({ type: 'asset', fileName: 'sw.js', source })
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  build: {
    rollupOptions: {
      output: { manualChunks: (id) => (id.includes('@xterm') ? 'xterm' : undefined) },
    },
  },
  server: { proxy: { '/api': { target: apiTarget, ws: true, changeOrigin: false } } },
})
