// Service worker of the Bancada PWA. It exists for Web Push and caches nothing.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { body: event.data ? event.data.text() : '' }
  }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Bancada'
  // A web push on iOS must always show a notification (userVisibleOnly), so there is no silent branch.
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
