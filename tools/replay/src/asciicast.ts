/** asciicast v2 (https://docs.asciinema.org/manual/asciicast/v2/): a JSON header line, then one JSON event per line. */

export interface AsciicastHeader {
  version: 2
  width: number
  height: number
  /** Unix time (seconds) when the recording started. */
  timestamp?: number
  /** Total length in seconds. Not part of the v2 spec, but a harmless extra field that tools ignore. */
  duration?: number
  command?: string
  title?: string
  env?: Record<string, string>
  idle_time_limit?: number
}

/** `o` output, `i` input, `m` marker, `r` resize ("COLSxROWS"). */
export type AsciicastEventCode = 'o' | 'i' | 'm' | 'r'

export interface AsciicastEvent {
  /** Seconds since the start of the recording. */
  time: number
  code: AsciicastEventCode
  data: string
}

export interface Asciicast {
  header: AsciicastHeader
  events: AsciicastEvent[]
}

const EVENT_CODES: ReadonlySet<string> = new Set(['o', 'i', 'm', 'r'])

/** Timestamps are written with microsecond precision, like asciinema does. */
export function roundTime(seconds: number): number {
  return Math.round(seconds * 1e6) / 1e6
}

export function serializeEvent(event: AsciicastEvent): string {
  return JSON.stringify([roundTime(event.time), event.code, event.data])
}

export function serializeAsciicast(cast: Asciicast): string {
  const lines = [JSON.stringify(cast.header)]
  for (const event of cast.events) lines.push(serializeEvent(event))
  return `${lines.join('\n')}\n`
}

export function parseAsciicast(text: string): Asciicast {
  const lines = text.split('\n')
  const headerLine = lines[0]
  if (!headerLine) throw new Error('asciicast: empty file')
  const header = parseJson(headerLine, 1)
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new Error('asciicast: line 1 is not a header object')
  }
  const h = header as Record<string, unknown>
  if (h.version !== 2) throw new Error(`asciicast: unsupported version ${String(h.version)} (only v2)`)
  if (!isPositiveInt(h.width) || !isPositiveInt(h.height)) {
    throw new Error('asciicast: header needs integer width and height')
  }
  const events: AsciicastEvent[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line?.trim()) continue
    const value = parseJson(line, i + 1)
    if (!Array.isArray(value) || value.length < 3) throw new Error(`asciicast: line ${i + 1} is not an event`)
    const [time, code, data] = value as unknown[]
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
      throw new Error(`asciicast: line ${i + 1} has an invalid timestamp`)
    }
    if (typeof code !== 'string' || !EVENT_CODES.has(code)) {
      throw new Error(`asciicast: line ${i + 1} has an unknown event code`)
    }
    if (typeof data !== 'string') throw new Error(`asciicast: line ${i + 1} has non-string data`)
    events.push({ time, code: code as AsciicastEventCode, data })
  }
  return { header: header as AsciicastHeader, events }
}

function parseJson(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`asciicast: line ${lineNumber} is not valid JSON`)
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** UTF-8 size of a chunk of terminal output. */
export function byteLength(data: string): number {
  return Buffer.byteLength(data, 'utf8')
}
