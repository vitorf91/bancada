import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { type MutableRefObject, useEffect, useRef } from 'react'
import { ApiError, api, NetworkError } from '../api.js'

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'missing'

export interface StreamMeta {
  title: string | null
  cols: number
  rows: number
}

interface Props {
  sessionId: string
  /** Filled with a function that types into the session (JSON `input` message over the WebSocket). */
  sendRef: MutableRefObject<((data: string) => void) | null>
  onStatus(status: StreamStatus): void
  onMeta(meta: StreamMeta): void
  onUnauthorized(): void
}

const FONT_SIZE = 12

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * Read view of a session: an xterm.js terminal created at the session's own columns and rows (the phone never
 * resizes the pty), scaled with a CSS transform so its width fits the screen. Drag and wheel scroll its scrollback.
 */
export function TerminalView({ sessionId, sendRef, onStatus, onMeta, onUnauthorized }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onStatus, onMeta, onUnauthorized })
  callbacks.current = { onStatus, onMeta, onUnauthorized }

  useEffect(() => {
    const viewport = viewportRef.current
    const box = boxRef.current
    const inner = innerRef.current
    if (!viewport || !box || !inner) return

    let disposed = false
    let term: Terminal | null = null
    let ws: WebSocket | null = null
    let retryTimer: number | undefined
    let retries = 0
    let scale = 1
    let lineHeightPx = 16
    const { onStatus: status } = callbacks.current

    const layout = (): void => {
      const screen = inner.querySelector<HTMLElement>('.xterm-screen')
      if (!term || !screen) return
      const naturalW = screen.offsetWidth
      const naturalH = screen.offsetHeight
      if (naturalW === 0 || naturalH === 0) return
      scale = Math.min(1, viewport.clientWidth / naturalW)
      lineHeightPx = (naturalH / term.rows) * scale
      box.style.width = `${naturalW * scale}px`
      box.style.height = `${naturalH * scale}px`
      inner.style.transform = `scale(${scale})`
      // Taller than the screen: keep the bottom (the prompt) in view; scrolling moves through the scrollback.
      box.style.marginTop = `${Math.min(0, viewport.clientHeight - naturalH * scale)}px`
    }

    const open = (): void => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${protocol}//${location.host}/api/sessions/${encodeURIComponent(sessionId)}/stream`)
      socket.binaryType = 'arraybuffer'
      ws = socket
      sendRef.current = (data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
      }
      socket.onmessage = (event) => {
        if (!term) return
        if (typeof event.data !== 'string') {
          term.write(new Uint8Array(event.data as ArrayBuffer))
          return
        }
        const message = JSON.parse(event.data) as {
          type: string
          cols?: number
          rows?: number
          data?: string
          title?: string | null
          code?: string
          state?: string
        }
        if (message.type === 'snapshot' && message.cols && message.rows) {
          retries = 0
          term.resize(message.cols, message.rows)
          term.reset()
          term.write(message.data ?? '', () => {
            term?.scrollToBottom()
            layout()
          })
          callbacks.current.onMeta({ title: message.title ?? null, cols: message.cols, rows: message.rows })
          status(message.state === 'running' ? 'live' : 'ended')
        } else if (message.type === 'title') {
          callbacks.current.onMeta({ title: message.title ?? null, cols: term.cols, rows: term.rows })
        } else if (message.type === 'exit') {
          status('ended')
        }
      }
      socket.onclose = (event) => {
        if (disposed || ws !== socket) return
        if (event.code === 4404) {
          status('missing')
          return
        }
        if (event.code === 4401) {
          callbacks.current.onUnauthorized()
          return
        }
        status('reconnecting')
        scheduleReconnect()
      }
    }

    const scheduleReconnect = (): void => {
      window.clearTimeout(retryTimer)
      retryTimer = window.setTimeout(
        async () => {
          if (disposed) return
          try {
            await api.me() // a revoked device cannot see why the socket failed: ask
          } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
              callbacks.current.onUnauthorized()
              return
            }
            if (!(error instanceof NetworkError)) throw error
          }
          retries++
          open()
        },
        Math.min(1000 * 2 ** retries, 8000),
      )
    }

    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || disposed) return
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        status('reconnecting')
        scheduleReconnect()
      }
    }

    // Dragging or wheeling over the terminal scrolls its scrollback.
    let lastY: number | null = null
    let carry = 0
    const scrollBy = (pixels: number): void => {
      carry += pixels / lineHeightPx
      const lines = Math.trunc(carry)
      if (lines !== 0) {
        term?.scrollLines(lines)
        carry -= lines
      }
    }
    const onTouchStart = (event: TouchEvent): void => {
      lastY = event.touches[0]?.clientY ?? null
    }
    const onTouchMove = (event: TouchEvent): void => {
      const y = event.touches[0]?.clientY
      if (y === undefined || lastY === null) return
      event.preventDefault()
      scrollBy(lastY - y)
      lastY = y
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      scrollBy(event.deltaY)
    }
    viewport.addEventListener('touchstart', onTouchStart, { passive: true })
    viewport.addEventListener('touchmove', onTouchMove, { passive: false })
    viewport.addEventListener('wheel', onWheel, { passive: false })

    const observer = new ResizeObserver(layout)
    observer.observe(viewport)
    document.addEventListener('visibilitychange', onVisible)

    status('connecting')
    // The cell size is measured when the terminal opens, so the font has to be loaded first.
    void document.fonts
      .load(`${FONT_SIZE}px "Geist Mono Variable"`)
      .catch(() => undefined)
      .then(() => {
        if (disposed) return
        term = new Terminal({
          disableStdin: true,
          cursorBlink: false,
          cursorInactiveStyle: 'none',
          scrollback: 500,
          fontFamily: cssVar('--font-mono'),
          fontSize: FONT_SIZE,
          lineHeight: 1.2,
          theme: { background: cssVar('--color-terminal'), foreground: cssVar('--color-terminal-fg') },
        })
        term.open(inner)
        open()
      })

    return () => {
      disposed = true
      window.clearTimeout(retryTimer)
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisible)
      viewport.removeEventListener('touchstart', onTouchStart)
      viewport.removeEventListener('touchmove', onTouchMove)
      viewport.removeEventListener('wheel', onWheel)
      sendRef.current = null
      ws?.close()
      term?.dispose()
    }
  }, [sessionId, sendRef])

  return (
    <div className="term-frame" data-testid="terminal">
      <div className="term-viewport" ref={viewportRef}>
        <div className="term-box" ref={boxRef}>
          <div className="term-inner" ref={innerRef} />
        </div>
      </div>
    </div>
  )
}
