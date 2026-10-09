import { api } from './api.js'

export type PushAvailability =
  | { kind: 'install-first' } // iOS in Safari: push only exists for the installed (home screen) web app
  | { kind: 'unsupported' }
  | { kind: 'denied' }
  | { kind: 'ready'; permission: NotificationPermission }

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches
}

export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
}

export function pushAvailability(): PushAvailability {
  if (isIos() && !isStandalone()) return { kind: 'install-first' }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { kind: 'unsupported' }
  }
  if (Notification.permission === 'denied') return { kind: 'denied' }
  return { kind: 'ready', permission: Notification.permission }
}

/** The VAPID public key is base64url; `PushManager.subscribe` wants bytes. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/**
 * Must run from a click handler: iOS only shows the permission prompt for a user gesture, so
 * `requestPermission` is the first await.
 */
export async function enablePush(): Promise<'granted' | 'denied' | 'default'> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission
  const registration = await navigator.serviceWorker.ready
  const { publicKey } = await api.pushKey()
  const existing = await registration.pushManager.getSubscription()
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }))
  await api.pushSubscribe(subscription.toJSON())
  return 'granted'
}

export async function disablePush(): Promise<void> {
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  await subscription?.unsubscribe()
  await api.pushUnsubscribe()
}
