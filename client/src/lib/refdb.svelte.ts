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
  references: RefManifestEntry[] | null;
}

export type RefDbStatus = 'idle' | 'downloading' | 'initializing' | 'ready' | 'error';

const state = $state({
  status: 'idle' as RefDbStatus,
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

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
  });
}

async function idbGet(): Promise<{ version: number; bytes: ArrayBuffer } | null> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve((req.result as { version: number; bytes: ArrayBuffer } | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('indexeddb get failed'));
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(version: number, bytes: ArrayBuffer): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ version, bytes }, IDB_KEY);
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

async function download(url: string, onProgress: (fraction: number) => void): Promise<ArrayBuffer> {
  // no-store: IndexedDB is our cache; never let the browser's HTTP cache serve
  // stale bytes for a URL whose content can change under the same version.
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`reference db download failed (${res.status})`);
  if (!res.body) return await res.arrayBuffer();
  const total = Number(res.headers.get('Content-Length')) || 0;
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
  state.status = 'downloading';
  state.progress = 0;
  state.error = null;
  try {
    const manifest = await fetchManifest();
    const entry = manifest.references?.find((r) => r.version === manifest.latest);
    if (!entry) {
      throw new Error('Reference data isn\u2019t available yet \u2014 try again in a moment.');
    }

    const cached = await idbGet();
    let gz: ArrayBuffer;
    if (cached && cached.version === manifest.latest && (await sha256Hex(cached.bytes)) === entry.sha256) {
      gz = cached.bytes;
    } else {
      gz = await download(`/db/${entry.file}`, (f) => {
        state.progress = Math.round(f * 100);
      });
      const sum = await sha256Hex(gz);
      if (sum && sum !== entry.sha256) {
        throw new Error(
          `reference db checksum mismatch: expected ${entry.sha256.slice(0, 12)}…, got ${sum.slice(0, 12)}…`,
        );
      }
      await idbPut(manifest.latest, gz);
    }

    state.status = 'initializing';
    const inflated = await gunzip(gz);
    const SQL = await initSql();
    state.db = new SQL.Database(new Uint8Array(inflated));
    state.status = 'ready';
  } catch (e) {
    state.status = 'error';
    state.error = e instanceof Error ? e.message : 'failed to load reference data';
  }
}
