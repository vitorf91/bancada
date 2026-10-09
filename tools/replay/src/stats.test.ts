import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseAsciicast } from './asciicast.js'
import { computeStats, EscapeCounter, formatStats } from './stats.js'

const tiny = parseAsciicast(readFileSync(new URL('../fixtures/synthetic/tiny.cast', import.meta.url), 'utf8'))

describe('computeStats', () => {
  it('measures the tiny fixture exactly', () => {
    const stats = computeStats(tiny)
    // Output bytes per event: "hello " 6 | ESC[31m red ESC[0m 5+3+4 = 12 | ESC]0;title BEL 10 | ESC[1;5 5 | "Hbox ─ 你" 12.
    expect(stats.events).toBe(5)
    expect(stats.inputEvents).toBe(1)
    expect(stats.inputBytes).toBe(1)
    expect(stats.duration).toBe(4)
    expect(stats.bytes).toBe(6 + 12 + 10 + 5 + 12)
    expect(stats.avgBytesPerSec).toBeCloseTo(45 / 4)
    // 1 s windows: [0,1) = "hello " 6; [1,2) = 12; [2,3) = 10 + 5; [3,4) = 12.
    expect(stats.peakBytesPerSec).toBe(15)
    // Escape bytes: 9 (31m + 0m) + 10 (OSC) + 5 + 1 ("H" closing the CSI split across events) = 25.
    expect(stats.escapeBytes).toBe(9 + 10 + 5 + 1)
    expect(stats.escapeShare).toBeCloseTo(25 / 45)
    expect(stats.features).toMatchObject({ titleChanges: 1, boxDrawing: 1, wideChars: 1, sgrTruecolor: 0, sgr256: 0 })
  })

  it('formats a readable table', () => {
    const text = formatStats(computeStats(tiny))
    expect(text).toContain('duration')
    expect(text).toContain('peak bytes/s')
    expect(text).toMatch(/escape share\s+55\.6 %/)
  })

  it('handles an empty recording', () => {
    const stats = computeStats({ header: { version: 2, width: 80, height: 24 }, events: [] })
    expect(stats).toMatchObject({ bytes: 0, events: 0, avgBytesPerSec: 0, peakBytesPerSec: 0, escapeShare: 0 })
  })
})

describe('EscapeCounter', () => {
  it('counts CSI, OSC (BEL and ST), DCS and two-byte escapes, but not plain control bytes', () => {
    const counter = new EscapeCounter()
    expect(counter.feed('\x1b[38;2;1;2;3m')).toBe(13)
    expect(counter.feed('\x1b]2;t\x07')).toBe(6)
    expect(counter.feed('\x1b]0;t\x1b\\')).toBe(7)
    expect(counter.feed('\x1bPq#0\x1b\\')).toBe(7)
    expect(counter.feed('\x1b7\x1b(B')).toBe(5)
    expect(counter.feed('a\r\n\b\x07')).toBe(0)
    expect(counter.total).toBe(13 + 6 + 7 + 7 + 5 + 5)
  })

  it('keeps its state when a sequence is split between chunks', () => {
    const counter = new EscapeCounter()
    expect(counter.feed('x\x1b[1')).toBe(3)
    expect(counter.feed('2;3Hy')).toBe(4)
  })
})
