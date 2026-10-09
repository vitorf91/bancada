import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  fallbackSocketDir,
  resolveDataDir,
  resolvePidPath,
  resolveProfile,
  resolveSocketPath,
  SOCKET_PATH_LIMIT_BYTES,
} from './data-dir.js'

const homeDir = '/Users/tester'

describe('resolveProfile', () => {
  it('defaults to "default"', () => {
    expect(resolveProfile({})).toBe('default')
    expect(resolveProfile({ BANCADA_PROFILE: '' })).toBe('default')
    expect(resolveProfile({ BANCADA_PROFILE: '   ' })).toBe('default')
  })

  it('uses BANCADA_PROFILE', () => {
    expect(resolveProfile({ BANCADA_PROFILE: 'dev' })).toBe('dev')
  })

  it('rejects profiles that would escape the Bancada dir', () => {
    for (const bad of ['..', '.', 'a/b', '../x', 'a\\b']) {
      expect(() => resolveProfile({ BANCADA_PROFILE: bad })).toThrow(/Invalid BANCADA_PROFILE/)
    }
  })
})

describe('resolveDataDir', () => {
  it('defaults to ~/Library/Application Support/Bancada/default', () => {
    expect(resolveDataDir({ env: {}, homeDir })).toBe('/Users/tester/Library/Application Support/Bancada/default')
  })

  it('puts a profile in its own dir', () => {
    expect(resolveDataDir({ env: { BANCADA_PROFILE: 'dev' }, homeDir })).toBe(
      '/Users/tester/Library/Application Support/Bancada/dev',
    )
  })

  it('lets BANCADA_DATA_DIR override the profile dir', () => {
    expect(
      resolveDataDir({ env: { BANCADA_DATA_DIR: '/tmp/bancada-test-abc', BANCADA_PROFILE: 'dev' }, homeDir }),
    ).toBe('/tmp/bancada-test-abc')
  })

  it('rejects a relative BANCADA_DATA_DIR', () => {
    expect(() => resolveDataDir({ env: { BANCADA_DATA_DIR: 'relative/dir' }, homeDir })).toThrow(/absolute/)
  })
})

describe('resolveSocketPath', () => {
  it('lives in the data dir when the path is short enough', () => {
    expect(resolveSocketPath('/tmp/bancada-test-abc', 501)).toBe('/tmp/bancada-test-abc/pty-host.sock')
  })

  it('stays in the data dir at 99 bytes and falls back at 100', () => {
    const suffix = '/pty-host.sock'
    const at99 = `/${'a'.repeat(SOCKET_PATH_LIMIT_BYTES - 1 - suffix.length - 1)}`
    expect(Buffer.byteLength(at99 + suffix)).toBe(SOCKET_PATH_LIMIT_BYTES - 1)
    expect(resolveSocketPath(at99, 501)).toBe(at99 + suffix)

    const at100 = `${at99}a`
    expect(Buffer.byteLength(at100 + suffix)).toBe(SOCKET_PATH_LIMIT_BYTES)
    expect(resolveSocketPath(at100, 501)).not.toBe(at100 + suffix)
  })

  it('falls back to /tmp/bancada-<uid>/<12 hex of sha1(dataDir)>.sock', () => {
    const dataDir = `/Users/tester/Library/Application Support/Bancada/${'long-profile-'.repeat(6)}`
    const digest = createHash('sha1').update(dataDir).digest('hex').slice(0, 12)
    const socket = resolveSocketPath(dataDir, 501)
    expect(socket).toBe(`/tmp/bancada-501/${digest}.sock`)
    expect(socket.startsWith(`${fallbackSocketDir(501)}/`)).toBe(true)
    expect(Buffer.byteLength(socket)).toBeLessThan(SOCKET_PATH_LIMIT_BYTES)
  })

  it('counts bytes, not characters', () => {
    // 'é' is 2 bytes in UTF-8, so this path is under the limit in characters and over it in bytes.
    const dataDir = `/${'é'.repeat(40)}${'a'.repeat(30)}`
    const preferred = `${dataDir}/pty-host.sock`
    expect(preferred.length).toBeLessThan(SOCKET_PATH_LIMIT_BYTES)
    expect(Buffer.byteLength(preferred)).toBeGreaterThanOrEqual(SOCKET_PATH_LIMIT_BYTES)
    expect(resolveSocketPath(dataDir, 501)).toMatch(/^\/tmp\/bancada-501\/[0-9a-f]{12}\.sock$/)
  })

  it('gives different data dirs different fallback sockets', () => {
    const a = resolveSocketPath(`/x/${'a'.repeat(120)}`, 501)
    const b = resolveSocketPath(`/x/${'b'.repeat(120)}`, 501)
    expect(a).not.toBe(b)
  })
})

describe('resolvePidPath', () => {
  it('is pty-host.pid in the data dir', () => {
    expect(resolvePidPath('/tmp/bancada-test-abc')).toBe('/tmp/bancada-test-abc/pty-host.pid')
  })
})
