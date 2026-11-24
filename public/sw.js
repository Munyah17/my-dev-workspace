self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.mode !== 'navigate' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  event.respondWith(fetch(event.request).catch(() => new Response('MyDev Workspace requires a connection. Reconnect and reload to continue.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })))
})
