/**
 * BEL (0x07) detection in a session's raw output.
 *
 * 0x07 also terminates an OSC string (`ESC ] 0 ; title BEL`, which is how Claude Code and shells set the window
 * title), so a plain byte scan would ring on every title change. This is a tiny state machine over the bytes that
 * ignores BEL inside OSC and treats DCS/APC/PM/SOS strings (ended only by ST) as opaque. State survives chunk
 * boundaries: the host coalesces output at arbitrary points.
 */
enum S {
  Ground,
  Esc,
  Osc,
  OscEsc,
  Str,
  StrEsc,
}

const ESC = 0x1b
const BEL = 0x07
const CAN = 0x18
const SUB = 0x1a
/** An unterminated string is abandoned after this many bytes, so one bad sequence cannot mute the session. */
const MAX_STRING_BYTES = 1 << 20

export class BellDetector {
  private state: S = S.Ground
  private stringBytes = 0

  /** True when the chunk contains a BEL that rings (is not an OSC terminator). */
  feed(bytes: Uint8Array): boolean {
    let rang = false
    for (let i = 0; i < bytes.length; i++) {
      if (this.step(bytes[i] as number)) rang = true
    }
    return rang
  }

  private step(byte: number): boolean {
    switch (this.state) {
      case S.Ground:
        if (byte === ESC) this.state = S.Esc
        else if (byte === BEL) return true
        return false
      case S.Esc:
        if (byte === 0x5d /* ] */) this.enterString(S.Osc)
        else if (byte === 0x50 /* P */ || byte === 0x5f /* _ */ || byte === 0x5e /* ^ */ || byte === 0x58 /* X */) {
          this.enterString(S.Str)
        } else if (byte === ESC) this.state = S.Esc
        else {
          this.state = S.Ground
          if (byte === BEL) return true
        }
        return false
      case S.Osc:
        if (byte === BEL || byte === CAN || byte === SUB) this.state = S.Ground
        else if (byte === ESC) this.state = S.OscEsc
        else this.countString()
        return false
      case S.OscEsc:
        if (byte === 0x5c /* \ */) this.state = S.Ground
        else {
          this.state = S.Esc
          return this.step(byte)
        }
        return false
      case S.Str:
        if (byte === CAN || byte === SUB) this.state = S.Ground
        else if (byte === ESC) this.state = S.StrEsc
        else this.countString()
        return false
      case S.StrEsc:
        if (byte === 0x5c) this.state = S.Ground
        else {
          this.state = S.Esc
          return this.step(byte)
        }
        return false
    }
  }

  private enterString(state: S.Osc | S.Str): void {
    this.state = state
    this.stringBytes = 0
  }

  private countString(): void {
    if (++this.stringBytes > MAX_STRING_BYTES) this.state = S.Ground
  }
}

export const BELL_DEBOUNCE_MS = 30_000

/** At most one notification per session per window; the first bell goes out at once. */
export class BellDebouncer {
  private readonly last = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = BELL_DEBOUNCE_MS,
  ) {}

  shouldNotify(sessionId: string): boolean {
    const now = this.now()
    const last = this.last.get(sessionId)
    if (last !== undefined && now - last < this.windowMs) return false
    this.last.set(sessionId, now)
    return true
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId)
  }
}

/** Per-session detectors plus the debounce: feed output, get told when to notify. */
export class BellWatcher {
  private readonly detectors = new Map<string, BellDetector>()
  private readonly debouncer: BellDebouncer

  constructor(
    private readonly onBell: (sessionId: string) => void,
    now?: () => number,
    windowMs?: number,
  ) {
    this.debouncer = new BellDebouncer(now, windowMs)
  }

  output(sessionId: string, bytes: Uint8Array): void {
    let detector = this.detectors.get(sessionId)
    if (!detector) {
      detector = new BellDetector()
      this.detectors.set(sessionId, detector)
    }
    if (detector.feed(bytes) && this.debouncer.shouldNotify(sessionId)) this.onBell(sessionId)
  }

  forget(sessionId: string): void {
    this.detectors.delete(sessionId)
    this.debouncer.forget(sessionId)
  }
}
