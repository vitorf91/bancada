/**
 * Per-session output coalescing: output is flushed at most every `intervalMs`, or at once when `maxBytes` are
 * pending. After an idle period the first chunk goes out immediately, so a keystroke echo pays no timer delay.
 */
export class OutputCoalescer {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private timer: NodeJS.Timeout | null = null
  private lastFlushAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly onFlush: (data: Buffer) => void,
    private readonly intervalMs = 8,
    private readonly maxBytes = 64 * 1024,
    private readonly now: () => number = () => performance.now(),
  ) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    if (this.pendingBytes >= this.maxBytes) {
      this.flush()
      return
    }
    if (this.timer) return
    const wait = this.lastFlushAt + this.intervalMs - this.now()
    if (wait <= 0) this.flush()
    else this.timer = setTimeout(() => this.flush(), wait)
  }

  /** Delivers whatever is pending now, in order. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.length === 0) return
    const data =
      this.pending.length === 1 ? (this.pending[0] as Buffer) : Buffer.concat(this.pending, this.pendingBytes)
    this.pending = []
    this.pendingBytes = 0
    this.lastFlushAt = this.now()
    this.onFlush(data)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = []
    this.pendingBytes = 0
  }
}
