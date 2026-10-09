import { ChevronRight, LogOut, WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ApiError, api, NetworkError, type SessionSummary } from '../api.js'
import { Notifications } from '../components/Notifications.js'
import { relativeTime } from '../format.js'
import { sessionHash } from '../route.js'
import { t } from '../strings.js'

interface Props {
  pushSubscribed: boolean
  onPushChange(subscribed: boolean): void
  onUnauthorized(): void
  onSignOut(): void
}

const POLL_MS = 3000

export function SessionList({ pushSubscribed, onPushChange, onUnauthorized, onSignOut }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [problem, setProblem] = useState<'offline' | 'host' | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let stopped = false
    const load = async (): Promise<void> => {
      try {
        const result = await api.sessions()
        if (stopped) return
        setSessions(result.sessions)
        setProblem(null)
      } catch (e) {
        if (stopped) return
        if (e instanceof ApiError && e.status === 401) onUnauthorized()
        else if (e instanceof ApiError && e.status === 503) setProblem('host')
        else if (e instanceof NetworkError) setProblem('offline')
      }
      setNow(Date.now())
    }
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [onUnauthorized])

  const ordered = [...(sessions ?? [])].sort(
    (a, b) =>
      Number(b.state === 'running') - Number(a.state === 'running') ||
      (b.lastOutputAt ?? b.createdAt) - (a.lastOutputAt ?? a.createdAt),
  )
  const running = ordered.filter((s) => s.state === 'running').length

  return (
    <main className="screen">
      <header className="page-header">
        <h1 className="page-title">{t.sessionsTitle}</h1>
        <p className="page-subtitle">{sessions ? t.sessionsSummary(ordered.length, running) : t.connecting}</p>
      </header>
      <div className="scroll">
        {problem && (
          <p className="notice" role="status">
            <WifiOff size={18} aria-hidden="true" />
            <span>{problem === 'host' ? t.hostDown : `${t.offline}. ${t.offlineHint}`}</span>
          </p>
        )}
        {sessions && ordered.length === 0 && !problem && <p className="muted">{t.noSessions}</p>}
        {ordered.length > 0 && (
          <ul className="rows" aria-label={t.sessionsTitle}>
            {ordered.map((s) => (
              <li key={s.id}>
                <a className="btn row" href={sessionHash(s.id)}>
                  <span className="dot-square" aria-hidden="true" />
                  <span className="row-main">
                    <span className="row-title">
                      <strong>{s.title ?? s.cwdName}</strong>
                      {s.title && <span>{s.cwdName}</span>}
                    </span>
                    <span className="row-sub">
                      {s.lastOutputAt ? t.lastActivity(relativeTime(s.lastOutputAt, now)) : t.noActivity}
                    </span>
                  </span>
                  <span className="status">
                    <span className={`status-dot ${s.state === 'running' ? 'is-running' : ''}`} aria-hidden="true" />
                    {s.state === 'running' ? t.running : t.exited}
                  </span>
                  <span className="row-chevron" aria-hidden="true">
                    <ChevronRight size={20} />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
        <Notifications subscribed={pushSubscribed} onChange={onPushChange} />
        <button className="btn btn-secondary" type="button" onClick={onSignOut}>
          <LogOut size={18} aria-hidden="true" />
          {t.signOut}
        </button>
      </div>
    </main>
  )
}
