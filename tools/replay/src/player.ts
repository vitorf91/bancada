import type { AsciicastEvent } from './asciicast.js'

export interface PlayOptions {
  /** Playback speed multiplier. 0 plays as fast as the sink accepts data. Default 1. */
  speed?: number
  /** Restart from the first event when the last one is written, until `signal` aborts. */
  loop?: boolean
  /** Caps the gap between two consecutive output events, in seconds of recording time. Default: no cap. */
  maxDelay?: number
  signal?: AbortSignal
  /** Receives output data. May return a promise (backpressure). */
  write: (data: string) => void | Promise<void>
}

/**
 * Plays the output ("o") events of a recording, keeping the original gaps between them.
 * Events are scheduled against absolute deadlines, so a slow write does not accumulate drift.
 * Resolves once the last event was written (never, with `loop`, until aborted).
 */
export async function play(events: readonly AsciicastEvent[], options: PlayOptions): Promise<void> {
  const speed = options.speed ?? 1
  if (!Number.isFinite(speed) || speed < 0) throw new RangeError('speed must be a number >= 0')
  const maxDelay = options.maxDelay
  if (maxDelay !== undefined && (!Number.isFinite(maxDelay) || maxDelay < 0)) {
    throw new RangeError('maxDelay must be a number >= 0')
  }
  const output = events.filter((e) => e.code === 'o')
  if (output.length === 0) return
  const { signal } = options

  do {
    let previous = output[0]?.time ?? 0
    // Position on the (capped, scaled) playback timeline, in ms.
    let timeline = 0
    const startedAt = Date.now()
    for (const event of output) {
      if (signal?.aborted) return
      let gap = Math.max(0, event.time - previous)
      previous = event.time
      if (maxDelay !== undefined) gap = Math.min(gap, maxDelay)
      if (speed > 0) {
        timeline += (gap * 1000) / speed
        const wait = startedAt + timeline - Date.now()
        if (wait > 0) await sleep(wait, signal)
        if (signal?.aborted) return
      }
      await options.write(event.data)
    }
    // As fast as possible must still let the event loop breathe, or an abort could never be delivered.
    if (options.loop && speed === 0) await sleep(0, signal)
  } while (options.loop && !signal?.aborted)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
