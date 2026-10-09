import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import { type Fixture, launchApp, makeFixture, makeTempDir, screenText, shutdownHost } from './helpers.js'

// Real captures of the board with terminals at the real window size (the width of the design mockup's 1512x982 screen, less the menu bar and window chrome) and a smaller
// one, generic fixture data only. Also checks what a capture cannot: clean console, no horizontal overflow, and
// desktop targets of at least 32 px. BANCADA_E2E_SCREENSHOT=<dir> keeps the PNGs.

const SHOTS = process.env.BANCADA_E2E_SCREENSHOT

let fixture: Fixture
let dataDir: string
let app: ElectronApplication | null = null

test.beforeEach(() => {
  fixture = makeFixture()
  dataDir = makeTempDir('bancada-e2e-')
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  await shutdownHost(dataDir, 5000)
  await rm(fixture.root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

const worktree = (page: Page, name: string): Locator =>
  page.getByTestId('worktree').filter({ has: page.getByText(name, { exact: true }) })

async function dropOn(page: Page, name: string, group: Locator, at: { x: number; y: number }): Promise<void> {
  const box = await group.boundingBox()
  const header = await group.locator('.dv-tabs-and-actions-container').boundingBox()
  if (!box) throw new Error('group has no box')
  const top = header?.height ?? 0
  await worktree(page, name).dragTo(group, {
    targetPosition: { x: box.width * at.x, y: top + (box.height - top) * at.y },
  })
}

test('the board with four terminals renders cleanly at the real window sizes', async () => {
  const errors: string[] = []
  app = await launchApp(dataDir, fixture.configPath)
  const page = await app.firstWindow()
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1512, 900))
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('sidebar')).toBeVisible()

  const groups = page.locator('.dv-groupview')
  await worktree(page, 'acme-api').dragTo(page.locator('.board'))
  await dropOn(page, 'acme-api-login', groups.first(), { x: 0.95, y: 0.5 })
  const groupOf = (title: string) => groups.filter({ hasText: title })
  await dropOn(page, 'alpha', groupOf('acme-api').first(), { x: 0.5, y: 0.95 })
  await dropOn(page, 'acme-web-nav', groupOf('acme-api-login'), { x: 0.5, y: 0.95 })
  await expect(page.getByTestId('panel')).toHaveCount(4)
  await expect(page.locator('[data-testid="panel"][data-status="live"]')).toHaveCount(4)

  // Generic, colorful output in every shell.
  const ids = await page
    .getByTestId('panel')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-session-id') ?? ''))
  for (const [index, id] of ids.entries()) {
    await expect.poll(() => screenText(page, id), { timeout: 15_000 }).toMatch(/\$\s*$/)
    await page.evaluate(
      ([sid, n]) =>
        window.bancada.write(
          sid ?? '',
          `PS1='$ '; clear; ls; printf '\\033[32mok\\033[0m build %s \\033[33mwarn\\033[0m \\033[31mfail\\033[0m \\033[34mnote\\033[0m\\n' ${n}; pwd; git status -sb\n`,
        ),
      [id, String(index + 1)] as const,
    )
  }
  await expect.poll(() => screenText(page, ids[3] ?? '')).toContain('##')
  await page.locator('.xterm-helper-textarea').first().focus()

  for (const size of [
    { width: 1512, height: 900 },
    { width: 1100, height: 720 },
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height),
      size,
    )
    await page.waitForTimeout(600)

    // No horizontal page scroll.
    const overflow = await page
      .locator('html')
      .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)

    // Desktop targets of at least 32 px: sidebar rows, icon buttons and tabs.
    for (const selector of ['.row--item', '.row--toggle', '.icon-button', '.dv-tab']) {
      const boxes = await page
        .locator(selector)
        .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().height))
      for (const height of boxes) expect(height, `${selector} height`).toBeGreaterThanOrEqual(32)
    }

    // Every terminal fills its panel body (fit worked).
    for (const id of ids) {
      const fit = await page.evaluate((sid) => {
        const term = window.__bancadaTerminals?.[sid]
        return term ? { rows: term.rows, cols: term.cols } : null
      }, id)
      expect(fit?.cols ?? 0).toBeGreaterThan(20)
      expect(fit?.rows ?? 0).toBeGreaterThan(4)
    }

    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true })
      await page.screenshot({ path: path.join(SHOTS, `board-${size.width}x${size.height}.png`) })
    }
  }

  expect(errors).toEqual([])
})
