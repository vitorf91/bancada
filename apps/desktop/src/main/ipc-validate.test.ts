import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  parseAttachOptions,
  parseSignal,
  parseSize,
  parseSpawnRequest,
} from './ipc-validate.js'

describe('parseSpawnRequest', () => {
  it('fills the default size and keeps the optional fields', () => {
    expect(parseSpawnRequest({ cwd: '/tmp', meta: { product: 'acme' } })).toEqual({
      cwd: '/tmp',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      meta: { product: 'acme' },
    })
    expect(
      parseSpawnRequest({ cwd: '/tmp', command: '/bin/sh', args: ['-c', 'true'], env: { A: '1' }, cols: 90, rows: 30 }),
    ).toMatchObject({ command: '/bin/sh', args: ['-c', 'true'], env: { A: '1' }, cols: 90, rows: 30 })
  })

  it('rejects malformed requests', () => {
    expect(() => parseSpawnRequest(null)).toThrow()
    expect(() => parseSpawnRequest({})).toThrow(/cwd/)
    expect(() => parseSpawnRequest({ cwd: '/tmp', cols: 0 })).toThrow(/cols/)
    expect(() => parseSpawnRequest({ cwd: '/tmp', args: [1] })).toThrow(/args/)
    expect(() => parseSpawnRequest({ cwd: '/tmp', env: { A: 1 } })).toThrow(/env/)
  })
})

describe('other parsers', () => {
  it('accepts a scrollback and refuses nonsense', () => {
    expect(parseAttachOptions(undefined)).toEqual({})
    expect(parseAttachOptions({ scrollback: 2000 })).toEqual({ scrollback: 2000 })
    expect(() => parseAttachOptions({ scrollback: -1 })).toThrow()
    expect(() => parseAttachOptions('x')).toThrow()
  })

  it('checks sizes and signals', () => {
    expect(parseSize(100, 40)).toEqual({ cols: 100, rows: 40 })
    expect(() => parseSize(0, 40)).toThrow()
    expect(parseSignal(undefined)).toBeUndefined()
    expect(parseSignal('SIGTERM')).toBe('SIGTERM')
    expect(() => parseSignal('SIGUSR1')).toThrow()
  })
})
