import { defineConfig } from '@playwright/test'

// Proof (a) bench. Opens a real 1512x982 window and runs for several minutes: `pnpm --filter @bancada/desktop bench`.
export default defineConfig({
  testDir: './bench',
  testMatch: '*.bench.ts',
  timeout: 30 * 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
})
