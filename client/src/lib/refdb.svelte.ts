import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

interface RefManifestEntry {
  version: number;
  file: string;
  size: number;
  sha256: string;
}

interface RefManifest {
  latest: number;
  imageHash?: string;
  references: RefManifestEntry[] | null;
}

const state = $state({
  status: 'idle' as
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'initializing'
    | 'ready'
    | 'error',
  /** True once bytes were actually fetched this load (gates the banner so a
   *  fully-cached cold start never shows download UI). */
  downloaded: false,
  progress: 0,
  error: null as string | null,
  db: null as Database | null,
});

export function getRefDbState() {
  return state;
}

const IDB_NAME = 'acnh';
const IDB_STORE = 'refdb';
const IDB_KEY = 'current';
const IDB_VERSION = 3;

export function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('refdb')) db.createObjectStore('refdb');
      if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress');
      if (!db.objectStoreNames.contains('imgcache')) db.createObjectStore('imgcache');
      // 'imgs' holds the actual image bytes ({buf, type} per path). It lives
      // in IndexedDB — not Cache Storage — so the ~25k images are never opened
      // on the service worker navigation path (the cause of slow iOS boots).
      if (!db.objectStoreNames.contains('imgs')) db.createObjectStore('imgs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
  });
}

async function idbGet(): Promise<{ version: number; sha: string; bytes: ArrayBuffer } | null> {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => {
        const r = req.result as { version?: number; sha?: string; bytes?: ArrayBuffer } | undefined;
        resolve(r?.bytes ? { version: r.version ?? 0, sha: r.sha ?? '', bytes: r.bytes } : null);
      };
      req.onerror = () => reject(req.error ?? new Error('indexeddb get failed'));
      tx.oncomplete = () => db.close();
    });
  }

  async function idbPut(version: number, sha: string, bytes: ArrayBuffer): Promise<void> {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ version, sha, bytes }, IDB_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error('indexeddb put failed'));
    });
  }

async function fetchManifest(): Promise<RefManifest> {
  const res = await fetch('/db/manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest request failed (${res.status})`);
  return (await res.json()) as RefManifest;
}

async function download(
  url: string,
  expectedSize: number,
  onProgress: (fraction: number) => void,
): Promise<ArrayBuffer> {
  // no-store: IndexedDB is our cache; never let the browser's HTTP cache serve
  // stale bytes for a URL whose content can change under the same version.
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`reference db download failed (${res.status})`);
  if (!res.body) return await res.arrayBuffer();
  // Content-Length may be missing (chunked/proxied responses) — fall back to
  // the size the manifest advertised so the progress bar still works.
  const total = Number(res.headers.get('Content-Length')) || expectedSize || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      if (total > 0) onProgress(received / total);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer as ArrayBuffer;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return '';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function gunzip(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

let sqlPromise: Promise<SqlJsStatic> | null = null;

export function initSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({ locateFile: () => sqlWasmUrl });
  return sqlPromise;
}

export async function loadReferenceDb(): Promise<void> {
  // 'checking' is silent: the manifest round-trip (and an IndexedDB cache hit
  // that follows) must never flash a "Downloading… 0%" bar at users whose
  // data is already on device.
  state.status = 'checking';
  state.progress = 0;
  state.downloaded = false;
  state.error = null;
  try {
    // Try to fetch manifest; if server is offline, fall back to cached DB
    let manifest: RefManifest;
    try {
      manifest = await fetchManifest();
    } catch {
      const cached = await idbGet();
      if (cached && cached.bytes.byteLength > 0) {
        // Server unreachable but we have a cached DB — use it silently
        state.status = 'initializing';
        const inflated = await gunzip(cached.bytes);
        const SQL = await initSql();
        state.db = new SQL.Database(new Uint8Array(inflated));
        state.status = 'ready';
        return;
      }
      throw new Error('Can\u2019t reach the server and no cached data available.');
    }

    const entry = manifest.references?.find((r) => r.version === manifest.latest);
    if (!entry) {
      throw new Error('Reference data isn\u2019t available yet \u2014 try again in a moment.');
    }

    const cached = await idbGet();
    let gz: ArrayBuffer;
    // Cache hit: version match AND the sha we stored next to the bytes matches
    // the manifest. We do NOT re-hash the cached bytes here — crypto.subtle
    // only exists in secure contexts (https/localhost), so on plain http LAN/
    // Tailscale URLs it is unavailable and an empty hash would always fail the
    // comparison, forcing a re-download on every refresh.
    if (cached && cached.version === manifest.latest && cached.sha === entry.sha256) {
      gz = cached.bytes;
    } else {
      state.status = 'downloading';
      gz = await download(`/db/${entry.file}`, entry.size, (f) => {
        state.progress = Math.round(f * 100);
      });
      state.downloaded = true;
      // Switch to "preparing" BEFORE hashing/decompressing: these phases can
      // take seconds on phones and used to show a frozen download percentage,
      // which read as a stall at ~95%.
      state.status = 'initializing';
      const sum = await sha256Hex(gz);
      if (sum && sum !== entry.sha256) {
        throw new Error(
          `reference db checksum mismatch: expected ${entry.sha256.slice(0, 12)}…, got ${sum.slice(0, 12)}…`,
        );
      }
      await idbPut(manifest.latest, sum || entry.sha256, gz);
    }

    const inflated = await gunzip(gz);
    const SQL = await initSql();
    state.db = new SQL.Database(new Uint8Array(inflated));
    state.status = 'ready';
  } catch (e) {
    state.status = 'error';
    state.error = e instanceof Error ? e.message : 'failed to load reference data';
  }
}
