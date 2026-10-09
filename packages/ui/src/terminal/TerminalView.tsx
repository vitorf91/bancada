import type { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import { TerminalController } from './controller.js'
import type {
  TerminalConnect,
  TerminalRendererKind,
  TerminalRendererReason,
  TerminalStatus,
  TerminalStatusDetail,
} from './types.js'
import { type WebglBudget, webglBudget } from './webgl-budget.js'

export interface TerminalViewProps {
  /** Unique per view; the WebGL budget keys on it. */
  id: string
  connect: TerminalConnect
  /** The pane is visible. Hidden panes detach from the session and give their WebGL slot back. Default true. */
  visible?: boolean
  /** The pane is the focused one: the terminal takes keyboard focus. */
  active?: boolean
  /** Default: the shared budget of the window. `null` forces the DOM renderer. */
  budget?: WebglBudget | null
  className?: string
  onStatus?: (status: TerminalStatus, detail?: TerminalStatusDetail) => void
  onRenderer?: (kind: TerminalRendererKind, reason: TerminalRendererReason) => void
  onTerminal?: (terminal: Terminal | null) => void
}

/**
 * xterm.js 6 bound to one session through `connect`: writes the snapshot, then the live bytes; fits to its box and
 * tells the pty; Shift+Enter sends ESC CR; WebGL when the budget allows, the DOM renderer otherwise (and after a
 * context loss).
 */
export function TerminalView(props: TerminalViewProps) {
  const { id, connect, visible = true, active = false, budget = webglBudget, className } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<TerminalController | null>(null)
  // Callbacks and flags change every render; the controller is created once per (id, connect, budget).
  const latest = useRef({ ...props, visible, active })
  latest.current = { ...props, visible, active }

  // `visible` and `active` are applied by their own effects below; changing them must not rebuild the terminal.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const controller = new TerminalController(host, {
      id,
      connect,
      budget,
      onStatus: (status, detail) => latest.current.onStatus?.(status, detail),
      onRenderer: (kind, reason) => latest.current.onRenderer?.(kind, reason),
      onTerminal: (terminal) => latest.current.onTerminal?.(terminal),
    })
    controller.setVisible(latest.current.visible)
    controllerRef.current = controller
    void controller.start().then(() => {
      if (latest.current.active) controller.setActive(true)
    })
    return () => {
      controllerRef.current = null
      controller.dispose()
    }
  }, [id, connect, budget])

  useEffect(() => {
    controllerRef.current?.setVisible(visible)
  }, [visible])

  useEffect(() => {
    controllerRef.current?.setActive(active)
  }, [active])

  return <div ref={hostRef} className={className ? `terminal-view ${className}` : 'terminal-view'} />
}
