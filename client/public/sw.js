const CACHE_NAME = 'acnh-v1';
const SHELL_CACHE = 'acnh-shell-v1';
const DB_CACHE = 'acnh-db-v1';
const IMG_CACHE = 'acnh-img-v1';

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

  // API calls: network-first with offline fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
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

  // App shell: stale-while-revalidate
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

// Message handler: pre-cache images from manifest
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CACHE_IMAGES') {
    const { urls } = event.data;
    event.waitUntil(cacheImages(urls, event.source));
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
