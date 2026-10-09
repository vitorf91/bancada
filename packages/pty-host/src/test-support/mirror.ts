import { Terminal } from '@xterm/headless'

/** A client-side terminal: what a renderer does with a snapshot and the stream behind it. */
export class Mirror {
  readonly term: Terminal

  constructor(cols: number, rows: number, scrollback: number) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  }

  write(data: string | Uint8Array): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve))
  }

  /** Every line of scrollback and screen, right-trimmed. */
  lines(): string[] {
    const buffer = this.term.buffer.active
    const out: string[] = []
    for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '')
    return out
  }

  dispose(): void {
    this.term.dispose()
  }
}

/** Numeric lines in order, as numbers. */
export function numericLines(lines: string[]): number[] {
  return lines.filter((line) => /^\d+$/.test(line)).map(Number)
}

/** Index of the first place where a sequence is not +1 each step, or -1 when it is consecutive. */
export function firstGap(numbers: number[]): number {
  for (let i = 1; i < numbers.length; i++) if (numbers[i] !== (numbers[i - 1] as number) + 1) return i
  return -1
}
