import type { DiscoveryResult } from '@bancada/workspace/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Board, type BoardHandle } from './Board.js'
import { Sidebar } from './Sidebar.js'

export function App() {
  const boardRef = useRef<BoardHandle>(null)
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    window.bancada
      .discoverWorkspace()
      .then((result) => {
        setDiscovery(result)
        setFailure(null)
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(refresh, [refresh])

  return (
    <div className="app">
      <Sidebar
        discovery={discovery}
        failure={failure}
        loading={loading}
        onRefresh={refresh}
        onOpen={(target) => boardRef.current?.open(target)}
      />
      <main className="main">
        <Board ref={boardRef} />
      </main>
    </div>
  )
}
