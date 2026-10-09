import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceStore, hashToken } from './devices.js'
import { PAIRING_TTL_MS, PairingService } from './pairing.js'

let dir: string
let clock: number
const now = (): number => clock

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bancada-u-'))
  clock = 1_000_000
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function setup(options: { maxFailures?: number } = {}) {
  const devices = new DeviceStore(path.join(dir, 'devices.json'), now)
  const pairing = new PairingService({ devices, now, ...options })
  return { devices, pairing }
}

describe('pairing codes', () => {
  it('are 8 characters from the Crockford alphabet and expire after 5 minutes', () => {
    const { pairing } = setup()
    const { code, expiresAt, ttlMs } = pairing.createCode()
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(ttlMs).toBe(5 * 60_000)
    expect(expiresAt).toBe(clock + PAIRING_TTL_MS)
  })

  it('can be redeemed once', () => {
    const { pairing } = setup()
    const { code } = pairing.createCode()
    const first = pairing.redeem(code, 'iPhone')
    expect(first.ok).toBe(true)
    const second = pairing.redeem(code, 'iPhone')
    expect(second).toEqual({ ok: false, reason: 'invalid' })
  })

  it('stop working at the expiry instant, and an expired attempt burns the code', () => {
    const { pairing } = setup()
    const live = pairing.createCode()
    clock += PAIRING_TTL_MS - 1
    expect(pairing.redeem(live.code, 'a').ok).toBe(true)

    const stale = pairing.createCode()
    clock += PAIRING_TTL_MS
    expect(pairing.redeem(stale.code, 'a')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('accept what a person types: lowercase, no dash, O for 0, I or L for 1', () => {
    const { pairing } = setup()
    const { code } = pairing.createCode()
    const typed = code.replace('-', ' ').toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l')
    expect(pairing.redeem(typed, 'a').ok).toBe(true)
  })

  it('reject garbage without throwing', () => {
    const { pairing } = setup({ maxFailures: 100 })
    for (const bad of [undefined, null, 42, '', 'x'.repeat(500), {}]) {
      expect(pairing.redeem(bad, 'a')).toEqual({ ok: false, reason: 'invalid' })
    }
  })

  it('rate limit failed attempts globally: after 5 in a minute even the right code is refused', () => {
    const { pairing } = setup({ maxFailures: 5 })
    const { code } = pairing.createCode()
    for (let i = 0; i < 5; i++) expect(pairing.redeem('WRONG000', 'a')).toEqual({ ok: false, reason: 'invalid' })
    const blocked = pairing.redeem(code, 'a')
    expect(blocked.ok).toBe(false)
    expect(blocked.ok === false && blocked.reason).toBe('rate_limited')
    clock += 61_000
    expect(pairing.redeem(code, 'a').ok).toBe(true)
  })

  it('keeps at most 5 codes outstanding (the oldest is dropped)', () => {
    const { pairing } = setup()
    const codes = Array.from({ length: 6 }, () => pairing.createCode().code)
    expect(pairing.redeem(codes[0], 'a').ok).toBe(false)
    expect(pairing.redeem(codes[5], 'a').ok).toBe(true)
  })
})

describe('device store', () => {
  it('stores only the sha256 of the token, in a 0600 file, with name and timestamps', () => {
    const { devices } = setup()
    const { device, token } = devices.create('iPhone de teste')
    const file = path.join(dir, 'devices.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const text = fs.readFileSync(file, 'utf8')
    expect(text).not.toContain(token)
    const stored = JSON.parse(text) as {
      devices: { id: string; name: string; tokenHash: string; createdAt: number; lastSeenAt: number }[]
    }
    expect(stored.devices).toEqual([
      { id: device.id, name: 'iPhone de teste', tokenHash: hashToken(token), createdAt: clock, lastSeenAt: clock },
    ])
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('authenticates by token, updates last-seen, and survives a restart', () => {
    const { devices } = setup()
    const { token } = devices.create('a')
    clock += 5000
    expect(devices.authenticate(token)?.lastSeenAt).toBe(clock)
    devices.flush()
    const reopened = new DeviceStore(path.join(dir, 'devices.json'), now)
    expect(reopened.authenticate(token)?.name).toBe('a')
    expect(reopened.authenticate('nope')).toBeNull()
    expect(reopened.authenticate(undefined)).toBeNull()
  })

  it('revokes at once, notifies listeners, and resolves id prefixes', () => {
    const { devices } = setup()
    const { device, token } = devices.create('a')
    const revoked: string[] = []
    devices.onRevoked((d) => revoked.push(d.id))
    expect(devices.resolveId(device.id.slice(0, 8))).toBe(device.id)
    expect(devices.revoke(device.id)).toBe(true)
    expect(revoked).toEqual([device.id])
    expect(devices.authenticate(token)).toBeNull()
    expect(devices.revoke(device.id)).toBe(false)
    expect(new DeviceStore(path.join(dir, 'devices.json'), now).list()).toEqual([])
  })

  it('sanitizes the device name', () => {
    const { devices } = setup()
    expect(devices.create('  x\u0000y\n'.padEnd(200, 'z')).device.name).toHaveLength(60)
    expect(devices.create(42).device.name).toBe('Aparelho')
  })
})
