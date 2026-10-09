import { defineConfig } from '@playwright/test'

// Electron smoke tests. Not part of `pnpm check`: they open a real window. Run with
// `pnpm --filter @bancada/desktop e2e` (builds first).
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
})
