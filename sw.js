/* Service worker for bus.jjjp.ca — app-shell cache so the PWA launches
   fast and offline. The realtime proxy (jjjp.ca) is never cached: it is
   cross-origin and always goes straight to the network.

   Per-route files (data/routes/<id>.json) are not pre-cached — they are
   fetched on demand and then kept by the stale-while-revalidate handler
   below, so only the routes a visitor actually opens are stored. */
const CACHE = 'busjjjp-v5';
const SHELL = [
  './', './index.html', './app.js', './auth.js', './styles.css',
  './manifest.json', './favicon.svg', './icon.svg',
  './icon-192.png', './icon-512.png',
  './data/index.json', './data/stops.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Only handle our own origin's GET requests; let everything else (the
  // realtime proxy, map tiles, Leaflet CDN) hit the network directly.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Stale-while-revalidate: serve cache instantly, refresh in the background.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
