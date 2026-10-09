import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { createKeyHandler } from './keys.js'
import { readTerminalFont, readTerminalTheme } from './theme.js'
import {
  DEFAULT_SCROLLBACK_LINES,
  type TerminalConnect,
  type TerminalEvent,
  TerminalGoneError,
  type TerminalLink,
  type TerminalRendererKind,
  type TerminalRendererReason,
  type TerminalSnapshot,
  type TerminalStatus,
  type TerminalStatusDetail,
} from './types.js'
import type { WebglBudget } from './webgl-budget.js'

export interface TerminalControllerOptions {
  /** Identifies the terminal to the WebGL budget. */
  id: string
  connect: TerminalConnect
  /** Which terminals may use WebGL. Without one, the DOM renderer is used. */
  budget?: WebglBudget | null
  scrollback?: number
  onStatus?: (status: TerminalStatus, detail?: TerminalStatusDetail) => void
  onRenderer?: (kind: TerminalRendererKind, reason: TerminalRendererReason) => void
  /** The xterm instance, once created (and null when disposed). The bench and the e2e tests read it. */
  onTerminal?: (terminal: Terminal | null) => void
}

const FONT_LOAD_TIMEOUT_MS = 1500

function isGone(error: unknown): boolean {
  return error instanceof TerminalGoneError || (error as { code?: unknown } | null)?.code === 'not_found'
}

/**
 * One xterm instance bound to one session. Imperative on purpose: attach/detach, fit, resize, focus and the WebGL
 * budget are events, and React re-renders would only get in their way. `TerminalView` is the thin React shell.
 */
export class TerminalController {
  readonly term: Terminal
  private readonly fit = new FitAddon()
  private readonly scrollback: number
  private resizeObserver: ResizeObserver | null = null
  private frame = 0
  private link: TerminalLink | null = null
  private generation = 0
  private opened = false
  private disposed = false
  private visible = true
  private status: TerminalStatus = 'connecting'
  private webgl: WebglAddon | null = null
  private unregisterBudget: (() => void) | null = null
  private resizeClaimed = false
  private readonly cleanups: Array<() => void> = []

  constructor(
    private readonly host: HTMLElement,
    private readonly options: TerminalControllerOptions,
  ) {
    this.scrollback = options.scrollback ?? DEFAULT_SCROLLBACK_LINES
    const font = readTerminalFont(host)
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: font.family,
      fontSize: font.size,
      lineHeight: font.lineHeight,
      theme: readTerminalTheme(host),
    })
  }

  /** Waits for the font (cell metrics depend on it), opens the terminal and attaches when visible. */
  async start(): Promise<void> {
    await this.loadFont()
    if (this.disposed) return
    const { term, host } = this
    term.open(host)
    this.opened = true
    term.loadAddon(this.fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(new WebLinksAddon())
    term.attachCustomKeyEventHandler(createKeyHandler((data) => this.send(data)))
    term.onData((data) => this.send(data))

    const onFocus = (): void => this.claim()
    const onBlur = (): void => {
      this.resizeClaimed = false
    }
    host.addEventListener('focusin', onFocus)
    host.addEventListener('focusout', onBlur)
    this.cleanups.push(
      () => host.removeEventListener('focusin', onFocus),
      () => host.removeEventListener('focusout', onBlur),
    )

    this.resizeObserver = new ResizeObserver(() => {
      if (this.frame) return
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        this.refit(false)
      })
    })
    this.resizeObserver.observe(host)

    const { budget, id } = this.options
    if (budget) {
      this.unregisterBudget = budget.register(id, (granted) => this.syncWebgl(granted))
      if (!this.visible) budget.setVisible(id, false)
    }
    this.options.onTerminal?.(term)
    if (this.visible) void this.connect()
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.options.budget?.setVisible(this.options.id, visible)
    if (!this.opened) return
    if (visible) void this.connect()
    else this.detach()
  }

  setActive(active: boolean): void {
    if (active && this.opened && this.visible) this.term.focus()
  }

  focus(): void {
    this.term.focus()
  }

  /** The kind of renderer in use right now. */
  get renderer(): TerminalRendererKind {
    return this.webgl ? 'webgl' : 'dom'
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    cancelAnimationFrame(this.frame)
    this.resizeObserver?.disconnect()
    for (const cleanup of this.cleanups) cleanup()
    this.unregisterBudget?.()
    this.link?.close()
    this.link = null
    this.options.onTerminal?.(null)
    // The WebGL addon is disposed with the terminal; doing it first releases the context before the canvas goes.
    this.webgl?.dispose()
    this.webgl = null
    this.term.dispose()
  }

  private async loadFont(): Promise<void> {
    const font = readTerminalFont(this.host)
    const family = font.family?.split(',')[0]?.trim()
    if (!family || !document.fonts) return
    const load = document.fonts.load(`${font.size ?? 12}px ${family}`).catch(() => [])
    await Promise.race([load, new Promise((resolve) => setTimeout(resolve, FONT_LOAD_TIMEOUT_MS))])
  }

  private setStatus(status: TerminalStatus, detail?: TerminalStatusDetail): void {
    this.status = status
    this.options.onStatus?.(status, detail)
  }

  private async connect(): Promise<void> {
    if (this.link) return
    const generation = ++this.generation
    this.setStatus('connecting')
    let link: TerminalLink
    try {
      link = await this.options.connect({ scrollback: this.scrollback })
    } catch (error) {
      if (generation !== this.generation || this.disposed) return
      if (isGone(error)) this.setStatus('ended', { message: 'gone' })
      else this.setStatus('error', { message: error instanceof Error ? error.message : String(error) })
      return
    }
    if (generation !== this.generation || this.disposed || !this.visible) {
      link.close()
      return
    }
    this.link = link
    link.onOutput((bytes) => this.term.write(bytes))
    link.onEvent((event) => this.onLinkEvent(link, event))
    this.restore(link.snapshot)
    this.setStatus('live')
    this.resizeClaimed = false
    // The host's size is whoever resized last; this view is the one the user just opened.
    this.refit(true)
  }

  private detach(): void {
    this.generation++
    this.link?.close()
    this.link = null
    if (this.status !== 'ended') this.setStatus('detached')
  }

  private onLinkEvent(link: TerminalLink, event: TerminalEvent): void {
    if (link !== this.link) return
    if (event.type === 'snapshot') {
      this.restore(event)
      this.refit(true)
    } else if (event.type === 'exit') {
      this.setStatus('ended', { exitCode: event.exitCode })
    } else {
      this.link = null
      this.setStatus('ended', { message: 'closed' })
    }
  }

  /** Writes a snapshot into a fresh screen of the size it was taken at; the fit that follows reflows it. */
  private restore(snapshot: TerminalSnapshot): void {
    this.term.reset()
    this.term.resize(snapshot.cols, snapshot.rows)
    this.term.write(snapshot.data)
  }

  private send(data: string): void {
    if (!this.link) return
    this.claim()
    this.link.write(data)
  }

  /** Focus or typing: this view becomes the most recent for the WebGL budget and the size of the pty. */
  private claim(): void {
    this.options.budget?.touch(this.options.id)
    if (this.resizeClaimed || !this.link) return
    this.resizeClaimed = true
    this.link.resize(this.term.cols, this.term.rows)
  }

  /** Fits to the container and tells the pty. A hidden or not yet laid out container (0x0) is skipped. */
  private refit(force: boolean): void {
    if (!this.opened || this.disposed) return
    if (this.host.clientWidth === 0 || this.host.clientHeight === 0) return
    const dims = this.fit.proposeDimensions()
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 1) return
    const changed = dims.cols !== this.term.cols || dims.rows !== this.term.rows
    if (changed) this.term.resize(dims.cols, dims.rows)
    if (changed || force) {
      this.link?.resize(this.term.cols, this.term.rows)
      this.resizeClaimed = true
    }
  }

  private syncWebgl(granted: boolean): void {
    if (this.disposed || !this.opened) return
    const { budget, id } = this.options
    if (granted && !this.webgl) {
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          if (this.webgl !== addon) return
          this.webgl = null
          addon.dispose()
          budget?.markLost(id)
          this.options.onRenderer?.('dom', 'context-loss')
        })
        this.term.loadAddon(addon)
        this.webgl = addon
        this.options.onRenderer?.('webgl', 'granted')
      } catch {
        budget?.markLost(id)
        this.options.onRenderer?.('dom', 'unsupported')
      }
    } else if (!granted && this.webgl) {
      this.webgl.dispose()
      this.webgl = null
      this.options.onRenderer?.('dom', 'budget')
    }
  }
}
