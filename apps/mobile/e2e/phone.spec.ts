import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import { control, type E2eStack, startStack } from './fixture.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const shots = path.resolve(here, '../../../docs/proofs/assets')
const port = Number(process.env.BANCADA_E2E_PORT)

let stack: E2eStack
const consoleProblems: string[] = []

test.beforeAll(async () => {
  stack = await startStack(port)
  for (const name of ['acme-web', 'api-gateway']) {
    const cwd = path.join(stack.workDir, name)
    fs.mkdirSync(cwd)
    const session = await stack.client.spawn({
      cwd,
      command: '/bin/sh',
      args: ['-c', "PS1='$ ' exec /bin/sh"],
      cols: 100,
      rows: 30,
    })
    if (name === 'acme-web') {
      stack.client.write(
        session.id,
        "printf 'build ok\\n42 tests passed\\nWaiting for your answer: [1] yes  [2] no\\n'\r",
      )
    }
  }
})

test.afterAll(async () => {
  await stack?.stop()
})

test.beforeEach(({ page }) => {
  page.on('console', (m) => {
    // WebKit logs every non-2xx fetch. The 401s are the flows under test (unpaired probe, wrong code, revoked device).
    if (m.type() === 'error' && !/status of 401/.test(m.text())) consoleProblems.push(`console.error: ${m.text()}`)
  })
  page.on('pageerror', (e) => consoleProblems.push(`pageerror: ${e.message}`))
})

async function pair(page: Page): Promise<void> {
  const { code } = await control<{ code: string }>(stack.socketPath, 'POST', '/v1/pairing')
  await page.goto('/#/pair')
  await page.getByLabel('Código de pareamento').fill(code)
  await page.getByRole('button', { name: 'Parear' }).click()
  await expect(page.getByRole('heading', { name: 'Sessões' })).toBeVisible()
}

/** No horizontal overflow, and every control a thumb has to hit is at least 44 px. */
async function expectPhoneLayout(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth)
  const small = await page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], input, [role=button]')) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.height < 44 - 0.5 || rect.width < 44 - 0.5) {
        out.push(
          `${el.tagName} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        )
      }
    }
    return out
  })
  expect(small, 'touch targets under 44 px').toEqual([])
}

test.describe
  .serial('phone PWA', () => {
    test('pairing: a wrong code is refused, a real code pairs and lands on the sessions list', async ({ page }) => {
      await page.goto('/#/pair')
      await expect(page.getByRole('heading', { name: 'Parear este aparelho' })).toBeVisible()
      await page.getByLabel('Código de pareamento').fill('ZZZZ-ZZZZ')
      await page.getByRole('button', { name: 'Parear' }).click()
      await expect(page.getByRole('alert')).toContainText('Código inválido')
      await page.screenshot({ path: path.join(shots, 'F0-d-pair.png') })
      await expectPhoneLayout(page)

      await pair(page)
      // the cookie is HttpOnly: the page cannot read it
      expect(await page.evaluate(() => document.cookie)).toBe('')
      const cookies = await page.context().cookies()
      expect(
        cookies.map((c) => ({ name: c.name, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })),
      ).toEqual([{ name: '__Host-bancada_device', httpOnly: true, secure: true, sameSite: 'Strict' }])
    })

    test('sessions list: title or cwd basename, last activity, notifications card', async ({ page }) => {
      await pair(page)
      const rows = page.getByRole('listitem')
      await expect(rows).toHaveCount(2)
      await expect(rows.filter({ hasText: 'acme-web' })).toContainText('última atividade')
      await expect(rows.filter({ hasText: 'api-gateway' })).toBeVisible()
      await expect(page.getByText('2 sessões · 2 ativas')).toBeVisible()
      // iPhone in Safari (not installed): push only works after "Adicionar à Tela de Início"
      await expect(page.getByText('Adicionar à Tela de Início').first()).toBeVisible()
      await expect(page.getByRole('button', { name: 'Ativar notificações' })).toHaveCount(0)
      await page.screenshot({ path: path.join(shots, 'F0-d-list.png') })
      await expectPhoneLayout(page)

      // the cookie survives a reload
      await page.reload()
      await expect(rows).toHaveCount(2)
    })

    test('session view: read view scaled to width, quick keys, type and see the echo', async ({ page }) => {
      await pair(page)
      await page.getByRole('listitem').filter({ hasText: 'acme-web' }).click()
      const terminal = page.getByTestId('terminal')
      await expect(terminal.locator('.xterm-rows')).toContainText('42 tests passed')
      await expect(page.getByRole('status')).toContainText('ao vivo')
      await expect(page.getByRole('status')).toContainText('100×30')

      // 100 columns do not fit a 390 px screen at 12 px: the terminal is scaled down, not resized
      const geometry = await page.evaluate(() => {
        const frame = document.querySelector<HTMLElement>('.term-viewport')
        const box = document.querySelector<HTMLElement>('.term-box')
        const inner = document.querySelector<HTMLElement>('.term-inner')
        if (!frame || !box || !inner) throw new Error('terminal elements missing')
        return {
          frameWidth: frame.clientWidth,
          boxWidth: box.getBoundingClientRect().width,
          scale: new DOMMatrix(getComputedStyle(inner).transform).a,
        }
      })
      expect(geometry.scale).toBeLessThan(1)
      expect(geometry.scale).toBeGreaterThan(0.3)
      expect(Math.abs(geometry.boxWidth - geometry.frameWidth)).toBeLessThan(1.5)

      // type + Enter
      await page.getByLabel('Responder ao agente').fill('echo hello-from-phone')
      await page.getByRole('button', { name: 'Enviar resposta' }).click()
      await expect(terminal.locator('.xterm-rows')).toContainText('hello-from-phone')
      await expect
        .poll(async () => (await terminal.locator('.xterm-rows').innerText()).split('hello-from-phone').length - 1)
        .toBeGreaterThanOrEqual(2)

      // quick keys: read, press "2", Enter
      await page.getByLabel('Responder ao agente').fill('read x; echo picked-$x')
      await page.getByRole('button', { name: 'Enviar resposta' }).click()
      await page.waitForTimeout(300) // the Enter that follows the text is sent 60 ms later; a human is slower than that
      await page.getByRole('button', { name: 'Opção 2' }).click()
      await page.getByRole('button', { name: 'Enviar resposta' }).click() // empty draft sends Enter
      await expect(terminal.locator('.xterm-rows')).toContainText('picked-2')

      // Control C interrupts a running command
      await page.getByLabel('Responder ao agente').fill('sleep 30')
      await page.getByRole('button', { name: 'Enviar resposta' }).click()
      await page.waitForTimeout(300)
      await page.getByRole('button', { name: 'Control C' }).click()
      await page.getByLabel('Responder ao agente').fill('echo after-interrupt')
      await page.getByRole('button', { name: 'Enviar resposta' }).click()
      await expect(terminal.locator('.xterm-rows')).toContainText('after-interrupt')

      await page.locator('.keys').evaluate((el) => el.scrollTo(0, 0))
      await page.screenshot({ path: path.join(shots, 'F0-d-session.png') })
      await expectPhoneLayout(page)

      // the session was resized by nobody
      const info = (await stack.client.list()).find((s) => s.cwd.endsWith('acme-web'))
      expect(info).toMatchObject({ cols: 100, rows: 30 })

      // back to the list
      await page.getByRole('button', { name: 'Voltar para as sessões' }).click()
      await expect(page.getByRole('heading', { name: 'Sessões' })).toBeVisible()
    })

    test('opening a session by its push URL, then revoking the device sends the phone back to pairing', async ({
      page,
    }) => {
      await pair(page)
      const id = (await stack.client.list()).find((s) => s.cwd.endsWith('api-gateway'))?.id ?? ''
      await page.goto(`/#/s/${encodeURIComponent(id)}`)
      await expect(page.getByRole('status')).toContainText('ao vivo')

      const { devices } = await control<{ devices: { id: string }[] }>(stack.socketPath, 'GET', '/v1/devices')
      for (const device of devices) await control(stack.socketPath, 'DELETE', `/v1/devices/${device.id}`)
      await expect(page.getByRole('heading', { name: 'Parear este aparelho' })).toBeVisible({ timeout: 15_000 })
      expect(await page.evaluate(() => fetch('/api/sessions').then((r) => r.status))).toBe(401)
    })

    test('the console stayed clean', () => {
      expect(consoleProblems).toEqual([])
    })
  })
