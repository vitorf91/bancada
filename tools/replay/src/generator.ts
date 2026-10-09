import type { Asciicast, AsciicastEvent } from './asciicast.js'
import { roundTime } from './asciicast.js'

export interface GenerateOptions {
  /** Seeds the PRNG: the same options always produce the same bytes. */
  seed: number
  /** Length of the recording in seconds. */
  durationSec: number
  cols: number
  rows: number
  /** Divides the idle gaps: 1 mimics a real session, 4 is a busy agent that rarely rests. */
  intensity: number
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = { seed: 1, durationSec: 85, cols: 120, rows: 40, intensity: 1 }

/** The real PTY read size seen in recordings: output arrives in chunks of at most this many bytes. */
const CHUNK_BYTES = 1024

// --- deterministic randomness ---------------------------------------------------------------------------------------

class Rng {
  private state: number
  constructor(seed: number) {
    this.state = seed >>> 0
  }
  /** mulberry32: small, fast and identical on every platform. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T
  }
}

// --- terminal vocabulary --------------------------------------------------------------------------------------------

const ESC = '\x1b'
const RESET = `${ESC}[0m`
const BEL = '\x07'
const tc = (r: number, g: number, b: number): string => `${ESC}[38;2;${r};${g};${b}m`
const c256 = (n: number): string => `${ESC}[38;5;${n}m`
const bg256 = (n: number): string => `${ESC}[48;5;${n}m`
const cup = (row: number, col: number): string => `${ESC}[${row};${col}H`
const cha = (col: number): string => `${ESC}[${col}G`

const ORANGE = tc(215, 119, 87)
const GREY = tc(153, 153, 153)
const DIM = `${ESC}[2m`
const BOLD = `${ESC}[1m`
const GREEN = tc(78, 186, 101)
const BLUE = tc(177, 185, 249)
const RED = tc(255, 107, 128)

const PROSE_WORDS = (
  'the agent reads each file before it edits anything so the change stays small and the diff easy to review ' +
  'then runs the tests again and reports what failed with the exact command that reproduces it while the ' +
  'terminal keeps scrolling output through a pseudo terminal that every pane mirrors headless for later'
).split(' ')
const IDENTS = ['session', 'buffer', 'frame', 'cursor', 'pane', 'host', 'socket', 'chunk', 'render', 'state', 'queue']
const KEYWORDS = ['const', 'let', 'function', 'return', 'await', 'async', 'if', 'for', 'import', 'export', 'type']
const CJK = [
  'こんにちは世界',
  '端末の出力を確認します',
  '你好，世界',
  '正在运行测试',
  '안녕하세요 터미널',
  '作業を続けています',
]
const EMOJI = ['🚀', '✅', '🔥', '🧪', '📦', '🎯', '⚡', '🛠️']
const SPINNER_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽']
const SPINNER_VERBS = ['Thinking', 'Churning', 'Pondering', 'Reading', 'Computing', 'Cooking']
const TOPICS = ['Fix flaky pty test', 'Refactor session store', 'Write README notes', 'Profile terminal grid']

/** Terminal cells a string occupies: East Asian wide characters and emoji take two. */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0xfe0f || cp === 0x200d) continue
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
    width += wide ? 2 : 1
  }
  return width
}

class Builder {
  readonly events: AsciicastEvent[] = []
  time = 0
  constructor(readonly rng: Rng) {}

  /** Emits `data` at the current time, split into PTY-sized chunks, advancing time by `gap()` between chunks. */
  write(data: string, gap: () => number = () => 0): void {
    let current = ''
    let size = 0
    for (const ch of data) {
      const n = Buffer.byteLength(ch, 'utf8')
      if (size + n > CHUNK_BYTES) {
        this.push(current)
        this.time += gap()
        current = ''
        size = 0
      }
      current += ch
      size += n
    }
    if (current) this.push(current)
  }

  private push(data: string): void {
    this.events.push({ time: roundTime(this.time), code: 'o', data })
  }

  wait(seconds: number): void {
    this.time += seconds
  }
}

// --- screen layout (rows counted from the bottom, so any size works) ------------------------------------------------

interface Layout {
  cols: number
  rows: number
  contentBottom: number
  spinnerRow: number
  boxTop: number
  inputRow: number
  statusRow: number
}

function layoutFor(cols: number, rows: number): Layout {
  return {
    cols,
    rows,
    contentBottom: rows - 7,
    spinnerRow: rows - 6,
    boxTop: rows - 5,
    inputRow: rows - 4,
    statusRow: rows - 1,
  }
}

// --- text builders --------------------------------------------------------------------------------------------------

/** A line placed word by word with absolute column moves, the way Ink-style renderers paint text. */
function inkLine(words: string[], color: string, indent: number): string {
  let col = indent + 1
  let out = `${cha(col)}${color}`
  words.forEach((word, i) => {
    if (i > 0) out += cha(col)
    out += word
    col += displayWidth(word) + 1
  })
  return `${out}${RESET}`
}

function proseWords(rng: Rng, count: number): string[] {
  return Array.from({ length: count }, () => rng.pick(PROSE_WORDS))
}

interface Token {
  text: string
  color: string
}

/** Paints tokens with absolute column moves (Ink style) or, when `placed` is false, packed with plain spaces. */
function paintTokens(tokens: Token[], indent: number, placed: boolean): string {
  let col = indent + 1
  let out = placed ? '' : cha(col)
  for (const token of tokens) {
    out += placed ? cha(col) : ''
    out += `${token.color}${token.text}${RESET}${placed ? '' : ' '}`
    col += displayWidth(token.text) + 1
  }
  return out
}

function highlightCode(rng: Rng, lineNo: number, indent: number): string {
  const kw = rng.pick(KEYWORDS)
  const id = rng.pick(IDENTS)
  const num = String(rng.int(1, 4096))
  const pad = indent * 2
  const gutter: Token = { text: String(lineNo).padStart(3), color: GREY }
  const keyword: Token = { text: kw, color: tc(197, 134, 192) }
  let body: Token[]
  switch (rng.int(0, 5)) {
    case 0:
      body = [
        keyword,
        { text: id, color: tc(156, 220, 254) },
        { text: '=', color: '' },
        { text: `'${id}-${num}'`, color: c256(150) },
      ]
      break
    case 1:
      body = [
        { text: '//', color: c256(244) },
        ...proseWords(rng, rng.int(3, 8)).map((text) => ({ text, color: c256(244) })),
      ]
      break
    case 2:
      body = [
        keyword,
        { text: `${id}(${num},`, color: c256(110) },
        { text: `"${rng.pick(IDENTS)}")`, color: c256(150) },
        { text: '{', color: '' },
      ]
      break
    case 3:
      body = [
        { text: `${id}.${rng.pick(IDENTS)}(`, color: tc(220, 220, 170) },
        { text: `${num})`, color: tc(181, 206, 168) },
      ]
      break
    case 4:
      body = [{ text: '}', color: '' }]
      break
    default:
      body = [
        keyword,
        { text: `${rng.pick(IDENTS)}Options`, color: tc(78, 201, 176) },
        { text: '=>', color: tc(212, 212, 212) },
        { text: num, color: `${bg256(238)}${c256(255)}` },
      ]
  }
  // About nine lines in ten are placed word by word; the rest are written as packed runs.
  const placed = rng.chance(0.9)
  return `${paintTokens([gutter], 0, true)}${paintTokens(body, 5 + pad, placed)}`
}

function titleSequence(rng: Rng, text: string): string {
  // Mix OSC 0 and OSC 2, BEL and ST terminators: all four appear in the wild.
  const osc = rng.chance(0.6) ? 0 : 2
  const end = rng.chance(0.75) ? BEL : `${ESC}\\`
  return `${ESC}]${osc};${text}${end}`
}

function inputBox(l: Layout, text: string): string {
  const inner = l.cols - 2
  const fill = Math.max(0, inner - 3 - displayWidth(text))
  return (
    `${cup(l.boxTop, 1)}${GREY}╭${'─'.repeat(inner)}╮${RESET}` +
    `${cup(l.inputRow, 1)}${GREY}│${RESET} ${BLUE}❯${RESET} ${text}${' '.repeat(fill)}${cup(l.inputRow, l.cols)}${GREY}│${RESET}` +
    `${cup(l.inputRow + 1, 1)}${GREY}╰${'─'.repeat(inner)}╯${RESET}`
  )
}

function statusLines(l: Layout, spend: number): string {
  return (
    `${cup(l.statusRow - 1, 3)}${RED}⏵⏵ bypass permissions on${GREY} (shift+tab to cycle) · ← for agents${RESET}\x1b[K` +
    `${cup(l.statusRow, 3)}${GREY}💰 $${spend.toFixed(2)} session | 🧠 ${(spend * 5600).toFixed(0)} | 🤖 Haiku${RESET}\x1b[K`
  )
}

function setup(l: Layout): string {
  return (
    `${ESC}[?1049h${ESC}[2J${ESC}[H${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[?2004h${ESC}[?25l` +
    `${ESC}[1;${l.contentBottom}r${cup(l.contentBottom, 1)}` +
    `${ORANGE} ▐▛███▜▌${RESET}  ${BOLD}Claude Code${RESET}\r\n ${GREY}Haiku · synthetic fixture${RESET}\r\n` +
    inputBox(l, '') +
    statusLines(l, 0)
  )
}

function teardown(): string {
  return `${ESC}[r${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[?2004l${ESC}[?1049l${ESC}[?25h`
}

// --- session phases -------------------------------------------------------------------------------------------------

function typePrompt(b: Builder, l: Layout): void {
  const prompt = `${b.rng.pick(['Refactor', 'Explain', 'Write', 'Profile', 'Fix'])} ${b.rng.pick(IDENTS)} ${proseWords(b.rng, b.rng.int(6, 14)).join(' ')}`
  let typed = ''
  for (let i = 0; i < prompt.length; i += 2) {
    typed = prompt.slice(0, i + 2)
    b.write(`${cup(l.inputRow, 5 + displayWidth(typed) - 2)}${prompt.slice(i, i + 2)}`)
    b.wait(b.rng.range(0.04, 0.11))
  }
  b.wait(b.rng.range(0.3, 0.9))
  b.write(inputBox(l, '') + cup(l.inputRow, 5))
}

function think(b: Builder, l: Layout, seconds: number): void {
  const { rng } = b
  const verb = rng.pick(SPINNER_VERBS)
  const end = b.time + seconds
  let frame = 0
  let tokens = rng.int(40, 400)
  const started = b.time
  const gap = l.inputRow - l.spinnerRow
  b.write(titleSequence(rng, `✳ ${rng.pick(TOPICS)}`))
  while (b.time < end) {
    const glyph = SPINNER_GLYPHS[frame % SPINNER_GLYPHS.length] ?? '·'
    tokens += rng.int(3, 40)
    const elapsed = Math.floor(b.time - started)
    // Shimmer: every letter of the verb gets its own truecolor value, as the real spinner does.
    const shimmer =
      frame % 4 === 0
        ? [...`${verb}…`]
            .map(
              (ch, i) =>
                `${tc(215 - ((frame + i) % 6) * 12, 119 - ((frame + i) % 6) * 6, 87 + ((frame + i) % 6) * 14)}${ch}`,
            )
            .join('')
        : `${ORANGE}${verb}…`
    // Relative cursor movement: up to the spinner row, redraw, then back down to the input box.
    const head = frame % 4 === 0 ? `${ESC}[2K${ESC}[3C${ORANGE}${glyph}${RESET} ${shimmer}${RESET} ` : `${cha(15)}`
    b.write(`${ESC}[${gap}A\r${head}${c256(245)}(${elapsed}s · ↓ ${tokens} tokens)${RESET}${ESC}[${gap}B\r${ESC}[4C`)
    if (frame % 9 === 8) b.write(titleSequence(rng, `${glyph} ${rng.pick(TOPICS)}`))
    if (frame % 25 === 24) b.write(statusLines(l, rng.range(0, 0.05)))
    frame++
    b.wait(rng.range(0.05, 0.16))
  }
  b.write(`${ESC}[${gap}A\r${ESC}[2K${ESC}[${gap}B`)
}

function codeBurst(b: Builder, l: Layout, large: boolean): void {
  const { rng } = b
  const fast = () => rng.range(0.001, 0.006)
  const parts: string[] = [cup(l.contentBottom, 1)]
  const file = `${rng.pick(IDENTS)}-${rng.pick(IDENTS)}.ts`
  parts.push(
    `\r\n${GREEN}⏺${RESET} ${BOLD}Write${RESET}(${file})\r\n  ${GREY}⎿${RESET}  Wrote ${rng.int(30, 90)} lines to ${file}\r\n`,
  )

  // Assistant message: wrapped paragraphs, one Ink-placed, one left to the terminal's own autowrap.
  parts.push(`${inkLine(proseWords(rng, rng.int(14, 22)), '', 2)}\r\n`)
  parts.push(`${proseWords(rng, rng.int(26, 44)).join(' ')} ${rng.pick(EMOJI)}\r\n`)
  if (rng.chance(0.8))
    parts.push(
      `  ${rng.pick(EMOJI)} ${rng.pick(CJK)} ${rng.pick(EMOJI)} ${proseWords(rng, 5).join(' ')} ${rng.pick(CJK)}\r\n`,
    )

  // Boxed code block.
  const width = Math.min(l.cols - 4, 80)
  const lines = large ? rng.int(60, 72) : rng.int(8, 22)
  parts.push(`  ${GREY}┌${'─'.repeat(width)}┐${RESET}\r\n`)
  let indent = 0
  for (let i = 1; i <= lines; i++) {
    const line = highlightCode(rng, i, indent)
    if (line.endsWith('{')) indent = Math.min(indent + 1, 4)
    if (line.endsWith('}')) indent = Math.max(indent - 1, 0)
    parts.push(`${line}\r\n`)
  }
  parts.push(`  ${GREY}└${'─'.repeat(width)}┘${RESET}\r\n`)
  parts.push(`${DIM}${inkLine(proseWords(rng, 8), GREY, 4)}\r\n`)

  b.write(parts.join(''), fast)
  b.write(titleSequence(rng, `✳ ${rng.pick(TOPICS)}`))
  b.write(inputBox(l, '') + statusLines(l, rng.range(0.01, 0.3)) + cup(l.inputRow, 5))
}

function idle(b: Builder, l: Layout, seconds: number): void {
  const end = b.time + seconds
  // An idle agent still repaints its footer now and then.
  while (b.time + 8 < end) {
    b.wait(b.rng.range(5, 8))
    b.write(statusLines(l, b.rng.range(0.3, 0.6)) + cup(l.inputRow, 5))
  }
  b.time = end
}

// --- entry point ----------------------------------------------------------------------------------------------------

export function generateAsciicast(partial: Partial<GenerateOptions> = {}): Asciicast {
  const options = { ...DEFAULT_GENERATE_OPTIONS, ...partial }
  if (!(options.durationSec > 0) || !(options.intensity > 0) || options.cols < 40 || options.rows < 12) {
    throw new RangeError('generate: needs durationSec > 0, intensity > 0, cols >= 40 and rows >= 12')
  }
  const rng = new Rng(options.seed)
  const b = new Builder(rng)
  const l = layoutFor(options.cols, options.rows)

  b.write(`${titleSequence(rng, '✳ Claude Code')}${setup(l)}`)
  b.wait(rng.range(1, 2))
  for (let cycle = 0; b.time < options.durationSec - 14; cycle++) {
    typePrompt(b, l)
    think(b, l, rng.range(3, 10))
    codeBurst(b, l, cycle === 0)
    const rest = (rng.chance(0.3) ? rng.range(20, 32) : rng.range(8, 16)) / options.intensity
    idle(b, l, Math.min(rest, options.durationSec - b.time))
  }
  idle(b, l, Math.max(0, options.durationSec - b.time))
  b.write(teardown())

  return {
    header: {
      version: 2,
      width: options.cols,
      height: options.rows,
      // Fixed, so the same seed yields the same file.
      timestamp: 1_700_000_000,
      duration: roundTime(b.time),
      command: 'synthetic agent-like session',
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    },
    events: b.events,
  }
}
