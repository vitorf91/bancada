import type { IDockviewPanelProps } from 'dockview-react'
import { GitBranch } from 'lucide-react'
import { type PanelTarget, productColorStyle } from './drag-payload.js'

/** Placeholder content of a board panel. F1 replaces it with a terminal. */
export function WorktreePanel({ api, params }: IDockviewPanelProps<PanelTarget>) {
  return (
    <section className="wt-panel" data-testid="panel" data-panel-id={api.id} style={productColorStyle(params.color)}>
      <header className="wt-panel__head">
        <span className="wt-panel__swatch" aria-hidden="true" />
        <span className="wt-panel__product">{params.productName}</span>
      </header>
      <dl className="wt-panel__meta">
        <dt>Project</dt>
        <dd data-testid="panel-project">{params.projectName}</dd>
        <dt>Worktree</dt>
        <dd data-testid="panel-worktree">{params.name}</dd>
        <dt>Branch</dt>
        <dd data-testid="panel-branch">
          <GitBranch size={14} aria-hidden="true" />{' '}
          {params.branch ?? (params.kind === 'folder' ? 'no git' : 'detached')}
        </dd>
        <dt>Path</dt>
        <dd className="wt-panel__path">{params.path}</dd>
      </dl>
    </section>
  )
}
