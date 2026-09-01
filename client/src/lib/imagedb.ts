import { openIdb } from './refdb.svelte';

// Image storage in IndexedDB — NOT Cache Storage. A ~25k-entry Cache Storage
// cache is opened wholesale by WebKit on the first caches.open() of the boot
// path, which is what made cold launches slow. IndexedDB does indexed point
// lookups and is never touched by the navigation handler, so the app shell
// boots instantly and images stream in lazily after first paint.
//
// Values are stored as { buf: ArrayBuffer, type } rather than a raw Blob:
// reviving stored Blobs is flaky on iOS (WebKitBlobResource error 1), while a
// reconstructed Blob from an ArrayBuffer is reliable everywhere.

const STORE = 'imgs';

export interface ImageRecord {
  buf: ArrayBuffer;
  type: string;
}

function tx(mode: IDBTransactionMode): Promise<{ store: IDBObjectStore; done: Promise<void> }> {
  return openIdb().then(
    (db) =>
      new Promise((resolve) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const done = new Promise<void>((res, rej) => {
          t.oncomplete = () => {
            db.close();
            res();
          };
          t.onerror = () => {
            db.close();
            rej(t.error ?? new Error('image idb transaction failed'));
          };
          t.onabort = () => {
            db.close();
            rej(t.error ?? new Error('image idb transaction aborted'));
          };
        });
        resolve({ store, done });
      }),
  );
}

/** Raw record lookup. Returns null on miss or any error (caller falls back). */
export async function getImageRecord(path: string): Promise<ImageRecord | null> {
  try {
    const db = await openIdb();
    return await new Promise<ImageRecord | null>((resolve) => {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).get(path);
      req.onsuccess = () => {
        const r = req.result as ImageRecord | undefined;
        resolve(r && r.buf ? { buf: r.buf, type: r.type || 'image/webp' } : null);
      };
      req.onerror = () => resolve(null);
      t.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

/** Store a single image. Never throws. */
export async function putImage(path: string, buf: ArrayBuffer, type: string): Promise<void> {
  try {
    const { store, done } = await tx('readwrite');
    store.put({ buf, type }, path);
    await done;
  } catch {
    // storage full / unavailable — the app still works, image just won't be cached
  }
}

/**
 * Bulk store used by the offline install. Chunks puts across transactions so
 * no single transaction holds thousands of pending requests. onProgress is
 * called after each committed chunk. Returns the number of failed puts.
 */
export async function putMany(
  entries: { path: string; buf: ArrayBuffer; type: string }[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let failed = 0;
  const CHUNK = 200;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    try {
      const { store, done } = await tx('readwrite');
      for (const e of slice) {
        const req = store.put({ buf: e.buf, type: e.type }, e.path);
        req.onerror = () => failed++;
      }
      await done;
    } catch {
      failed += slice.length;
    }
    onProgress?.(Math.min(i + CHUNK, entries.length), entries.length);
  }
  return failed;
}

export async function clearImages(): Promise<void> {
  try {
    const { store, done } = await tx('readwrite');
    store.clear();
    await done;
  } catch {
    // ignore
  }
}

// --- Blob URL manager -------------------------------------------------------
// One object URL per path, reference-counted. Components acquire on show and
// release on destroy; when the last ref drops the URL is revoked so a long
// scroll doesn't accumulate thousands of live blob URLs. An LRU cap bounds
// how many URLs are live at once regardless of release discipline.

const MAX_LIVE_URLS = 300;
const live = new Map<string, { url: string; refs: number }>();
const lru: string[] = []; // oldest first

function touch(path: string) {
  const i = lru.indexOf(path);
  if (i !== -1) lru.splice(i, 1);
  lru.push(path);
}

function evictIfNeeded() {
  while (lru.length > MAX_LIVE_URLS) {
    const oldest = lru[0];
    const entry = live.get(oldest);
    // Don't evict something still referenced by a mounted component.
    if (entry && entry.refs > 0) break;
    lru.shift();
    if (entry) {
      URL.revokeObjectURL(entry.url);
      live.delete(oldest);
    }
  }
}

/**
 * Resolve an image path to a displayable object URL from IndexedDB, acquiring
 * a reference. Returns null when not cached (caller decides: fetch or
 * placeholder). Must be paired with releaseImage(path).
 */
export async function acquireImage(path: string): Promise<string | null> {
  const cached = live.get(path);
  if (cached) {
    cached.refs++;
    touch(path);
    return cached.url;
  }
  const rec = await getImageRecord(path);
  if (!rec) return null;
  const url = URL.createObjectURL(new Blob([rec.buf], { type: rec.type }));
  live.set(path, { url, refs: 1 });
  touch(path);
  evictIfNeeded();
  return url;
}

/** Drop a reference previously taken via acquireImage. */
export function releaseImage(path: string): void {
  const entry = live.get(path);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    entry.refs = 0;
    // Keep it in the LRU for reuse; evictIfNeeded will reclaim under pressure.
    touch(path);
    evictIfNeeded();
  }
}

/**
 * Online-miss path: fetch the image over the network, cache it into IDB for
 * next time, and return an acquired object URL. Returns null on failure so the
 * caller can fall back to the raw network URL or a placeholder. Never throws.
 */
export async function fetchStoreAcquire(path: string): Promise<string | null> {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const type = res.headers.get('Content-Type') || 'image/webp';
    void putImage(path, buf, type); // cache in background; don't block paint
    const url = URL.createObjectURL(new Blob([buf], { type }));
    const existing = live.get(path);
    if (existing) URL.revokeObjectURL(existing.url);
    live.set(path, { url, refs: 1 });
    touch(path);
    evictIfNeeded();
    return url;
  } catch {
    return null;
  }
}

/** Ask the browser not to evict stored data under disk pressure. Best-effort. */
export async function requestPersistentStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    // denied or unsupported — data may be evicted under extreme pressure
  }
}
