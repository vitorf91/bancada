import { rm } from 'node:fs/promises'
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import {
  connectToHost,
  type Fixture,
  launchApp,
  makeFixture,
  makeTempDir,
  screenText,
  shutdownHost,
} from './helpers.js'

// Real terminals in the app: a shell per dropped worktree, typed into through the page, restored on relaunch.

let fixture: Fixture
let dataDir: string
const apps: ElectronApplication[] = []

test.beforeEach(() => {
  fixture = makeFixture()
  dataDir = makeTempDir('bancada-e2e-')
})

test.afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined)
  await shutdownHost(dataDir, 5000)
  await rm(fixture.root, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(dataDir, fixture.configPath)
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  return { app, page }
}

const worktree = (page: Page, name: string): Locator =>
  page.getByTestId('worktree').filter({ has: page.getByText(name, { exact: true }) })
const panels = (page: Page) => page.getByTestId('panel')

async function sessionOf(panel: Locator): Promise<string> {
  const id = await panel.getAttribute('data-session-id')
  if (!id) throw new Error('panel has no session')
  return id
}

async function waitForPrompt(page: Page, id: string): Promise<void> {
  // SHELL=/bin/sh in the fixture environment: a "$ " prompt.
  await expect.poll(() => screenText(page, id), { timeout: 15_000 }).toMatch(/\$\s*$/)
}

test('a dropped worktree opens a live shell in its directory, and typing, resizing and Shift+Enter work', async () => {
  const { page } = await open()
  await worktree(page, 'acme-api-login').click()
  const panel = panels(page).first()
  await expect(panel).toHaveAttribute('data-status', 'live')
  const id = await sessionOf(panel)
  await waitForPrompt(page, id)

  // The shell starts in the worktree.
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type('pwd; echo sum=$((6*7))\n')
  await expect.poll(() => screenText(page, id)).toContain('sum=42')
  expect(await screenText(page, id)).toContain('acme-api-login')

  // The pty has the size of the xterm that shows it.
  await page.keyboard.type('stty size\n')
  const size = await page.evaluate((sid) => {
    const term = window.__bancadaTerminals?.[sid]
    return term ? `${term.rows} ${term.cols}` : ''
  }, id)
  await expect.poll(() => screenText(page, id)).toContain(size)

  // Shift+Enter sends ESC CR (cat -v shows the escape as ^[), where plain Enter sends CR.
  await page.keyboard.type('cat -v\n')
  await page.keyboard.type('one')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('two\n')
  await expect.poll(() => screenText(page, id)).toContain('one^[')
  await expect.poll(() => screenText(page, id)).toContain('two')
})

test('hidden tabs detach from their session and attach again with the screen intact', async () => {
  const { page } = await open()
  await worktree(page, 'acme-api-login').click()
  const first = panels(page).first()
  const firstId = await sessionOf(first)
  await waitForPrompt(page, firstId)
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type('echo marker-one\n')
  await expect.poll(() => screenText(page, firstId)).toContain('marker-one')

  // A second panel in the same group (tab) hides the first.
  const group = page.locator('.dv-groupview').first()
  const box = await group.boundingBox()
  if (!box) throw new Error('no group box')
  await worktree(page, 'alpha').dragTo(group, { targetPosition: { x: box.width * 0.5, y: box.height * 0.5 } })
  await expect(page.locator('.dv-tab')).toHaveCount(2)
  const status = (id: string) => page.evaluate((sid) => window.__bancadaStatus?.[sid] ?? '', id)
  await expect.poll(() => status(firstId)).toBe('detached')

  await page.locator('.dv-tab').filter({ hasText: 'acme-api-login' }).click()
  await expect.poll(() => status(firstId)).toBe('live')
  await expect.poll(() => screenText(page, firstId)).toContain('marker-one')
})

test('a panel re-attaches to its live session after a relaunch, and shows "sessão encerrada" when the session is gone', async () => {
  const first = await open()
  await worktree(first.page, 'acme-api-login').click()
  await expect(panels(first.page)).toHaveCount(1)
  await worktree(first.page, 'alpha').click()
  await expect(panels(first.page)).toHaveCount(2)
  const ids = await panels(first.page).evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-session-id') ?? ''))
  const [keep, drop] = ids
  if (!keep || !drop) throw new Error('missing sessions')
  await waitForPrompt(first.page, keep)
  await first.page.evaluate((id) => window.bancada.write(id, 'echo before-relaunch\n'), keep)
  await expect.poll(() => screenText(first.page, keep)).toContain('before-relaunch')
  // Let the debounced board save land.
  await first.page.waitForTimeout(800)
  await apps.pop()?.close()

  // One session disappears from the host while the app is closed.
  const client = await connectToHost(dataDir)
  await client.dispose(drop)
  client.close()

  const second = await open()
  await expect(panels(second.page)).toHaveCount(2)
  const live = second.page.locator(`[data-session-id="${keep}"]`)
  const gone = second.page.locator(`[data-session-id="${drop}"]`)
  await expect(live).toHaveAttribute('data-status', 'live')
  await expect.poll(() => screenText(second.page, keep)).toContain('before-relaunch')
  await expect(gone).toHaveAttribute('data-status', 'ended')
  await expect(gone.getByTestId('panel-ended')).toContainText('sessão encerrada')
  await expect(gone.getByTestId('panel-status')).toHaveText('encerrada')

  // The host keeps the other panel working.
  await second.page.evaluate((id) => window.bancada.write(id, 'echo after-relaunch\n'), keep)
  await expect.poll(() => screenText(second.page, keep)).toContain('after-relaunch')
})

test('a session whose process exits shows the ended state with its exit code', async () => {
  const { page } = await open()
  await worktree(page, 'acme-api-login').click()
  const panel = panels(page).first()
  const id = await sessionOf(panel)
  await waitForPrompt(page, id)
  await page.evaluate((sid) => window.bancada.write(sid, 'exit 3\n'), id)
  await expect(panel.getByTestId('panel-ended')).toContainText('sessão encerrada')
  await expect(panel.getByTestId('panel-ended')).toContainText('3')
  await expect(panel.getByTestId('panel-status')).toHaveText('encerrada')
})
