import { Info } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { ApiError, api, NetworkError } from '../api.js'
import { formatCodeInput, guessDeviceName, normalizeCode } from '../format.js'
import { isIos, isStandalone } from '../push.js'
import { t } from '../strings.js'

interface Props {
  initialCode: string
  onPaired(): void
}

export function Pairing({ initialCode, onPaired }: Props) {
  const [code, setCode] = useState(formatCodeInput(initialCode))
  const [name, setName] = useState(() => guessDeviceName(navigator.userAgent))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const autoSubmitted = useRef(false)

  const submit = async (rawCode: string): Promise<void> => {
    if (normalizeCode(rawCode).length !== 8) {
      setError(t.pairInvalid)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.pair(normalizeCode(rawCode), name)
      onPaired()
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) setError(t.pairRateLimited(e.retryAfterSeconds ?? 60))
      else if (e instanceof NetworkError) setError(t.pairNetwork)
      else setError(t.pairInvalid)
      setBusy(false)
    }
  }

  // The QR carries the code in the URL fragment; a fragment never reaches any server until we post it ourselves.
  useEffect(() => {
    if (initialCode && !autoSubmitted.current) {
      autoSubmitted.current = true
      void submit(initialCode)
    }
  }, [])

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    void submit(code)
  }

  return (
    <main className="screen">
      <div className="center">
        <header>
          <h1 className="page-title">{t.pairTitle}</h1>
          <p className="page-subtitle">{t.pairIntro}</p>
        </header>
        <form className="form" onSubmit={onSubmit}>
          <label className="label">
            {t.pairCode}
            <input
              className="field field-mono"
              value={code}
              onChange={(e) => setCode(formatCodeInput(e.target.value))}
              inputMode="text"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="ABCD-EFGH"
              aria-invalid={error !== null}
            />
          </label>
          <label className="label">
            {t.pairName}
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? t.pairing : t.pairSubmit}
          </button>
        </form>
        {isIos() && !isStandalone() && (
          <p className="notice">
            <Info size={18} aria-hidden="true" />
            <span>{t.pairInstallHint}</span>
          </p>
        )}
      </div>
    </main>
  )
}
