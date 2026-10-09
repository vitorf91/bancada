import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseAsciicast, serializeAsciicast } from './asciicast.js'
import { displayWidth, generateAsciicast } from './generator.js'
import { renderFinalScreen } from './screen.js'
import { computeStats } from './stats.js'

/** A regexp that starts with ESC, written as a string because linters reject control characters in literals. */
const esc = (body: string): RegExp => new RegExp(String.fromCharCode(0x1b) + body)

const fixtureUrl = new URL('../fixtures/synthetic/agent-like.cast', import.meta.url)

describe('generateAsciicast', () => {
  it('is deterministic: the same seed gives the same bytes', () => {
    const a = serializeAsciicast(generateAsciicast({ seed: 7, durationSec: 40 }))
    const b = serializeAsciicast(generateAsciicast({ seed: 7, durationSec: 40 }))
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('gives different output for a different seed', () => {
    const a = serializeAsciicast(generateAsciicast({ seed: 7, durationSec: 40 }))
    const b = serializeAsciicast(generateAsciicast({ seed: 8, durationSec: 40 }))
    expect(a).not.toBe(b)
  })

  it('produces a well-formed, time-ordered recording of the requested length', () => {
    const cast = generateAsciicast({ seed: 3, durationSec: 30, cols: 100, rows: 30 })
    expect(cast.header).toMatchObject({ version: 2, width: 100, height: 30 })
    expect(cast.header.duration).toBeCloseTo(30, 1)
    let previous = 0
    for (const event of cast.events) {
      expect(event.time).toBeGreaterThanOrEqual(previous)
      expect(Buffer.byteLength(event.data)).toBeLessThanOrEqual(1024)
      previous = event.time
    }
    expect(previous).toBeLessThanOrEqual(30)
  })

  it('covers the features an agent TUI exercises', () => {
    const cast = generateAsciicast({ seed: 1, durationSec: 85 })
    const text = cast.events.map((e) => e.data).join('')
    const stats = computeStats(cast)
    expect(stats.features.sgrTruecolor).toBeGreaterThan(50)
    expect(stats.features.sgr256).toBeGreaterThan(50)
    expect(stats.features.boxDrawing).toBeGreaterThan(100)
    expect(stats.features.wideChars).toBeGreaterThan(5)
    expect(stats.features.cursorMoves).toBeGreaterThan(200)
    expect(text).toMatch(esc('\\]0;'))
    expect(text).toMatch(esc('\\]2;'))
    expect(text).toMatch(/[぀-鿿]/)
    expect(text).toMatch(/\p{Extended_Pictographic}/u)
    // Spinner redraws move up, repaint and move back down.
    expect(text).toMatch(esc(`\\[\\d+A\\r[^\\n]*${String.fromCharCode(0x1b)}\\[\\d+B`))
    // A paragraph longer than the terminal is wide enough to be wrapped by the terminal itself.
    const longest = text
      .split('\r\n')
      .flatMap((line) => line.split('\x1b'))
      .reduce((max, line) => Math.max(max, displayWidth(line)), 0)
    expect(longest).toBeGreaterThan(cast.header.width)
    // Bursts and idle gaps: some second moves several KB, some stretch has no output at all.
    expect(stats.peakBytesPerSec).toBeGreaterThan(5000)
    let longestGap = 0
    for (let i = 1; i < cast.events.length; i++) {
      longestGap = Math.max(longestGap, (cast.events[i]?.time ?? 0) - (cast.events[i - 1]?.time ?? 0))
    }
    expect(longestGap).toBeGreaterThan(4)
  })

  it('renders as a sane screen in a headless terminal', async () => {
    const cast = generateAsciicast({ seed: 2, durationSec: 30 })
    const screen = await renderFinalScreen(cast, 20)
    const text = screen.lines.join('\n')
    expect(text).toContain('❯')
    expect(text).toContain('bypass permissions')
    expect(screen.title.length).toBeGreaterThan(0)
  })

  it('rejects impossible sizes', () => {
    expect(() => generateAsciicast({ cols: 10 })).toThrow(RangeError)
    expect(() => generateAsciicast({ durationSec: 0 })).toThrow(RangeError)
  })
})

describe('committed synthetic fixture', () => {
  it('is under 2 MB and parses', () => {
    expect(statSync(fixtureUrl).size).toBeLessThan(2 * 1024 * 1024)
    expect(parseAsciicast(readFileSync(fixtureUrl, 'utf8')).events.length).toBeGreaterThan(100)
  })

  it('matches what the documented regeneration command produces (seed 4, 85 s, 120x40)', () => {
    const regenerated = serializeAsciicast(generateAsciicast({ seed: 4, durationSec: 85, cols: 120, rows: 40 }))
    expect(readFileSync(fixtureUrl, 'utf8')).toBe(regenerated)
  })
})
