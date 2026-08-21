const SW_VERSION = '__SW_VERSION__'; // replaced at build time with git hash
const CACHE_NAME = 'acnh-v3';
const SHELL_CACHE = 'acnh-shell-v3';
const DB_CACHE = 'acnh-db-v3';
const IMG_CACHE = 'acnh-img-v3';

// App shell: built assets from Vite + index.html
const SHELL_ASSETS = [
  '/',
  '/index.html',
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== DB_CACHE && k !== IMG_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
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

  // DB files: cache-first (versioned filenames, immutable)
  if (url.pathname.startsWith('/db/')) {
    event.respondWith(cacheFirst(request, DB_CACHE));
    return;
  }

  // Images: cache-first with lazy caching
  if (url.pathname.startsWith('/img/')) {
    event.respondWith(cacheFirst(request, IMG_CACHE));
    return;
  }

  // Image install bundle: never cache (client streams it with cache:'no-store'
  // and extracts it into Cache Storage itself).
  if (url.pathname === '/img/images.zip') {
    event.respondWith(networkOnly(request));
    return;
  }

  // SPA navigation (deep links like /villager/ace): always serve the cached
  // shell so the app loads offline from any route, not just '/'. Fall back to
  // index.html if the exact path isn't cached.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        let response = await cache.match(request);
        if (!response) response = await cache.match('/index.html');
        if (response) {
          // Rebuild the Response so the SW returns an opaque-ok navigation
          // response (Chromium rejects a cached response whose URL doesn't
          // match the top-level request URL, even for SPA fallback).
          const body = await response.clone().arrayBuffer();
          return new Response(body, {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        // Online path: let the network serve it and cache the shell.
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const base = await caches.open(SHELL_CACHE);
            if (fresh.url === request.url || request.url.endsWith('/')) {
              await base.put(request, fresh.clone());
            }
            await base.put('/index.html', fresh.clone());
          }
          return fresh;
        } catch {
          return new Response('Offline', { status: 503 });
        }
      })(),
    );
    return;
  }

  // App shell assets (js/css): stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
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

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
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
