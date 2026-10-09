import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In dev the PWA is served by Vite and the API by the local server (`pnpm --filter @bancada/server start`).
const apiTarget = `http://127.0.0.1:${process.env.BANCADA_SERVER_PORT ?? '7655'}`

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: { manualChunks: (id) => (id.includes('@xterm') ? 'xterm' : undefined) },
    },
  },
  server: { proxy: { '/api': { target: apiTarget, ws: true, changeOrigin: false } } },
})
