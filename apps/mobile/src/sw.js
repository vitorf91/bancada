// Service worker of the Bancada PWA: Web Push, and an offline copy of the app shell.
// This file is a template. The build (vite.config.ts) replaces SHELL with the files of that build and VERSION with
// their hash, so every build is a new worker with its own cache.
//
// The shell is cached so that a tap on a notification with Tailscale off still opens the app, which then says what to
// do, instead of Chrome's error page. Only public files are cached (the shell holds no data): /api is never touched.

const VERSION = '__BANCADA_SW_VERSION__'
const SHELL = ['__BANCADA_SW_SHELL__']
const CACHE = `bancada-shell-${VERSION}`
// A tailnet peer that is asleep can leave a request hanging; past this the cached shell is served.
const NAVIGATION_TIMEOUT_MS = 5000

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // One file that fails must not fail the install: push has to work even if the offline copy is incomplete.
      await Promise.allSettled(SHELL.map((url) => cache.add(url)))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('bancada-shell-') && key !== CACHE) await caches.delete(key)
      }
      await self.clients.claim()
    })(),
  )
})

async function navigate(request) {
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAVIGATION_TIMEOUT_MS)),
    ])
    // `tailscale serve` answers 502 when the server on the Mac is stopped: the app explains that better than the proxy.
    if (response.status < 500) return response
  } catch {
    // Tailscale off (the name does not resolve), Mac asleep, or no network at all.
  }
  const cached = await caches.match('/', { cacheName: CACHE })
  return cached ?? Response.error()
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request))
    return
  }
  // Built files have content hashes in their names, so a cached copy is always the right one.
  event.respondWith(caches.match(request, { cacheName: CACHE }).then((cached) => cached ?? fetch(request)))
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { body: event.data ? event.data.text() : '' }
  }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Bancada'
  // Chrome requires a visible notification for every push (userVisibleOnly), so there is no silent branch.
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof payload.body === 'string' ? payload.body : '',
      tag: typeof payload.tag === 'string' ? payload.tag : undefined,
      icon: '/icons/icon-192.png',
      data: { url: typeof payload.url === 'string' ? payload.url : '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        await client.focus()
        client.postMessage({ type: 'navigate', hash: target.hash || '#/' })
        return
      }
      await self.clients.openWindow(target.href)
    })(),
  )
})
