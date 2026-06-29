/* RecipeGen PWA service worker.
 *
 * Goals: make the app installable and resilient to flaky networks without
 * risking stale-bundle bugs after a deploy. Strategy:
 *
 *   - Navigations (HTML)        → network-first, fall back to cached shell.
 *   - Same-origin static assets → stale-while-revalidate (fast + self-heals).
 *   - Everything cross-origin   → pass through untouched. In particular the
 *     Supabase REST/Auth/Storage API and all non-GET requests are NEVER
 *     cached, so auth and writes always hit the network.
 *
 * The cache name is versioned; bump CACHE_VERSION to force old caches out.
 */

const CACHE_VERSION = 'v1';
const CACHE = `recipegen-${CACHE_VERSION}`;

self.addEventListener('install', (event) => {
  // Activate this SW as soon as it finishes installing.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['/', '/manifest.json'])),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only ever touch same-origin GETs. Cross-origin (Supabase API, fonts CDN,
  // analytics) and non-GET (auth, mutations) go straight to the network.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // App navigations: network-first so a fresh deploy lands immediately,
  // with the cached shell as an offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put('/', fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match('/');
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    })(),
  );
});
