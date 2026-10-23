// Caches the app shell so a cold start still renders, but always prefers the
// network: a family calendar must not show week-old CSS or JS because a cache
// entry went stale. Calendar data (/api, /ics) is never cached at all —
// showing a stale month would be worse than an offline notice.
const CACHE = 'shared-calendar-shell-v2';
const SHELL = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ics/')) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? new Response('offline', {
        status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
      }))),
  );
});
