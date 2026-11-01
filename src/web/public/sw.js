// Kitty's offline shell: keeps the app's own files so it opens without signal. /api always goes to the network;
// the page keeps its own copy of the last ledger and a queue of new entries (store.tsx, api.ts).
// ponytail: old build files pile up in the cache across deploys; bump CACHE to clear them all if it ever matters.
const CACHE = 'kitty-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const keep = (key) => (res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy));
    }
    return res;
  };
  // Bookings work with no signal: booking photos never change under one id (cache first); a share link's page is
  // fetched fresh when online and its last copy served when not. The rest of /api always goes to the network.
  if (url.pathname.startsWith('/api/')) {
    if (/^\/api\/(shared\/[^/]+\/)?plan-images\/\d+$/.test(url.pathname)) e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(keep(req))));
    else if (/^\/api\/shared\/[^/]+$/.test(url.pathname)) e.respondWith(fetch(req).then(keep(req)).catch(() => caches.match(req).then((hit) => hit || Response.error())));
    return;
  }
  // The page: network first, so a deploy shows at once; the saved copy only when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(keep('/')).catch(() => caches.match('/').then((hit) => hit || Response.error())));
    return;
  }
  // Hashed build files and icons never change under the same name: cache first.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(keep(req))));
});

// Phone notifications: show what the server sent, and open (or focus) Kitty on that trip when tapped.
self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'Kitty', { body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag, data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => w.url.startsWith(self.location.origin));
    return win ? win.navigate(url).then((w) => (w || win).focus()) : self.clients.openWindow(url);
  }));
});
