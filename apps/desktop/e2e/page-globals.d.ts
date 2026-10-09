// The e2e project compiles without the DOM lib; these are the parts of `window` that `page.evaluate` callbacks use.
interface E2eTerminal {
  rows: number
  cols: number
  buffer: {
    active: { length: number; getLine(y: number): { translateToString(trimRight: boolean): string } | undefined }
  }
}

declare const window: {
  bancada: {
    write(sessionId: string, data: string): void
    list(): Promise<Array<{ id: string; pid: number | null; state: string }>>
    spawn(request: {
      cwd: string
      command?: string
      args?: string[]
      env?: Record<string, string>
      meta?: Record<string, string>
    }): Promise<{ id: string; pid: number | null }>
  }
  __bancadaTerminals?: Record<string, E2eTerminal>
  __bancadaStatus?: Record<string, string>
  __bench?: BenchPageHandle
}

// The bench page (src/renderer/src/bench/BenchApp.tsx).
interface BenchPageHandle {
  ready: Promise<void>
  start(): void
  waitEcho(count: number, timeoutMs: number): Promise<number>
  noteMissed(): void
  stop(): {
    frames: number
    dropped: number
    deltas: { median: number; p95: number; max: number }
    echoLatencies: number[]
    echoMissed: number
  }
  renderers(): { webgl: number; dom: number; contextLoss: number; unsupported: number }
  sessionIds(): string[]
}
