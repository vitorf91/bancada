import {
  type AddPanelPositionOptions,
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type IWatermarkPanelProps,
  type SerializedDockview,
} from 'dockview-react'
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import { hasWorktreePayload, type PanelTarget, readDragPayload } from './drag-payload.js'
import { TerminalPanel, type TerminalPanelParams } from './TerminalPanel.js'

const BOARD_ID = 'default'
const SAVE_DEBOUNCE_MS = 300

export interface BoardHandle {
  /** Open a target as a new split to the right of the active group (or as the first panel). */
  open(target: PanelTarget): void
}

// The component key stays `worktree`: boards saved by earlier builds name it.
const components = { worktree: TerminalPanel }

function Watermark(_props: IWatermarkPanelProps) {
  return <div className="board__empty">Arraste um worktree da barra lateral para abrir um terminal.</div>
}

const DIRECTION = { top: 'above', bottom: 'below', left: 'left', right: 'right' } as const

export function Board({ ref }: { ref?: Ref<BoardHandle> }) {
  const apiRef = useRef<DockviewApi | null>(null)
  const restoredRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const saveNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    const api = apiRef.current
    if (!api || !restoredRef.current) return
    window.bancada.saveBoard(BOARD_ID, { version: 1, layout: api.toJSON() }).catch((error: unknown) => {
      console.error('Saving the board failed', error)
    })
  }, [])

  const scheduleSave = useCallback(() => {
    if (!restoredRef.current) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(saveNow, SAVE_DEBOUNCE_MS)
  }, [saveNow])

  // A pending debounced save must not be lost when the window closes.
  useEffect(() => {
    const flush = () => {
      if (timerRef.current) saveNow()
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [saveNow])

  /** Starts a shell in the worktree, then puts it on the board. A session that cannot start still gets a panel that says why. */
  const addTarget = useCallback(async (target: PanelTarget, position?: AddPanelPositionOptions) => {
    const api = apiRef.current
    if (!api) return
    const params: TerminalPanelParams = { ...target, sessionId: null }
    try {
      const session = await window.bancada.spawn({
        cwd: target.path,
        meta: {
          product: target.productName,
          project: target.projectName,
          worktree: target.name,
          ...(target.branch ? { branch: target.branch } : {}),
        },
      })
      params.sessionId = session.id
    } catch (error) {
      params.error = error instanceof Error ? error.message.replace(/^.*?bancada:[a-z_]+:/, '') : String(error)
    }
    api.addPanel({
      id: `wt-${crypto.randomUUID().slice(0, 8)}`,
      component: 'worktree',
      title: target.name,
      params,
      ...(position ? { position } : {}),
    })
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      open(target) {
        const group = apiRef.current?.activeGroup
        void addTarget(target, group ? { referenceGroup: group, direction: 'right' } : undefined)
      },
    }),
    [addTarget],
  )

  const onReady = useCallback(
    ({ api }: DockviewReadyEvent) => {
      apiRef.current = api

      // Sidebar drags are "unhandled" by dockview until we accept them; accepting turns on its edge overlays.
      api.onUnhandledDragOver((event) => {
        if (event.nativeEvent instanceof DragEvent && hasWorktreePayload(event.nativeEvent)) event.accept()
      })
      api.onDidDrop((event) => {
        if (!(event.nativeEvent instanceof DragEvent)) return
        const target = readDragPayload(event.nativeEvent)
        if (!target) return
        const side = event.position === 'center' ? undefined : DIRECTION[event.position]
        if (event.group) {
          void addTarget(target, { referenceGroup: event.group, direction: side ?? 'within' })
        } else {
          void addTarget(target, side ? { direction: side } : undefined)
        }
      })
      api.onDidLayoutChange(scheduleSave)

      window.bancada
        .loadBoard(BOARD_ID)
        .then((board) => {
          if (board) api.fromJSON(board.layout as SerializedDockview)
        })
        .catch((error: unknown) => {
          console.error('Restoring the board failed; starting empty', error)
          api.clear()
        })
        .finally(() => {
          restoredRef.current = true
        })
    },
    [addTarget, scheduleSave],
  )

  return (
    <DockviewReact
      className="dockview-theme-dark board"
      components={components}
      watermarkComponent={Watermark}
      onReady={onReady}
    />
  )
}
