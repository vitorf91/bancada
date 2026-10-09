import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

// The renderer loads nothing but its own bundle (fonts and CSS included). Inline styles are needed by dockview and
// xterm. Added at build time only: the dev server's HMR runtime injects inline scripts.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'"

const contentSecurityPolicy = (): Plugin => ({
  name: 'bancada:csp',
  apply: 'build',
  transformIndexHtml: (html: string) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`,
    ),
})

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        // A sandboxed preload cannot be an ES module: emit CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), contentSecurityPolicy()],
  },
})
