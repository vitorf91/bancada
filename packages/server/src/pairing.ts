import { createHash, randomInt } from 'node:crypto'
import type { DeviceInfo, DeviceStore } from './devices.js'

/** Crockford base32: no I, L, O, U, so a code read off a screen survives a typo-prone eye. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8
export const PAIRING_TTL_MS = 5 * 60_000
const MAX_OUTSTANDING = 5

export type RedeemResult =
  | { ok: true; token: string; device: DeviceInfo }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'rate_limited'; retryAfterMs: number }

export interface PairingOptions {
  devices: DeviceStore
  now?: () => number
  ttlMs?: number
  /** Failed attempts allowed per window before every attempt (even a right one) is refused. Default 5 per minute. */
  maxFailures?: number
  windowMs?: number
}

function normalize(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/** `ABCD-EFGH` for display. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * One-time pairing codes: 8 characters (40 bits), valid 5 minutes, redeemable once. Every request reaches the
 * server from 127.0.0.1 (`tailscale serve` proxies from localhost), so the failure limit is global, not per address.
 * Codes live in memory only: restarting the server forgets them.
 */
export class PairingService {
  private readonly codes = new Map<string, number>()
  private failures: number[] = []
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxFailures: number
  private readonly windowMs: number

  constructor(private readonly options: PairingOptions) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? PAIRING_TTL_MS
    this.maxFailures = options.maxFailures ?? 5
    this.windowMs = options.windowMs ?? 60_000
  }

  createCode(): { code: string; expiresAt: number; ttlMs: number } {
    this.sweep()
    while (this.codes.size >= MAX_OUTSTANDING) {
      const oldest = this.codes.keys().next().value
      if (oldest === undefined) break
      this.codes.delete(oldest)
    }
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
    const expiresAt = this.now() + this.ttlMs
    this.codes.set(hashCode(code), expiresAt)
    return { code: formatCode(code), expiresAt, ttlMs: this.ttlMs }
  }

  redeem(rawCode: unknown, deviceName: unknown): RedeemResult {
    const now = this.now()
    this.failures = this.failures.filter((t) => now - t < this.windowMs)
    if (this.failures.length >= this.maxFailures) {
      const first = this.failures[0] ?? now
      return { ok: false, reason: 'rate_limited', retryAfterMs: Math.max(1, first + this.windowMs - now) }
    }
    const key = typeof rawCode === 'string' && rawCode.length <= 64 ? hashCode(normalize(rawCode)) : null
    const expiresAt = key ? this.codes.get(key) : undefined
    if (!key || expiresAt === undefined) return this.fail()
    this.codes.delete(key) // single use, whether or not it is still valid
    if (expiresAt <= now) return this.fail()
    const { device, token } = this.options.devices.create(deviceName)
    return { ok: true, token, device }
  }

  private fail(): RedeemResult {
    this.failures.push(this.now())
    return { ok: false, reason: 'invalid' }
  }

  private sweep(): void {
    const now = this.now()
    for (const [key, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(key)
  }
}
