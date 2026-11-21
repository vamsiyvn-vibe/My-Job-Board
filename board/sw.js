// Service worker for the PM Job Board PWA.
// Strategy is deliberately conservative because this is a live, actively-developed app:
//   - /api/*, /login, /logout  -> network only (never cache data or auth).
//   - navigations, .js, .css    -> network-first, fall back to cache when offline.
//   - icons / images / fonts    -> cache-first (they rarely change).
// Bump CACHE_VERSION to force clients onto fresh shell assets.
const CACHE_VERSION = 'jobboard-v37';
const CORE = ['/', '/app.js', '/styles.css', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function networkFirst(req) {
  return fetch(req)
    .then((res) => {
      if (res && res.ok && req.method === 'GET') {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
      }
      return res;
    })
    .catch(() => caches.match(req).then((m) => m || caches.match('/')));
}

function cacheFirst(req) {
  return caches.match(req).then((cached) => {
    if (cached) return cached;
    return fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
      }
      return res;
    });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept data/auth — always hit the network.
  if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/logout') {
    return;
  }
  // Only manage our own origin; let cross-origin (CDN) requests pass through.
  if (url.origin !== self.location.origin) return;

  const isAsset = /\.(png|jpg|jpeg|gif|svg|ico|webmanifest|woff2?|ttf)$/i.test(url.pathname);
  if (isAsset) {
    event.respondWith(cacheFirst(req));
  } else {
    // navigations, .js, .css, everything else same-origin
    event.respondWith(networkFirst(req));
  }
});
