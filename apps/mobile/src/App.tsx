import { ServerOff, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from './api.js'
import { parseRoute, type Route } from './route.js'
import { Pairing } from './screens/Pairing.js'
import { SessionList } from './screens/SessionList.js'
import { SessionView } from './screens/SessionView.js'
import { t } from './strings.js'

// unreachable: no answer at all (Tailscale off, Mac asleep). server-down: the tailnet answered for the Mac (the 502 of
// `tailscale serve`), but the Bancada server behind it is not running.
type Auth = 'loading' | 'authed' | 'anon' | 'unreachable' | 'server-down'

const RETRY_MS = 3000

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    // The service worker asks an open window to go to a session when a notification is tapped.
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: string; hash?: string } | null
      if (data?.type === 'navigate' && typeof data.hash === 'string') window.location.hash = data.hash
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('hashchange', onChange)
      navigator.serviceWorker?.removeEventListener('message', onMessage)
    }
  }, [])
  return route
}

export function App() {
  const route = useRoute()
  const [auth, setAuth] = useState<Auth>('loading')
  const [pushSubscribed, setPushSubscribed] = useState(false)

  const check = useCallback(async (): Promise<void> => {
    try {
      const me = await api.me()
      setPushSubscribed(me.push.subscribed)
      setAuth('authed')
    } catch (e) {
      if (!(e instanceof ApiError)) setAuth('unreachable')
      else setAuth(e.status === 401 ? 'anon' : 'server-down')
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  // While the Mac is out of reach, keep trying: turning Tailscale on is all it takes to land where the user was going.
  const offline = auth === 'unreachable' || auth === 'server-down'
  useEffect(() => {
    if (!offline) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const tick = async (): Promise<void> => {
      if (document.visibilityState === 'visible') await check()
      if (!stopped) timer = setTimeout(() => void tick(), RETRY_MS)
    }
    timer = setTimeout(() => void tick(), RETRY_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [offline, check])

  const onUnauthorized = useCallback(() => setAuth('anon'), [])

  const signOut = async (): Promise<void> => {
    if (!window.confirm(t.signOutConfirm)) return
    try {
      await api.logout()
    } catch {
      // the cookie is cleared by the response; if we are offline the device stays paired
    }
    window.location.hash = '#/'
    void check()
  }

  if (auth === 'loading') return <main className="screen" aria-busy="true" />
  if (offline) {
    const down = auth === 'server-down'
    return (
      <main className="screen">
        <div className="center">
          <span className="state-icon" aria-hidden="true">
            {down ? <ServerOff size={22} /> : <WifiOff size={22} />}
          </span>
          <div>
            <h1 className="page-title">{down ? t.serverDown : t.unreachable}</h1>
            <p className="page-subtitle">{down ? t.serverDownHint : t.unreachableHint}</p>
          </div>
          <p className="muted retrying" role="status">
            <span className="retry-dot pulse" aria-hidden="true" />
            {t.retrying}
          </p>
          <button className="btn btn-primary" type="button" onClick={() => void check()}>
            {t.retry}
          </button>
        </div>
      </main>
    )
  }
  if (auth === 'anon') {
    return (
      <Pairing
        initialCode={route.name === 'pair' ? route.code : ''}
        onPaired={() => {
          window.location.hash = '#/'
          void check()
        }}
      />
    )
  }
  if (route.name === 'session') {
    return (
      <SessionView
        key={route.id}
        sessionId={route.id}
        onBack={() => {
          window.location.hash = '#/'
        }}
        onUnauthorized={onUnauthorized}
      />
    )
  }
  return (
    <SessionList
      pushSubscribed={pushSubscribed}
      onPushChange={setPushSubscribed}
      onUnauthorized={onUnauthorized}
      onSignOut={() => void signOut()}
    />
  )
}
