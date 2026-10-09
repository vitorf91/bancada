import { describe, expect, it } from 'vitest'
import { formatCodeInput, guessDeviceName, normalizeCode, relativeTime } from './format.js'
import { QUICK_KEYS } from './keys.js'
import { urlBase64ToUint8Array } from './push.js'
import { parseRoute, sessionHash } from './route.js'

describe('routes', () => {
  it('parses the hash routes, including the QR pairing link', () => {
    expect(parseRoute('')).toEqual({ name: 'list' })
    expect(parseRoute('#/')).toEqual({ name: 'list' })
    expect(parseRoute('#/pair')).toEqual({ name: 'pair', code: '' })
    expect(parseRoute('#/pair/ABCD1234')).toEqual({ name: 'pair', code: 'ABCD1234' })
    expect(parseRoute('#/s/abc%20def')).toEqual({ name: 'session', id: 'abc def' })
    expect(parseRoute('#/nonsense')).toEqual({ name: 'list' })
  })

  it('builds the session hash the push payload uses', () => {
    expect(sessionHash('a/b')).toBe('#/s/a%2Fb')
    expect(parseRoute(sessionHash('a/b'))).toEqual({ name: 'session', id: 'a/b' })
  })
})

describe('quick keys', () => {
  it('type the right bytes', () => {
    const byLabel = Object.fromEntries(QUICK_KEYS.map((k) => [k.label, k.data]))
    expect(byLabel).toEqual({
      Esc: '\x1b',
      Tab: '\t',
      '⇧Tab': '\x1b[Z',
      '↑': '\x1b[A',
      '↓': '\x1b[B',
      '⌃C': '\x03',
      '1': '1',
      '2': '2',
      '3': '3',
    })
  })
})

describe('format', () => {
  it('relative time', () => {
    expect(relativeTime(1000, 1500)).toBe('agora')
    expect(relativeTime(0, 12_000)).toBe('há 12 s')
    expect(relativeTime(0, 3 * 60_000)).toBe('há 3 min')
    expect(relativeTime(0, 2 * 3600_000)).toBe('há 2 h')
    expect(relativeTime(0, 4 * 86_400_000)).toBe('há 4 d')
    expect(relativeTime(5000, 0)).toBe('agora')
  })

  it('pairing code input', () => {
    expect(normalizeCode('ab cd-ef12')).toBe('ABCDEF12')
    expect(formatCodeInput('abcdef12xyz')).toBe('ABCD-EF12')
    expect(formatCodeInput('ab')).toBe('AB')
  })

  it('device name guess', () => {
    expect(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone')
    expect(guessDeviceName('Mozilla/5.0 (Macintosh)')).toBe('Navegador')
  })
})

describe('push helper', () => {
  it('decodes the base64url VAPID key into bytes', () => {
    const bytes = urlBase64ToUint8Array('BPk-_w')
    expect([...bytes]).toEqual([4, 249, 62, 255])
  })
})
