import { describe, expect, it } from 'vitest'
import { type Asciicast, parseAsciicast, serializeAsciicast } from './asciicast.js'

const sample: Asciicast = {
  header: { version: 2, width: 120, height: 40, timestamp: 1_700_000_000, duration: 3.25, command: 'echo hi' },
  events: [
    { time: 0.000001, code: 'o', data: 'plain' },
    { time: 0.5, code: 'o', data: '\x1b[38;2;1;2;3m─你🚀\x1b[0m\r\n' },
    { time: 1.25, code: 'i', data: '\x03' },
    { time: 3.25, code: 'o', data: '"quotes" \\   \x00' },
  ],
}

describe('asciicast', () => {
  it('round-trips header and events', () => {
    expect(parseAsciicast(serializeAsciicast(sample))).toEqual(sample)
  })

  it('writes one JSON value per line, header first', () => {
    const lines = serializeAsciicast(sample).trimEnd().split('\n')
    expect(lines).toHaveLength(1 + sample.events.length)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ version: 2, width: 120, height: 40 })
    expect(JSON.parse(lines[2] ?? '')).toEqual([0.5, 'o', sample.events[1]?.data])
  })

  it('serializes timestamps with at most microsecond precision', () => {
    const text = serializeAsciicast({ header: sample.header, events: [{ time: 1 / 3, code: 'o', data: 'x' }] })
    expect(text).toContain('[0.333333,"o","x"]')
  })

  it('ignores blank lines', () => {
    const text = `${serializeAsciicast(sample)}\n\n`
    expect(parseAsciicast(text).events).toHaveLength(sample.events.length)
  })

  it.each([
    ['', 'empty'],
    ['not json', 'line 1'],
    ['{"version":1,"width":80,"height":24}', 'unsupported version'],
    ['{"version":2,"width":0,"height":24}', 'width and height'],
    ['{"version":2,"width":80,"height":24}\n[0,"o"]', 'line 2 is not an event'],
    ['{"version":2,"width":80,"height":24}\n[-1,"o","x"]', 'invalid timestamp'],
    ['{"version":2,"width":80,"height":24}\n[0,"z","x"]', 'unknown event code'],
    ['{"version":2,"width":80,"height":24}\n[0,"o",5]', 'non-string data'],
  ])('rejects %j', (text, message) => {
    expect(() => parseAsciicast(text)).toThrow(message)
  })
})
