import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from './api.js'
import { parseRoute, type Route } from './route.js'
import { Pairing } from './screens/Pairing.js'
import { SessionList } from './screens/SessionList.js'
import { SessionView } from './screens/SessionView.js'
import { t } from './strings.js'

type Auth = 'loading' | 'authed' | 'anon' | 'offline'

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
      setAuth(e instanceof ApiError && e.status === 401 ? 'anon' : 'offline')
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

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
  if (auth === 'offline') {
    return (
      <main className="screen">
        <div className="center">
          <h1 className="page-title">{t.offline}</h1>
          <p className="page-subtitle">{t.offlineHint}</p>
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
