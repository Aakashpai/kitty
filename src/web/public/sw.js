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
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const keep = (key) => (res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy));
    }
    return res;
  };
  // The page: network first, so a deploy shows at once; the saved copy only when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(keep('/')).catch(() => caches.match('/').then((hit) => hit || Response.error())));
    return;
  }
  // Hashed build files and icons never change under the same name: cache first.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(keep(req))));
});
