import { defineConfig } from 'vitest/config'

// Every workspace package is a Vitest project (named after its package.json).
// A package configures itself with its own vitest.config.ts / vite.config.ts when it needs to.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'tools/*'],
  },
})
