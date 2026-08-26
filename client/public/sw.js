const SW_VERSION = '__SW_VERSION__'; // replaced at build time with git hash
// Shell files precached at install: injected at build time from dist/assets
// (hashed filenames change every build, so the list must come from the build).
const SHELL_ASSETS = __SHELL_ASSETS__;
// Per-build shell cache: a new deploy gets a fresh name, and activate() purges
// the previous one together with its stale asset generation.
const SHELL_CACHE = 'acnh-shell-' + SW_VERSION;
const DB_CACHE = 'acnh-db-v3';
const IMG_CACHE = 'acnh-img-v3';

// Cached SHELL_CACHE handle — opened once per SW lifetime, reused for every
// navigation.  On iOS, caches.open() is expensive when IMG_CACHE has thousands
// of entries; caching this handle avoids paying that cost on every navigation.
let shellCache = null;

// App shell: built assets from Vite + index.html

// Install: cache app shell. Each file individually — one bad URL must not
// fail the whole install. cache:'reload' bypasses the HTTP cache so we store
// real bytes.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      shellCache = cache;
      return Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
        )
      );
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches + purge entries that must never be cached
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all([
        ...keys
          .filter((k) => k !== SHELL_CACHE && k !== DB_CACHE && k !== IMG_CACHE)
          .map((k) => caches.delete(k)),
        // Older deploys cached these via the /img/ cache-first rule, serving
        // stale manifests/zips across updates. Purge them on every activation.
        caches.open(IMG_CACHE).then((cache) =>
          Promise.all([cache.delete('/img/manifest.json'), cache.delete('/img/images.zip')])
        ),
      ])
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

  // Image manifest + install bundle: network-only, ALWAYS. Cache-first here
  // poisoned updates (stale manifest sizes, stale zips) — these two must
  // reflect the current deploy every single time. Checked BEFORE the /img/
  // catch-all below.
  if (url.pathname === '/img/manifest.json' || url.pathname === '/img/images.zip') {
    event.respondWith(networkOnly(request));
    return;
  }

  // DB files: cache-first (versioned filenames, immutable)
  if (url.pathname.startsWith('/db/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Images: non-blocking cache-first.  Uses caches.match() (searches all
  // caches without opening any) so the 4 800-entry IMG_CACHE never blocks
  // navigation or other requests.
  if (url.pathname.startsWith('/img/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // SPA navigation (deep links like /villager/ace): always serve the cached
  // shell so the app loads offline from any route, not just '/'. Fall back to
  // index.html if the exact path isn't cached.
  if (request.mode === 'navigate') {
    event.respondWith(navigateFetch(event));
    return;
  }

  // Hashed build assets are immutable: cache-first once seen.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // App shell assets (js/css): stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request));
});

// Navigate handler — uses the cached SHELL_CACHE handle (opened once in
// install) so we never call caches.open() on the hot path.
async function navigateFetch(event) {
  const { request } = event;
  const cache = shellCache || await caches.open(SHELL_CACHE);
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

// cache-first: reads via caches.match() (no open), only opens for writes.
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Determine which cache this URL belongs to and write there.
      const url = new URL(request.url);
      const cacheName = url.pathname.startsWith('/img/') ? IMG_CACHE
        : url.pathname.startsWith('/db/') ? DB_CACHE
        : SHELL_CACHE;
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
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

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

// stale-while-revalidate: reads via caches.match(), opens only for writes.
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        const url = new URL(request.url);
        const cacheName = url.pathname.startsWith('/img/') ? IMG_CACHE
          : url.pathname.startsWith('/db/') ? DB_CACHE
          : SHELL_CACHE;
        const cache = await caches.open(cacheName);
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

// Message handler: pre-cache images + on-demand skipWaiting (for update flow)
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CACHE_IMAGES') {
    const { urls } = event.data;
    event.waitUntil(cacheImages(urls, event.source));
  } else if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

async function cacheImages(urls, source) {
  const cache = await caches.open(IMG_CACHE);
  const total = urls.length;
  let done = 0;
  const BATCH = 20;

  for (let i = 0; i < total; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (url) => {
        try {
          const response = await fetch(url);
          if (response.ok) {
            await cache.put(url, response);
          }
        } catch {
          // skip failed images
        }
        done++;
      })
    );
    // Report progress to client
    if (source) {
      source.postMessage({ type: 'IMAGE_PROGRESS', done, total });
    }
  }

  if (source) {
    source.postMessage({ type: 'IMAGE_COMPLETE', total });
  }
}
