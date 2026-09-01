const SW_VERSION = '__SW_VERSION__'; // replaced at build time with git hash
// Shell files precached at install: injected at build time from dist/assets
// (hashed filenames change every build, so the list must come from the build).
const SHELL_ASSETS = __SHELL_ASSETS__;
// Per-build shell cache: a new deploy gets a fresh name, and activate() purges
// the previous one together with its stale asset generation.
const SHELL_CACHE = 'acnh-shell-' + SW_VERSION;
const DB_CACHE = 'acnh-db-v3';
// Images no longer live in Cache Storage at all — they're in IndexedDB and
// served via blob URLs in page code (see imagedb.ts). A large image cache in
// Cache Storage was the cause of slow cold boots: on iOS the first
// caches.open() opens EVERY cache for the origin (reading all ~25k image
// record metadata files) before the navigation could be served. The old
// 'acnh-img-v3' cache is deleted by the activate() purge below.

// Cached cache handles — opened once per SW lifetime, reused for every request.
const handles = {};
function getCache(name) {
  if (!handles[name]) handles[name] = caches.open(name);
  return handles[name];
}

// App shell: built assets from Vite + index.html

// Install: cache app shell. Each file individually — one bad URL must not
// fail the whole install. cache:'reload' bypasses the HTTP cache so we store
// real bytes.
self.addEventListener('install', (event) => {
  event.waitUntil(
    getCache(SHELL_CACHE).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
        )
      )
    )
  );
  self.skipWaiting();
});

// Activate: clean old caches. Only the shell and db caches survive; the old
// image cache ('acnh-img-v3') and any stale shell generations are deleted.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DB_CACHE).map((k) => caches.delete(k)))
      )
  );
  // Navigation preload: start the network request in parallel with SW boot-up.
  // Without this, the browser waits for the worker thread to evaluate before
  // even dispatching the fetch event — 50-500ms wasted on every cold navigation.
  if (self.registration?.navigationPreload) {
    event.waitUntil(self.registration.navigationPreload.enable());
  }
  self.clients.claim();
});

// Fetch handler: routing strategy per URL pattern
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET
  if (request.method !== 'GET') return;

  // API calls: network-only. Never serve user data (e.g. /api/progress) stale
  // from the browser disk cache — Chromium can return a cached 200 even when
  // offline, which would overwrite the client's newer IndexedDB copy during a
  // reload. The client falls back to its own IDB copy when this fails (503).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnly(request));
    return;
  }

  // Version check: network-only, no cache at all. The client fetches this on
  // startup to detect missed SW updates — must be fast and fresh.
  if (url.pathname === '/version.txt') {
    event.respondWith(networkOnly(request));
    return;
  }

  // Health ping: network-only, never touches Cache Storage.
  if (url.pathname === '/health') {
    event.respondWith(networkOnly(request));
    return;
  }

  // DB files: network-first, write to DB_CACHE on success.
  if (url.pathname.startsWith('/db/')) {
    event.respondWith(netFirstWriteCache(request, DB_CACHE));
    return;
  }

  // Images ('/img/*') are deliberately NOT handled here. They are served from
  // IndexedDB via blob URLs in page code (imagedb.ts / LazyImage.svelte);
  // online misses are fetched in page code and cached into IDB. Routing them
  // through the SW put every viewed image into a giant Cache Storage cache on
  // the boot path — the source of the slow iOS cold start. They fall through
  // to networkOnly below.

  // SPA navigation (deep links like /villager/ace): always serve the cached
  // shell so the app loads offline from any route, not just '/'. Fall back to
  // index.html if the exact path isn't cached.
  if (request.mode === 'navigate') {
    event.respondWith(navigateFetch(event));
    return;
  }

  // Hashed build assets are immutable: network-first, write to SHELL_CACHE.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(netFirstWriteCache(request, SHELL_CACHE));
    return;
  }

  // Everything else: network-only. No cache lookup, no cache write. The old
  // stale-while-revalidate opened caches.match() on EVERY unmatched request,
  // which on iOS with a large image cache added hundreds of ms to health
  // pings, manifest checks, etc.
  event.respondWith(networkOnly(request));
});

// Navigate handler — uses the cached SHELL_CACHE handle so we never call
// caches.open() on the hot path.
async function navigateFetch(event) {
  const { request } = event;
  const cache = await getCache(SHELL_CACHE);
  let response = await cache.match(request);
  if (!response) response = await cache.match('/index.html');
  if (response) {
    const body = await response.clone().arrayBuffer();
    return new Response(body, {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  // Prefer the preloaded response (races SW boot + network in parallel).
  // Falls back to direct fetch when preload is unavailable or offline.
  let fresh;
  try {
    fresh = await event.preloadResponse;
  } catch { /* preload unsupported or failed */ }
  if (!fresh) {
    try { fresh = await fetch(request); } catch { /* offline */ }
  }
  if (fresh?.ok) {
    if (fresh.url === request.url || request.url.endsWith('/')) {
      await cache.put(request, fresh.clone());
    }
    await cache.put('/index.html', fresh.clone());
    return fresh;
  }
  return new Response('Offline', { status: 503 });
}

// network-first with cache write: fetches from network, writes to the
// specified cache on success.  Falls back to the cache only when offline.
// Never calls caches.match() — the cache is only opened via getCache()
// (which returns a cached handle after the first call).
async function netFirstWriteCache(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await getCache(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline: try the specific cache directly (no caches.match scan).
    const cache = await getCache(cacheName);
    const cached = await cache.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function networkOnly(request) {
  try {
    // cache:'no-store' forces a real network request so the browser can't
    // serve a stale disk-cached response while offline.
    const response = await fetch(request, { cache: 'no-store' });
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// Message handler: on-demand skipWaiting (for the update flow). Image
// pre-caching used to live here (CACHE_IMAGES) but moved to IndexedDB — see
// imagedb.ts.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
