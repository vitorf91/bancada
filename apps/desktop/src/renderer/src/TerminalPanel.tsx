import { type Terminal, type TerminalStatus, type TerminalStatusDetail, TerminalView } from '@bancada/ui'
import type { IDockviewPanelProps } from 'dockview-react'
import { GitBranch, PowerOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PanelTarget } from './drag-payload.js'
import { productColorStyle } from './drag-payload.js'
import { PanelBoundary } from './PanelBoundary.js'
import { branchAddsInfo } from './panel-header.js'
import { createConnect } from './terminal-link.js'

/** What a board panel keeps in the saved board: the worktree it was opened from and its session. */
export type TerminalPanelParams = PanelTarget & {
  /** The pty-host session; null when it could not be started (then `error` says why). */
  sessionId: string | null
  error?: string
}

declare global {
  interface Window {
    /** e2e only (`BANCADA_TEST_HOOKS=1`): the live xterm instances and their view status, by session id. */
    __bancadaTerminals?: Record<string, Terminal>
    __bancadaStatus?: Record<string, string>
  }
}

/** e2e hooks on `window`, created on first use. */
function testRegistry(): { terminals: Record<string, Terminal>; status: Record<string, string> } {
  window.__bancadaTerminals ??= {}
  window.__bancadaStatus ??= {}
  return { terminals: window.__bancadaTerminals, status: window.__bancadaStatus }
}

function usePanelState(api: IDockviewPanelProps['api']): { visible: boolean; active: boolean } {
  const [visible, setVisible] = useState(api.isVisible)
  const [active, setActive] = useState(api.isActive)
  useEffect(() => {
    const subscriptions = [
      api.onDidVisibilityChange((event) => setVisible(event.isVisible)),
      api.onDidActiveChange((event) => setActive(event.isActive)),
    ]
    setVisible(api.isVisible)
    setActive(api.isActive)
    return () => {
      for (const subscription of subscriptions) subscription.dispose()
    }
  }, [api])
  return { visible, active }
}

function Header({ params, ended }: { params: TerminalPanelParams; ended: boolean }) {
  return (
    <header className="term-panel__head">
      <span className="term-panel__swatch" aria-hidden="true" />
      <span className="term-panel__product" data-testid="panel-product">
        {params.productName}
      </span>
      <span className="term-panel__worktree" data-testid="panel-worktree" title={params.path}>
        {params.name}
      </span>
      {branchAddsInfo(params.branch, params.name) && (
        <span className="term-panel__branch" data-testid="panel-branch">
          <GitBranch size={12} aria-hidden="true" />
          {params.branch}
        </span>
      )}
      <span className={ended ? 'chip chip--ended' : 'chip'} data-testid="panel-status">
        <span className="chip__dot" aria-hidden="true" />
        {ended ? 'encerrada' : 'shell'}
      </span>
    </header>
  )
}

function Content({ api, params }: IDockviewPanelProps<TerminalPanelParams>) {
  const { visible, active } = usePanelState(api)
  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const [detail, setDetail] = useState<TerminalStatusDetail | undefined>()
  const { sessionId } = params
  const connect = useMemo(() => (sessionId ? createConnect(window.bancada, sessionId) : null), [sessionId])

  const onStatus = useCallback(
    (next: TerminalStatus, nextDetail?: TerminalStatusDetail) => {
      setStatus(next)
      setDetail(nextDetail)
      // A panel hidden behind another tab is not in the DOM, so its status is not readable from there.
      if (window.bancada.testMode && sessionId) testRegistry().status[sessionId] = next
    },
    [sessionId],
  )
  const onTerminal = useCallback(
    (terminal: Terminal | null) => {
      if (!window.bancada.testMode || !sessionId) return
      const registry = testRegistry().terminals
      if (terminal) registry[sessionId] = terminal
      else delete registry[sessionId]
    },
    [sessionId],
  )

  const noSession = connect === null
  const gone = status === 'ended' && detail?.message === 'gone'
  const ended = noSession || status === 'ended'

  return (
    <section
      className="term-panel"
      data-testid="panel"
      data-panel-id={api.id}
      data-session-id={sessionId ?? ''}
      data-project={params.projectName}
      data-status={noSession ? 'ended' : status}
      style={productColorStyle(params.color)}
    >
      <Header params={params} ended={ended} />
      <div className="term-panel__body">
        {noSession || gone ? (
          <div className="term-panel__state" data-testid="panel-ended">
            <PowerOff size={18} aria-hidden="true" />
            <strong>sessão encerrada</strong>
            <span>
              {params.error ? 'Não foi possível abrir o terminal:' : 'Este terminal não existe mais no pty-host.'}
            </span>
            {params.error && <code>{params.error}</code>}
          </div>
        ) : (
          <>
            <TerminalView
              id={api.id}
              connect={connect}
              visible={visible}
              active={active}
              onStatus={onStatus}
              onTerminal={onTerminal}
            />
            {status === 'ended' && (
              <div className="term-panel__notice" role="status" data-testid="panel-ended">
                <PowerOff size={14} aria-hidden="true" />
                sessão encerrada
                {detail?.exitCode != null && ` (código ${detail.exitCode})`}
              </div>
            )}
            {status === 'error' && (
              <div className="term-panel__notice" role="alert">
                {detail?.message ?? 'Falha ao conectar'}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

/** Board panel of a worktree: a shell session in a terminal, behind an error boundary. */
export function TerminalPanel(props: IDockviewPanelProps<TerminalPanelParams>) {
  return (
    <PanelBoundary>
      <Content {...props} />
    </PanelBoundary>
  )
}
