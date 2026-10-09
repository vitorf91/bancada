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
}
