import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputCoalescer } from './coalescer.js'

describe('OutputCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function make(maxBytes = 64 * 1024) {
    const flushed: string[] = []
    const coalescer = new OutputCoalescer(
      (d) => flushed.push(d.toString()),
      8,
      maxBytes,
      () => performance.now(),
    )
    return { flushed, coalescer }
  }

  it('sends the first chunk after idle at once, then batches within 8 ms', () => {
    const { flushed, coalescer } = make()
    coalescer.push(Buffer.from('a'))
    expect(flushed).toEqual(['a'])
    coalescer.push(Buffer.from('b'))
    coalescer.push(Buffer.from('c'))
    expect(flushed).toEqual(['a'])
    vi.advanceTimersByTime(8)
    expect(flushed).toEqual(['a', 'bc'])
  })

  it('never flushes more often than every 8 ms', () => {
    const { flushed, coalescer } = make()
    for (let i = 0; i < 100; i++) {
      coalescer.push(Buffer.from(`${i},`))
      vi.advanceTimersByTime(1)
    }
    vi.advanceTimersByTime(20)
    expect(flushed.length).toBeLessThanOrEqual(100 / 8 + 3)
    expect(flushed.join('')).toBe(Array.from({ length: 100 }, (_, i) => `${i},`).join(''))
  })

  it('flushes at once when 64 KiB are pending', () => {
    const { flushed, coalescer } = make(10)
    coalescer.push(Buffer.from('first'))
    coalescer.push(Buffer.from('1234'))
    expect(flushed).toEqual(['first'])
    coalescer.push(Buffer.from('567890'))
    expect(flushed).toEqual(['first', '1234567890'])
  })

  it('flush() delivers pending data in order and cancels the timer', () => {
    const { flushed, coalescer } = make()
    coalescer.push(Buffer.from('a'))
    coalescer.push(Buffer.from('b'))
    coalescer.flush()
    expect(flushed).toEqual(['a', 'b'])
    vi.advanceTimersByTime(50)
    expect(flushed).toEqual(['a', 'b'])
  })
})
