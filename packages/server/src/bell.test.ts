import { describe, expect, it } from 'vitest'
import { BellDebouncer, BellDetector, BellWatcher } from './bell.js'

const enc = (s: string): Uint8Array => Buffer.from(s, 'latin1')

describe('BEL detection', () => {
  it('rings on a plain BEL', () => {
    expect(new BellDetector().feed(enc('done\x07'))).toBe(true)
    expect(new BellDetector().feed(enc('no bell here'))).toBe(false)
  })

  it('does not ring for the BEL that terminates an OSC title', () => {
    const d = new BellDetector()
    expect(d.feed(enc('\x1b]0;claude: fix the bug\x07'))).toBe(false)
    expect(d.feed(enc('\x1b]2;another\x1b\\'))).toBe(false)
    // and keeps working afterwards
    expect(d.feed(enc('\x07'))).toBe(true)
  })

  it('handles an OSC split across chunks', () => {
    const d = new BellDetector()
    expect(d.feed(enc('\x1b]0;tit'))).toBe(false)
    expect(d.feed(enc('le\x07'))).toBe(false)
    expect(d.feed(enc('\x1b'))).toBe(false)
    expect(d.feed(enc(']0;t\x07x'))).toBe(false)
  })

  it('rings for a BEL right after an OSC, in the same chunk', () => {
    expect(new BellDetector().feed(enc('\x1b]0;t\x07\x07'))).toBe(true)
  })

  it('treats DCS/APC strings as opaque until ST', () => {
    const d = new BellDetector()
    expect(d.feed(enc('\x1bPq#0;2;0;0;0\x07\x1b\\'))).toBe(false)
    expect(d.feed(enc('\x1b_Gi=1;data\x07\x1b\\'))).toBe(false)
    expect(d.feed(enc('\x07'))).toBe(true)
  })

  it('recovers from an unterminated string (CAN aborts it)', () => {
    const d = new BellDetector()
    expect(d.feed(enc('\x1b]0;never ends'))).toBe(false)
    expect(d.feed(enc('\x18\x07'))).toBe(true)
  })

  it('ignores bell-less escape sequences and CSI', () => {
    expect(new BellDetector().feed(enc('\x1b[31mred\x1b[0m\x1b[2J'))).toBe(false)
  })
})

describe('BEL debounce', () => {
  it('notifies once per 30 s per session, the first bell at once', () => {
    let clock = 0
    const d = new BellDebouncer(() => clock, 30_000)
    expect(d.shouldNotify('a')).toBe(true)
    clock = 29_999
    expect(d.shouldNotify('a')).toBe(false)
    expect(d.shouldNotify('b')).toBe(true) // another session has its own window
    clock = 30_000
    expect(d.shouldNotify('a')).toBe(true)
  })

  it('the watcher combines detection and debounce, and ignores title changes', () => {
    let clock = 0
    const rang: string[] = []
    const watcher = new BellWatcher(
      (id) => rang.push(id),
      () => clock,
      30_000,
    )
    watcher.output('s1', enc('\x1b]0;a title\x07'))
    expect(rang).toEqual([])
    watcher.output('s1', enc('ding\x07'))
    watcher.output('s1', enc('ding\x07'))
    expect(rang).toEqual(['s1'])
    clock = 31_000
    watcher.output('s1', enc('\x07'))
    expect(rang).toEqual(['s1', 's1'])
    watcher.forget('s1')
    watcher.output('s1', enc('\x07'))
    expect(rang).toEqual(['s1', 's1', 's1'])
  })
})
