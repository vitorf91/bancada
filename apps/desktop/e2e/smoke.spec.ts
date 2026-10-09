import { rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp, makeTempDir, shutdownHost } from './helpers.js'

test('launches the built app with its own data dir and a window titled Bancada', async () => {
  // Always a throwaway dir under /tmp: never a real profile, never a path inside the repo.
  const dataDir = makeTempDir('bancada-e2e-')
  // No config on purpose: the app must start empty and never read the real ~/.config/bancada/config.toml.
  const app = await launchApp(dataDir, path.join(dataDir, 'no-config.toml'))
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    expect(await window.title()).toBe('Bancada')
    await expect(window.getByRole('heading', { name: 'Bancada' })).toBeVisible()
    await expect(window.getByText('No config found')).toBeVisible()

    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    expect(userData).toBe(dataDir)
  } finally {
    await app.close()
    // The app starts the pty-host, which outlives it.
    await shutdownHost(dataDir, 5000)
    await rm(dataDir, { recursive: true, force: true })
  }
})
