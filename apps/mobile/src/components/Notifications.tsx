import { Bell, BellRing, Info } from 'lucide-react'
import { useState } from 'react'
import { disablePush, enablePush, isStandalone, pushAvailability } from '../push.js'
import { t } from '../strings.js'

interface Props {
  subscribed: boolean
  onChange(subscribed: boolean): void
}

/** The "Ativar notificações" card. The permission prompt is asked from the button's click, a user gesture. */
export function Notifications({ subscribed, onChange }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const availability = pushAvailability()

  const enable = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await enablePush()
      if (result === 'granted') onChange(true)
      else setError(t.notificationsDenied(isStandalone()))
    } catch {
      setError(t.notificationsFailed)
    } finally {
      setBusy(false)
    }
  }

  const disable = async (): Promise<void> => {
    setBusy(true)
    try {
      await disablePush()
      onChange(false)
    } catch {
      setError(t.notificationsFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card card-pad" aria-label={t.notificationsTitle}>
      <h2 className="card-title">
        {subscribed ? <BellRing size={18} aria-hidden="true" /> : <Bell size={18} aria-hidden="true" />}
        {t.notificationsTitle}
      </h2>
      {availability.kind === 'install-first' && (
        <p className="notice">
          <Info size={18} aria-hidden="true" />
          <span>{t.notificationsInstallFirst}</span>
        </p>
      )}
      {availability.kind === 'unsupported' && <p className="muted">{t.notificationsUnsupported}</p>}
      {availability.kind === 'denied' && <p className="warn">{t.notificationsDenied(isStandalone())}</p>}
      {availability.kind === 'ready' && !subscribed && (
        <>
          <p className="muted">{t.notificationsExplain}</p>
          <button className="btn btn-primary" type="button" onClick={() => void enable()} disabled={busy}>
            {busy ? t.notificationsEnabling : t.notificationsEnable}
          </button>
        </>
      )}
      {subscribed && (
        <>
          <p className="muted">{t.notificationsOn}</p>
          <button className="btn btn-secondary" type="button" onClick={() => void disable()} disabled={busy}>
            {t.notificationsDisable}
          </button>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
