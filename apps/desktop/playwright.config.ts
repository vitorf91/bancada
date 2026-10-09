import { defineConfig } from '@playwright/test'

// Electron smoke tests. Not part of `pnpm check`: they open a real window. Run with
// `pnpm --filter @bancada/desktop e2e` (builds first).
export default defineConfig({
  testDir: './e2e',
  // Proof (b) rebuilds the app and takes minutes: `pnpm --filter @bancada/desktop proof:survive` runs it.
  testIgnore: process.env.BANCADA_PROOF_B_OUT ? [] : ['**/survive.spec.ts'],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
})
