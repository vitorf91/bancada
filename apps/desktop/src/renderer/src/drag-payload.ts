import type { WorktreeKind } from '@bancada/workspace/types'
import type { CSSProperties } from 'react'

/** What a sidebar item carries when dragged, and what a board panel keeps as its params. */
export type PanelTarget = {
  productId: string
  productName: string
  /** Product accent color (CSS color string from the config). */
  color: string
  projectName: string
  /** Worktree name, or the folder name for a plain-folder project. */
  name: string
  /** Short branch name; null for a detached worktree or a plain folder. */
  branch: string | null
  path: string
  kind: WorktreeKind | 'folder'
}

export const WORKTREE_MIME = 'application/x-bancada-worktree'

export function writeDragPayload(dataTransfer: DataTransfer, target: PanelTarget): void {
  dataTransfer.setData(WORKTREE_MIME, JSON.stringify(target))
  dataTransfer.effectAllowed = 'copy'
}

/** During dragover the browser exposes the types but not the data: use this to decide whether to accept. */
export function hasWorktreePayload(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(WORKTREE_MIME) ?? false
}

/** Only valid in a drop handler. Returns null for anything that is not a well-formed sidebar payload. */
export function readDragPayload(event: DragEvent): PanelTarget | null {
  const raw = event.dataTransfer?.getData(WORKTREE_MIME)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<PanelTarget>
    const strings = [
      value.productId,
      value.productName,
      value.color,
      value.projectName,
      value.name,
      value.path,
      value.kind,
    ]
    if (strings.some((s) => typeof s !== 'string') || !(value.branch === null || typeof value.branch === 'string'))
      return null
    return value as PanelTarget
  } catch {
    return null
  }
}

/** Inline style that sets the `--product-color` custom property used by the sidebar and panels. */
export function productColorStyle(color: string): CSSProperties {
  return { '--product-color': color } as CSSProperties
}
