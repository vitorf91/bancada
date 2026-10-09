import { describe, expect, it } from 'vitest'
import { FrameKind, PTY_PROTOCOL_VERSION, STRIPPED_ENV_NAMES, STRIPPED_ENV_PREFIXES } from './index.js'

describe('pty-host protocol v1', () => {
  it('is protocol version 1', () => {
    expect(PTY_PROTOCOL_VERSION).toBe(1)
  })

  it('keeps the frame kind wire values', () => {
    expect(FrameKind.Control).toBe(1)
    expect(FrameKind.Output).toBe(2)
    expect(FrameKind.Input).toBe(3)
  })

  it('strips terminal-app and agent variables from sessions', () => {
    expect(STRIPPED_ENV_NAMES).toContain('CLAUDECODE')
    expect(STRIPPED_ENV_PREFIXES).toContain('ORCA_')
  })
})
