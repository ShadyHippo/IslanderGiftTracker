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

// --- Response validation -----------------------------------------------------
// When the origin is down behind a proxy/CDN (Cloudflare's "not working" page is
// the common one here), error pages can come back with a 2xx status and
// `text/html`. Storing one as a shell asset, a reference db or index.html
// poisons Cache Storage and can leave a device broken even after the server
// returns, so nothing is written to a cache, and no navigation is answered,
// until the bytes are recognisably ours.
function isHtml(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/html');
}

/** This origin serves exactly one HTML document: the SPA shell. */
async function isAppShell(response) {
  if (!response || !response.ok || !isHtml(response)) return false;
  try {
    return (await response.clone().text()).includes('id="app"');
  } catch {
    return false;
  }
}

/** Assets, db files and manifests are never HTML. */
function isStorable(response) {
  return !!response && response.ok && !isHtml(response);
}

function shellResponse(body) {
  return new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Last resort when this device has no cached shell AND the server can't be
 * reached (first visit, or the browser evicted our storage). Hand-written so it
 * needs no network, and it says what actually happened instead of a proxy's
 * error page.
 */
function offlinePage() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ACNH Gift Tracker</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f0fdf4; color: #14532d; }
  main { max-width: 22rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1.25rem; line-height: 1.5; font-size: 0.95rem; }
  a { display: inline-block; padding: 0.55rem 1.1rem; border-radius: 0.5rem; background: #15803d;
    color: #fff; font-weight: 600; text-decoration: none; }
  @media (prefers-color-scheme: dark) {
    body { background: #000; color: #dcfce7; }
    a { background: #166534; }
  }
</style></head>
<body><main>
  <h1>Can&rsquo;t reach the server</h1>
  <p>This device doesn&rsquo;t have a copy of the app saved yet, and the server isn&rsquo;t
  answering. Your gift log on this device is untouched.</p>
  <a href="./">Try again</a>
</main></body></html>`;
  return new Response(html, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Fetch one shell URL and store it only if the response really is ours. */
async function precacheShellFile(cache, url) {
  const response = await fetch(new Request(url, { cache: 'reload' }));
  const isDocument = url === '/' || url === '/index.html';
  const valid = isDocument ? await isAppShell(response) : isStorable(response);
  if (valid) await cache.put(url, response);
}

// Install: cache app shell. Each file individually — one bad URL must not
// fail the whole install. cache:'reload' bypasses the HTTP cache so we store
// real bytes.
self.addEventListener('install', (event) => {
  event.waitUntil(
    getCache(SHELL_CACHE).then((cache) =>
      Promise.all(SHELL_ASSETS.map((url) => precacheShellFile(cache, url).catch(() => {})))
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
    event.respondWith(networkOnly(request, event));
    return;
  }

  // Version check: network-only, no cache at all. The client fetches this on
  // startup to detect missed SW updates — must be fast and fresh.
  if (url.pathname === '/version.txt') {
    event.respondWith(networkOnly(request, event));
    return;
  }

  // Health ping: network-only, never touches Cache Storage.
  if (url.pathname === '/health') {
    event.respondWith(networkOnly(request, event));
    return;
  }

  // DB files + the image manifest: network-first, write to DB_CACHE on
  // success. Content-addressed DB URLs (…?h=<sha256>) are immutable, so they
  // are served cache-first instead: a repeat boot then costs zero bytes.
  if (url.pathname.startsWith('/db/') || url.pathname === '/img/manifest.json') {
    event.respondWith(
      url.searchParams.has('h') ? cacheFirst(request, DB_CACHE) : netFirstWriteCache(request, DB_CACHE),
    );
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
  event.respondWith(networkOnly(request, event));
});

// Navigate handler — uses the cached SHELL_CACHE handle so we never call
// caches.open() on the hot path.
async function navigateFetch(event) {
  const { request } = event;
  const cache = await getCache(SHELL_CACHE);
  // Always prefer the cached shell: it IS the app, it paints instantly, and it
  // is the only thing that works with no server at all. Deep links
  // (/villager/ace) fall back to /index.html so client-side routing handles
  // them. This is also what keeps a download/lock/dead-origin reload inside the
  // app instead of bouncing to whatever page the network hands back.
  let cached = await cache.match(request);
  if (!cached) cached = await cache.match('/index.html');
  if (cached) return shellResponse(await cached.arrayBuffer());

  // No cached shell (first visit, or the browser evicted our storage): this
  // navigation genuinely needs the network.
  // Prefer the preloaded response (races SW boot + network in parallel).
  let fresh = null;
  try {
    fresh = await event.preloadResponse;
  } catch {
    /* preload unsupported or failed */
  }
  if (!(await isAppShell(fresh))) {
    try {
      fresh = await fetch(request);
    } catch {
      /* offline */
    }
  }
  if (await isAppShell(fresh)) {
    await cache.put('/index.html', fresh.clone());
    return fresh;
  }
  // The network answered with something that is not our app (a proxy error
  // page). Never cache it, never show it.
  return offlinePage();
}

// cache-first for content-addressed URLs: a hit issues no network request at
// all. A miss fetches, stores, and drops older versions of the same path so
// superseded builds do not accumulate in Cache Storage.
async function cacheFirst(request, cacheName) {
  const cache = await getCache(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    // Never store a proxy error page under a content-addressed URL: the URL
    // would keep resolving to it long after the server is back.
    if (isStorable(response)) {
      await cache.put(request, response.clone());
      await pruneOtherVersions(cache, request.url);
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function pruneOtherVersions(cache, keepUrl) {
  const keep = new URL(keepUrl);
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((k) => {
        const u = new URL(k.url);
        return u.pathname === keep.pathname && u.search !== keep.search;
      })
      .map((k) => cache.delete(k)),
  );
}

// network-first with cache write: fetches from network, writes to the
// specified cache on success.  Falls back to the cache only when offline.
// Never calls caches.match() — the cache is only opened via getCache()
// (which returns a cached handle after the first call).
async function netFirstWriteCache(request, cacheName) {
  try {
    const response = await fetch(request);
    // Assets/db files are never HTML. A text/html body here is a proxy error
    // page, not our content, and caching it would poison the next boot.
    if (isStorable(response)) {
      const cache = await getCache(cacheName);
      cache.put(request, response.clone());
      return response;
    }
    const cache = await getCache(cacheName);
    const cached = await cache.match(request);
    return cached || new Response('Offline', { status: 503 });
  } catch {
    // Offline: try the specific cache directly (no caches.match scan).
    const cache = await getCache(cacheName);
    const cached = await cache.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function networkOnly(request, event) {
  // Navigations (e.g. the OAuth start/callback round-trip) come with a
  // navigation-preload request the browser already fired in parallel with SW
  // boot. We MUST consume it instead of issuing our own fetch(request): doing
  // both sends the URL TWICE to the server. For /api/auth/google/start each
  // copy mints a DIFFERENT OAuth state token and each response sets the state
  // cookie — the two Set-Cookie writes race, and the authorize URL can end up
  // carrying a state that no longer matches the cookie. The callback then
  // fails with "Sign-in could not be verified" at random. Prefer the preload,
  // fall back to our own request.
  if (request.mode === 'navigate') {
    let pre;
    try {
      pre = await event?.preloadResponse;
    } catch {
      /* preload unavailable/failed: fall through to a fresh fetch */
    }
    if (pre) return pre;
  }
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
