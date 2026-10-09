import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AsciicastEvent } from './asciicast.js'
import { play } from './player.js'

const events: AsciicastEvent[] = [
  { time: 1, code: 'o', data: 'a' },
  { time: 1.5, code: 'i', data: 'ignored' },
  { time: 2, code: 'o', data: 'b' },
  { time: 12, code: 'o', data: 'c' },
]

/** Plays with fake timers and records the (virtual) time of every write. */
function run(options: Omit<Parameters<typeof play>[1], 'write'> = {}) {
  const writes: Array<{ at: number; data: string }> = []
  const t0 = Date.now()
  const done = play(events, { ...options, write: (data) => void writes.push({ at: Date.now() - t0, data }) })
  return { writes, done }
}

describe('play', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the original gaps between output events and skips other events', async () => {
    const { writes, done } = run()
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([{ at: 0, data: 'a' }])
    await vi.advanceTimersByTimeAsync(999)
    expect(writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(writes.map((w) => w.data)).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(10_000)
    await done
    expect(writes).toEqual([
      { at: 0, data: 'a' },
      { at: 1000, data: 'b' },
      { at: 11_000, data: 'c' },
    ])
  })

  it('scales gaps by speed', async () => {
    const { writes, done } = run({ speed: 4 })
    await vi.advanceTimersByTimeAsync(10_000)
    await done
    expect(writes.map((w) => w.at)).toEqual([0, 250, 2750])
  })

  it('caps long gaps with maxDelay', async () => {
    const { writes, done } = run({ maxDelay: 2 })
    await vi.advanceTimersByTimeAsync(10_000)
    await done
    expect(writes.map((w) => w.at)).toEqual([0, 1000, 3000])
  })

  it('speed 0 writes everything without waiting', async () => {
    const { writes, done } = run({ speed: 0 })
    await done
    expect(writes.map((w) => [w.at, w.data])).toEqual([
      [0, 'a'],
      [0, 'b'],
      [0, 'c'],
    ])
  })

  it('loops until aborted', async () => {
    const controller = new AbortController()
    const { writes, done } = run({ loop: true, speed: 0, signal: controller.signal })
    await vi.advanceTimersByTimeAsync(5)
    expect(writes.length).toBeGreaterThan(3)
    controller.abort()
    await vi.advanceTimersByTimeAsync(5)
    await done
    const count = writes.length
    await vi.advanceTimersByTimeAsync(50)
    expect(writes).toHaveLength(count)
  })

  it('stops waiting as soon as the signal aborts', async () => {
    const controller = new AbortController()
    const { writes, done } = run({ signal: controller.signal })
    await vi.advanceTimersByTimeAsync(500)
    controller.abort()
    await done
    expect(writes.map((w) => w.data)).toEqual(['a'])
  })

  it('waits for an async sink before the next event', async () => {
    let release: () => void = () => {}
    const seen: string[] = []
    const done = play(events, {
      speed: 0,
      write: (data) => {
        seen.push(data)
        if (data === 'a') return new Promise<void>((resolve) => (release = resolve))
      },
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(seen).toEqual(['a'])
    release()
    await done
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('rejects a negative speed', async () => {
    await expect(play(events, { speed: -1, write: () => {} })).rejects.toThrow(RangeError)
  })
})
