import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import {
  type Fixture,
  gridShape,
  launchApp,
  makeFixture,
  makeTempDir,
  readSavedBoard,
  savedOutline,
} from './helpers.js'

// Proof (c): drag a worktree to a pane edge, split, save the layout, restore it after a restart.
// Real HTML5 drag and drop through Playwright's mouse, a real temp config, real temp git repos.

const SCREENSHOT = process.env.BANCADA_E2E_SCREENSHOT

let fixture: Fixture
let dataDir: string
const apps: ElectronApplication[] = []

test.beforeEach(() => {
  fixture = makeFixture()
  dataDir = makeTempDir('bancada-e2e-')
})

test.afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined)
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

function worktree(page: Page, name: string): Locator {
  return page.getByTestId('worktree').filter({ has: page.getByText(name, { exact: true }) })
}

/** Drag a sidebar item onto a point inside a group's content area, given as fractions of its box. */
async function dragOnto(source: Locator, group: Locator, at: { x: number; y: number }): Promise<void> {
  const box = await group.boundingBox()
  if (!box) throw new Error('group has no box')
  // The content area starts below the tab header.
  const header = await group.locator('.dv-tabs-and-actions-container').boundingBox()
  const top = header ? header.height : 0
  await source.dragTo(group, {
    targetPosition: { x: box.width * at.x, y: top + (box.height - top) * at.y },
  })
}

const groups = (page: Page) => page.locator('.dv-groupview')
const panels = (page: Page) => page.getByTestId('panel')

test('the sidebar shows products, projects, groups, folders, worktrees and errors', async () => {
  const { page } = await open()

  await expect(page.getByTestId('product')).toHaveCount(2)
  await expect(page.getByTestId('product').nth(0)).toContainText('Acme')
  await expect(page.getByTestId('product').nth(1)).toContainText('Labs')

  // Repo with worktrees; the agent worktree starts collapsed.
  const api = page.getByTestId('project').filter({ hasText: 'API' })
  await expect(api).toHaveAttribute('data-kind', 'repo')
  await expect(worktree(page, 'acme-api')).toBeVisible()
  await expect(worktree(page, 'acme-api-login')).toContainText('feat/login')
  await expect(worktree(page, 'agent-1')).toHaveCount(0)
  await page.getByTestId('collapsed-toggle').click()
  await expect(worktree(page, 'agent-1')).toContainText('agent/one')

  // Second repo.
  await expect(worktree(page, 'acme-web-nav')).toContainText('fix/nav')

  // Non-git folder with two repos becomes a group.
  const labs = page.getByTestId('project').filter({ has: page.getByText('2 repos') })
  await expect(labs).toHaveAttribute('data-kind', 'group')
  await expect(labs.getByTestId('repo')).toHaveCount(2)
  await expect(labs.locator('[data-repo="alpha"]')).toBeVisible()
  await expect(labs.locator('[data-repo="beta"]')).toBeVisible()

  // Plain folder and a project that failed, reported without breaking the rest.
  await expect(page.getByTestId('folder')).toContainText('notes')
  await expect(page.getByTestId('project').filter({ hasText: 'ghost' })).toContainText('Path does not exist')
})

test('dragging worktrees onto pane edges splits the board, and the layout survives a restart', async () => {
  const { page } = await open()

  // 1. Drop on the empty board: first panel.
  await worktree(page, 'acme-api').dragTo(page.locator('.board'))
  await expect(panels(page)).toHaveCount(1)
  await expect(groups(page)).toHaveCount(1)

  // 2. Right edge of the first panel: two panels side by side.
  await dragOnto(worktree(page, 'acme-api-login'), groups(page).first(), { x: 0.95, y: 0.5 })
  await expect(groups(page)).toHaveCount(2)
  const [left, right] = await Promise.all([groups(page).nth(0).boundingBox(), groups(page).nth(1).boundingBox()])
  if (!left || !right) throw new Error('missing group boxes')
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1)
  expect(Math.abs(right.y - left.y)).toBeLessThan(2)

  // 3. Bottom edge of the second panel: a third panel under it.
  await dragOnto(worktree(page, 'alpha'), groups(page).nth(1), { x: 0.5, y: 0.95 })
  await expect(groups(page)).toHaveCount(3)
  await expect(panels(page)).toHaveCount(3)
  const boxes = await Promise.all([0, 1, 2].map((i) => groups(page).nth(i).boundingBox()))
  const [g0, g1, g2] = boxes
  if (!g0 || !g1 || !g2) throw new Error('missing group boxes')
  const below = [g1, g2].sort((a, b) => a.y - b.y)
  expect(below[1]?.y ?? 0).toBeGreaterThanOrEqual((below[0]?.y ?? 0) + (below[0]?.height ?? 0) - 1)
  expect(Math.abs((below[0]?.x ?? 0) - (below[1]?.x ?? 1000))).toBeLessThan(2)

  // The placeholders carry product color, project, worktree and branch.
  const alpha = panels(page).filter({ hasText: 'alpha' })
  await expect(alpha.getByTestId('panel-worktree')).toHaveText('alpha')
  await expect(alpha.getByTestId('panel-branch')).toContainText('main')
  await expect(alpha.getByTestId('panel-project')).toHaveText('labs')
  await expect(alpha).toHaveCSS('border-top-color', 'rgb(229, 115, 74)')
  const login = panels(page).filter({ hasText: 'acme-api-login' })
  await expect(login.getByTestId('panel-branch')).toContainText('feat/login')
  await expect(login.getByTestId('panel-project')).toHaveText('API')
  await expect(login).toHaveCSS('border-top-color', 'rgb(79, 140, 255)')

  // 4. The board is saved (debounced) to <dataDir>/boards/default.json.
  await expect.poll(() => savedOutline(dataDir)).toBe('H[L,V[L,L]]')
  const before = await readSavedBoard(dataDir)
  if (!before) throw new Error('board not saved')
  const shapeBefore = gridShape(before)
  expect(Object.keys(before.layout.panels)).toHaveLength(3)
  const idsBefore = Object.keys(before.layout.panels).sort()
  const textsBefore = (await panels(page).allInnerTexts()).sort()

  if (SCREENSHOT) {
    await mkdir(path.dirname(SCREENSHOT), { recursive: true })
    await page.screenshot({ path: SCREENSHOT })
  }

  // 5. Quit and relaunch with the same data dir: same panels, same grid.
  await apps.pop()?.close()
  const second = await open()
  await expect(panels(second.page)).toHaveCount(3)
  await expect(groups(second.page)).toHaveCount(3)
  const after = await readSavedBoard(dataDir)
  if (!after) throw new Error('board missing after restart')
  expect(Object.keys(after.layout.panels).sort()).toEqual(idsBefore)
  expect(gridShape(after)).toEqual(shapeBefore)
  expect((await panels(second.page).allInnerTexts()).sort()).toEqual(textsBefore)
  const restored = await Promise.all([0, 1, 2].map((i) => groups(second.page).nth(i).boundingBox()))
  restored.forEach((box, i) => {
    const was = boxes[i]
    expect(Math.abs((box?.x ?? -99) - (was?.x ?? 0))).toBeLessThan(3)
    expect(Math.abs((box?.y ?? -99) - (was?.y ?? 0))).toBeLessThan(3)
  })
})

test('panels move and re-split with dockview drag and drop, and the new layout is saved', async () => {
  const { page } = await open()
  await worktree(page, 'acme-api').dragTo(page.locator('.board'))
  await dragOnto(worktree(page, 'acme-api-login'), groups(page).first(), { x: 0.95, y: 0.5 })
  await dragOnto(worktree(page, 'alpha'), groups(page).nth(1), { x: 0.5, y: 0.95 })
  await expect(groups(page)).toHaveCount(3)

  // Drag the alpha tab (dockview's own drag) onto the left edge of the first group.
  const alphaTab = page.locator('.dv-tab').filter({ hasText: 'alpha' })
  const first = groups(page).first()
  await dragOnto(alphaTab, first, { x: 0.05, y: 0.5 })

  await expect(groups(page)).toHaveCount(3)
  await expect(panels(page)).toHaveCount(3)
  // The debounced save lands after the drop: wait for the final shape, not an intermediate one.
  await expect.poll(() => savedOutline(dataDir)).toBe('H[L,L,L]')
  const board = await readSavedBoard(dataDir)
  if (!board) throw new Error('board not saved')
  const shape = gridShape(board)
  const leftmost = (shape as { children: { panels: string[] }[] }).children[0]?.panels[0] ?? ''
  expect(board.layout.panels[leftmost]?.params?.name).toBe('alpha')
})
