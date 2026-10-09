import { ArrowLeft, Send } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { api, type SessionSummary } from '../api.js'
import { type StreamMeta, type StreamStatus, TerminalView } from '../components/TerminalView.js'
import { QUICK_KEYS } from '../keys.js'
import { t } from '../strings.js'

interface Props {
  sessionId: string
  onBack(): void
  onUnauthorized(): void
}

/** Delay between the typed text and the Enter that follows it, so a TUI reads them as typing, not as one paste. */
const ENTER_DELAY_MS = 60

export function SessionView({ sessionId, onBack, onUnauthorized }: Props) {
  const sendRef = useRef<((data: string) => void) | null>(null)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [meta, setMeta] = useState<StreamMeta | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    let cancelled = false
    api
      .sessions()
      .then((r) => {
        if (!cancelled) setSummary(r.sessions.find((s) => s.id === sessionId) ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const send = useCallback((data: string) => sendRef.current?.(data), [])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const text = draft
    if (text.length === 0) {
      send('\r')
      return
    }
    send(text)
    window.setTimeout(() => send('\r'), ENTER_DELAY_MS)
    setDraft('')
  }

  const title = meta?.title ?? summary?.title ?? summary?.cwdName ?? '…'
  const live = status === 'live'
  const statusText =
    status === 'live'
      ? t.live
      : status === 'connecting'
        ? t.connecting
        : status === 'reconnecting'
          ? t.reconnecting
          : status === 'ended'
            ? t.sessionEnded
            : t.sessionNotFound

  return (
    <main className="screen">
      <div className="topbar">
        <button className="btn back" type="button" onClick={onBack} aria-label={t.backLabel}>
          <ArrowLeft size={20} aria-hidden="true" />
          <span>{t.back}</span>
        </button>
        <div className="topbar-title">
          <strong>{title}</strong>
          <span>{title !== summary?.cwdName ? (summary?.cwdName ?? '') : ''}</span>
        </div>
      </div>
      <div className={`statusbar ${live ? '' : 'is-off'}`} role="status">
        <span
          className={`status-dot ${live || status === 'reconnecting' || status === 'connecting' ? 'pulse' : ''}`}
          aria-hidden="true"
        />
        <span>{statusText}</span>
        {meta && <span className="size">{t.readOnlySize(meta.cols, meta.rows)}</span>}
      </div>
      <TerminalView
        sessionId={sessionId}
        sendRef={sendRef}
        onStatus={setStatus}
        onMeta={setMeta}
        onUnauthorized={onUnauthorized}
      />
      <div className="keys" role="toolbar" aria-label={t.keysLabel}>
        {QUICK_KEYS.map((key) => (
          <button
            key={key.label}
            className="btn key"
            type="button"
            aria-label={key.aria}
            onClick={() => send(key.data)}
          >
            {key.label}
          </button>
        ))}
      </div>
      <form className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="reply">
          {t.inputLabel}
        </label>
        <input
          id="reply"
          className="field"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t.inputPlaceholder}
          enterKeyHint="send"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
        />
        <button className="btn btn-round btn-send" type="submit" aria-label={t.send}>
          <Send size={19} aria-hidden="true" />
        </button>
      </form>
    </main>
  )
}
