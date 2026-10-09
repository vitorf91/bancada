import type { Asciicast } from './asciicast.js'
import { byteLength } from './asciicast.js'

/** Counts of the terminal features a recording exercises. */
export interface CastFeatures {
  sgrTruecolor: number
  sgr256: number
  /** CSI sequences that move the cursor (A B C D E F G H f). */
  cursorMoves: number
  /** OSC 0 and OSC 2 window-title changes. */
  titleChanges: number
  boxDrawing: number
  /** CJK and emoji characters, which occupy two cells. */
  wideChars: number
  /** Output events of at least 1000 bytes, i.e. one full PTY read. */
  fullChunks: number
}

export interface CastStats {
  /** Time of the last event, in seconds (or the header duration when it is longer). */
  duration: number
  /** UTF-8 bytes of output ("o") events. */
  bytes: number
  /** Output events. */
  events: number
  inputEvents: number
  inputBytes: number
  avgBytesPerSec: number
  /** Most output bytes in any fixed 1 s window (window n covers [n, n + 1)). */
  peakBytesPerSec: number
  /** Share (0..1) of output bytes that belong to escape sequences (CSI, OSC, DCS/APC/PM/SOS strings, ESC pairs). */
  escapeShare: number
  escapeBytes: number
  features: CastFeatures
}

/** A global regexp that starts with the ESC byte (written as a string, because linters reject control characters in regex literals). */
const escRegExp = (body: string): RegExp => new RegExp(String.fromCharCode(0x1b) + body, 'g')

type EscState = 'text' | 'esc' | 'csi' | 'string' | 'string-esc' | 'esc-inter'

/**
 * Streaming escape-sequence counter. State survives across chunks, because a sequence can be split between two
 * output events. Only ESC-introduced sequences count; plain control bytes such as CR, LF and BS are text.
 */
export class EscapeCounter {
  private state: EscState = 'text'
  total = 0

  /** Feeds a chunk and returns the UTF-8 bytes of it that belong to escape sequences. */
  feed(data: string): number {
    let escaped = 0
    for (const ch of data) {
      const code = ch.codePointAt(0) ?? 0
      const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
      this.total += size
      switch (this.state) {
        case 'text':
          if (code === 0x1b) {
            this.state = 'esc'
            escaped += size
          }
          break
        case 'esc':
          escaped += size
          if (ch === '[') this.state = 'csi'
          else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') this.state = 'string'
          else if (code >= 0x20 && code <= 0x2f) this.state = 'esc-inter'
          else this.state = 'text'
          break
        case 'esc-inter':
          escaped += size
          if (code < 0x20 || code > 0x2f) this.state = 'text'
          break
        case 'csi':
          escaped += size
          // Final byte 0x40-0x7e ends the sequence; parameters and intermediates are 0x20-0x3f.
          if (code >= 0x40 && code <= 0x7e) this.state = 'text'
          else if (code === 0x1b) this.state = 'esc'
          break
        case 'string':
          escaped += size
          if (code === 0x07) this.state = 'text'
          else if (code === 0x1b) this.state = 'string-esc'
          break
        case 'string-esc':
          escaped += size
          this.state = ch === '\\' ? 'text' : 'string'
          break
      }
    }
    return escaped
  }
}

export function computeStats(cast: Asciicast): CastStats {
  const counter = new EscapeCounter()
  let bytes = 0
  let events = 0
  let inputEvents = 0
  let inputBytes = 0
  let escapeBytes = 0
  let lastTime = 0
  const windows = new Map<number, number>()
  for (const event of cast.events) {
    lastTime = Math.max(lastTime, event.time)
    if (event.code === 'i') {
      inputEvents++
      inputBytes += byteLength(event.data)
      continue
    }
    if (event.code !== 'o') continue
    const size = byteLength(event.data)
    bytes += size
    events++
    escapeBytes += counter.feed(event.data)
    const window = Math.floor(event.time)
    windows.set(window, (windows.get(window) ?? 0) + size)
  }
  const text = cast.events.map((e) => (e.code === 'o' ? e.data : '')).join('')
  const count = (re: RegExp): number => text.match(re)?.length ?? 0
  const features: CastFeatures = {
    sgrTruecolor: count(escRegExp('\\[[0-9;]*[34]8;2;')),
    sgr256: count(escRegExp('\\[[0-9;]*[34]8;5;')),
    cursorMoves: count(escRegExp('\\[[0-9;]*[ABCDEFGHf]')),
    titleChanges: count(escRegExp('\\][02];')),
    boxDrawing: count(/[\u2500-\u257f]/g),
    wideChars: count(/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uff00-\uff60\u{1f300}-\u{1faff}]/gu),
    fullChunks: cast.events.filter((e) => e.code === 'o' && byteLength(e.data) >= 1000).length,
  }
  const duration = Math.max(lastTime, cast.header.duration ?? 0)
  let peak = 0
  for (const value of windows.values()) peak = Math.max(peak, value)
  return {
    duration,
    bytes,
    events,
    inputEvents,
    inputBytes,
    avgBytesPerSec: duration > 0 ? bytes / duration : 0,
    peakBytesPerSec: peak,
    escapeShare: bytes > 0 ? escapeBytes / bytes : 0,
    escapeBytes,
    features,
  }
}

export function formatStats(stats: CastStats): string {
  const rows: Array<[string, string]> = [
    ['duration', `${stats.duration.toFixed(2)} s`],
    ['bytes', String(stats.bytes)],
    ['events', String(stats.events)],
    ['input events', String(stats.inputEvents)],
    ['avg bytes/s', stats.avgBytesPerSec.toFixed(1)],
    ['peak bytes/s (1 s window)', String(stats.peakBytesPerSec)],
    ['escape share', `${(stats.escapeShare * 100).toFixed(1)} %`],
    ['truecolor SGR', String(stats.features.sgrTruecolor)],
    ['256-color SGR', String(stats.features.sgr256)],
    ['cursor moves', String(stats.features.cursorMoves)],
    ['title changes', String(stats.features.titleChanges)],
    ['box drawing chars', String(stats.features.boxDrawing)],
    ['wide chars (CJK/emoji)', String(stats.features.wideChars)],
    ['events >= 1000 bytes', String(stats.features.fullChunks)],
  ]
  const width = Math.max(...rows.map(([k]) => k.length))
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n')
}
