import { TriangleAlert } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/** A panel that throws must not take the board down: it shows a small error state with a retry. */
export class PanelBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Panel failed', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="term-panel__state" role="alert" data-testid="panel-error">
        <TriangleAlert size={18} aria-hidden="true" />
        <strong>Este painel falhou</strong>
        <code>{error.message}</code>
        <button type="button" className="text-button" onClick={() => this.setState({ error: null })}>
          Tentar de novo
        </button>
      </div>
    )
  }
}
