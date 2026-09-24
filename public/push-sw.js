// Loaded into the app's service worker (vite.config.ts → workbox.importScripts).
// Shows reminders pushed by the task-reminders Edge Function; a tap opens the task.
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = { body: event.data ? event.data.text() : '' } }
  event.waitUntil(self.registration.showNotification(d.title || 'Mneme', {
    body: d.body || '',
    tag: d.tag,
    renotify: !!d.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/tasks' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue
      await w.focus()
      if ('navigate' in w) await w.navigate(url)
      return
    }
    await self.clients.openWindow(url)
  })())
})
