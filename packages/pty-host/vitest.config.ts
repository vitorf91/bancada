import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Tests launch real hosts through Electron's node mode; allow for a slow first start.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: ['./src/test-support/global-setup.ts'],
  },
})
