import {
  type TerminalConnect,
  type TerminalEvent,
  TerminalGoneError,
  type TerminalLink,
  type TerminalSnapshot,
} from '@bancada/ui'
import { type BancadaApi, PORT_WINDOW_CHANNEL, type TerminalPortMessage } from '../../shared/api.js'

const PORT_TIMEOUT_MS = 10_000

/** Ports handed over by the preload, waiting for the `attach` that asked for them. */
const waiting = new Map<string, (port: MessagePort) => void>()
let listening = false

function listenForPorts(): void {
  if (listening) return
  listening = true
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data as { type?: unknown; viewId?: unknown } | null
    if (data?.type !== PORT_WINDOW_CHANNEL || typeof data.viewId !== 'string') return
    const port = event.ports[0]
    if (!port) return
    const resolve = waiting.get(data.viewId)
    if (resolve) {
      waiting.delete(data.viewId)
      resolve(port)
    } else {
      port.close()
    }
  })
}

/** The code main put in an IPC error (`bancada:<code>:<message>`), if any. */
export function errorCode(error: unknown): string | undefined {
  return /bancada:([a-z_]+):/.exec(error instanceof Error ? error.message : String(error))?.[1]
}

/**
 * A `TerminalConnect` over the desktop bridge: asks main to attach a view, receives the MessagePort the preload
 * hands to the page, and exposes it as a `TerminalLink` (snapshot first, then bytes straight off the port).
 */
export function createConnect(api: BancadaApi, sessionId: string): TerminalConnect {
  listenForPorts()
  return async ({ scrollback }) => {
    const viewId = crypto.randomUUID()
    const port = new Promise<MessagePort>((resolve, reject) => {
      waiting.set(viewId, resolve)
      setTimeout(() => {
        if (waiting.delete(viewId)) reject(new Error('Timed out waiting for the terminal port'))
      }, PORT_TIMEOUT_MS)
    })
    port.catch(() => {})
    try {
      await api.attach(sessionId, viewId, { scrollback })
    } catch (error) {
      waiting.delete(viewId)
      if (errorCode(error) === 'not_found') throw new TerminalGoneError(`Session ${sessionId} is gone`)
      throw error
    }
    return openLink(api, sessionId, viewId, await port)
  }
}

function openLink(api: BancadaApi, sessionId: string, viewId: string, port: MessagePort): Promise<TerminalLink> {
  let outputListener: ((bytes: Uint8Array) => void) | null = null
  let eventListener: ((event: TerminalEvent) => void) | null = null
  // Anything that arrives before the consumer subscribes waits here.
  const early: Array<Uint8Array | TerminalEvent> = []
  let closed = false

  const deliver = (item: Uint8Array | TerminalEvent): void => {
    if (item instanceof Uint8Array) {
      if (outputListener) outputListener(item)
      else early.push(item)
    } else if (eventListener) {
      eventListener(item)
    } else {
      early.push(item)
    }
  }

  return new Promise<TerminalLink>((resolve, reject) => {
    let first = true
    port.onmessage = (message: MessageEvent) => {
      const data: unknown = message.data
      if (ArrayBuffer.isView(data)) {
        deliver(data as Uint8Array)
        return
      }
      const typed = data as TerminalPortMessage
      if (first) {
        first = false
        if (typed.t !== 'snapshot') {
          reject(new Error(`Unexpected first terminal message: ${typed.t}`))
          return
        }
        const snapshot: TerminalSnapshot = { cols: typed.cols, rows: typed.rows, data: typed.data }
        resolve({
          snapshot,
          onOutput(listener) {
            outputListener = listener
            for (const item of early.splice(0)) if (item instanceof Uint8Array) listener(item)
          },
          onEvent(listener) {
            eventListener = listener
            for (const item of early.splice(0)) if (!(item instanceof Uint8Array)) listener(item)
          },
          write: (text) => api.write(sessionId, text),
          resize: (cols, rows) => api.resize(sessionId, cols, rows),
          close() {
            if (closed) return
            closed = true
            port.close()
            api.detach(viewId).catch(() => {})
          },
        })
        return
      }
      if (typed.t === 'snapshot') deliver({ type: 'snapshot', cols: typed.cols, rows: typed.rows, data: typed.data })
      else if (typed.t === 'exit') deliver({ type: 'exit', exitCode: typed.exitCode, signal: typed.signal })
      else deliver({ type: 'closed' })
    }
  })
}
