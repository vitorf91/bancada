import type {
  DiscoveredProduct,
  DiscoveredProject,
  DiscoveredRepo,
  DiscoveryResult,
  Worktree,
} from '@bancada/workspace/types'
import { ChevronDown, ChevronRight, Folder, FolderGit2, GitBranch, Lock, RefreshCw, TriangleAlert } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { type PanelTarget, productColorStyle, writeDragPayload } from './drag-payload.js'

interface SidebarProps {
  discovery: DiscoveryResult | null
  failure: string | null
  loading: boolean
  onRefresh(): void
  onOpen(target: PanelTarget): void
}

/** A row that can be dragged onto the board or activated (click / Enter) to open it next to the active panel. */
function DraggableRow({
  target,
  onOpen,
  children,
  testId,
}: {
  target: PanelTarget
  onOpen(target: PanelTarget): void
  children: ReactNode
  testId: string
}) {
  return (
    <button
      type="button"
      className="row row--item"
      draggable
      data-testid={testId}
      data-path={target.path}
      onDragStart={(event) => writeDragPayload(event.dataTransfer, target)}
      onClick={() => onOpen(target)}
    >
      {children}
    </button>
  )
}

function Disclosure({
  open,
  onToggle,
  children,
  testId,
}: {
  open: boolean
  onToggle(): void
  children: ReactNode
  testId?: string
}) {
  return (
    <button type="button" className="row row--toggle" aria-expanded={open} onClick={onToggle} data-testid={testId}>
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      {children}
    </button>
  )
}

function WorktreeRow({
  worktree,
  product,
  project,
  onOpen,
}: {
  worktree: Worktree
  product: DiscoveredProduct
  project: DiscoveredProject
  onOpen(target: PanelTarget): void
}) {
  const target: PanelTarget = {
    productId: product.id,
    productName: product.name,
    color: product.color,
    projectName: project.name,
    name: worktree.name,
    branch: worktree.branch,
    path: worktree.path,
    kind: worktree.kind,
  }
  return (
    <li>
      <DraggableRow target={target} onOpen={onOpen} testId="worktree">
        <GitBranch size={14} aria-hidden="true" />
        <span className="row__name">{worktree.name}</span>
        <span className="row__meta">{worktree.branch ?? 'detached'}</span>
        {worktree.locked && <Lock size={12} aria-label="locked" />}
        {worktree.prunable && <TriangleAlert size={12} aria-label="stale worktree" />}
      </DraggableRow>
    </li>
  )
}

function RepoNode({
  repo,
  product,
  project,
  onOpen,
  showName,
}: {
  repo: DiscoveredRepo
  product: DiscoveredProduct
  project: DiscoveredProject
  onOpen(target: PanelTarget): void
  showName: boolean
}) {
  const [showCollapsed, setShowCollapsed] = useState(false)
  const visible = repo.worktrees.filter((w) => !w.collapsed)
  const hidden = repo.worktrees.filter((w) => w.collapsed)
  const rows = (list: Worktree[]) =>
    list.map((w) => <WorktreeRow key={w.path} worktree={w} product={product} project={project} onOpen={onOpen} />)
  return (
    <div className="repo" data-testid="repo" data-repo={repo.name}>
      {showName && (
        <div className="row row--label">
          <FolderGit2 size={14} aria-hidden="true" />
          <span className="row__name">{repo.name}</span>
        </div>
      )}
      {repo.error && (
        <p className="row row--error" role="alert">
          <TriangleAlert size={14} aria-hidden="true" /> {repo.error}
        </p>
      )}
      <ul className="list">
        {rows(visible)}
        {hidden.length > 0 && (
          <li>
            <Disclosure
              open={showCollapsed}
              onToggle={() => setShowCollapsed(!showCollapsed)}
              testId="collapsed-toggle"
            >
              <span className="row__meta">
                {hidden.length} agent {hidden.length === 1 ? 'worktree' : 'worktrees'}
              </span>
            </Disclosure>
            {showCollapsed && <ul className="list list--nested">{rows(hidden)}</ul>}
          </li>
        )}
      </ul>
    </div>
  )
}

function ProjectNode({
  product,
  project,
  onOpen,
}: {
  product: DiscoveredProduct
  project: DiscoveredProject
  onOpen(target: PanelTarget): void
}) {
  const [open, setOpen] = useState(true)
  const folderTarget: PanelTarget = {
    productId: product.id,
    productName: product.name,
    color: product.color,
    projectName: project.name,
    name: project.name,
    branch: null,
    path: project.path,
    kind: 'folder',
  }
  if (project.kind === 'folder') {
    return (
      <li data-testid="project" data-kind="folder">
        <DraggableRow target={folderTarget} onOpen={onOpen} testId="folder">
          <Folder size={14} aria-hidden="true" />
          <span className="row__name">{project.name}</span>
          <span className="row__meta">folder</span>
        </DraggableRow>
      </li>
    )
  }
  if (project.kind === 'error') {
    return (
      <li data-testid="project" data-kind="error">
        <div className="row row--error" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span className="row__name">{project.name}</span>
          <span className="row__meta">{project.error}</span>
        </div>
      </li>
    )
  }
  return (
    <li data-testid="project" data-kind={project.kind}>
      <Disclosure open={open} onToggle={() => setOpen(!open)}>
        <FolderGit2 size={14} aria-hidden="true" />
        <span className="row__name">{project.name}</span>
        {project.kind === 'group' && <span className="row__meta">{project.repos.length} repos</span>}
      </Disclosure>
      {open &&
        project.repos.map((repo) => (
          <RepoNode
            key={repo.path}
            repo={repo}
            product={product}
            project={project}
            onOpen={onOpen}
            showName={project.kind === 'group'}
          />
        ))}
    </li>
  )
}

function ProductNode({ product, onOpen }: { product: DiscoveredProduct; onOpen(target: PanelTarget): void }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="product" data-testid="product" style={productColorStyle(product.color)}>
      <Disclosure open={open} onToggle={() => setOpen(!open)}>
        <span className="swatch" aria-hidden="true" />
        <span className="row__name">{product.name}</span>
      </Disclosure>
      {open && (
        <ul className="list">
          {product.projects.map((project) => (
            <ProjectNode key={project.path} product={product} project={project} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  )
}

export function Sidebar({ discovery, failure, loading, onRefresh, onOpen }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="Workspace" data-testid="sidebar">
      <header className="sidebar__head">
        <h1 className="sidebar__title">Bancada</h1>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh workspace"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </header>
      {failure && (
        <p className="notice notice--error" role="alert">
          {failure}
        </p>
      )}
      {discovery?.configError && (
        <p className="notice notice--error" role="alert">
          {discovery.configError}
        </p>
      )}
      {discovery?.configMissing && (
        <p className="notice">
          No config found at <code>{discovery.configPath}</code>. See docs/config.example.toml.
        </p>
      )}
      {discovery?.products.map((product) => (
        <ProductNode key={product.id} product={product} onOpen={onOpen} />
      ))}
    </nav>
  )
}
