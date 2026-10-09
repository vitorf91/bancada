import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const appDir = path.resolve(import.meta.dirname, '..')
// Resolved from this package so pnpm's strict layout finds the Electron binary.
const electronPath = createRequire(import.meta.url)('electron') as string

test('launches the built app with its own data dir and a window titled Bancada', async () => {
  // Always a throwaway dir under /tmp: never a real profile, never a path inside the repo.
  const dataDir = await mkdtemp('/tmp/bancada-e2e-')
  // The parent shell may carry ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inherited } = process.env
  const app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    env: { ...inherited, BANCADA_DATA_DIR: dataDir } as Record<string, string>,
  })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    expect(await window.title()).toBe('Bancada')
    await expect(window.getByRole('heading', { name: 'Bancada' })).toBeVisible()

    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    expect(userData).toBe(dataDir)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
