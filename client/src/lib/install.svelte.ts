import { getRefDbState, loadReferenceDb, openIdb } from './refdb.svelte';
import { Unzip, AsyncUnzipInflate, type UnzipFile } from 'fflate';

// Image bundle install: download the db + one stored zip of every webp image,
// extract into Cache Storage, and mark the device as installed. Offered on the
// login screen (with a hint to add the app to the home screen first); never
// gates the app — declining just means images cache lazily as they're viewed.

const IMG_IDB_STORE = 'imgcache';
const IMG_IDB_KEY = 'hash';
// Must match CACHE_NAME for images in client/public/sw.js.
const IMG_CACHE = 'acnh-img-v3';

interface InstallState {
  phase: 'checking' | 'idle' | 'installing';
  /** Server reachable AND this device doesn't have the current bundle yet. */
  offer: boolean;
  /** This device has the current bundle in Cache Storage. */
  installed: boolean;
  sizeMB: number;
  progress: number;
  detail: string;
  error: string | null;
}

const install = $state<InstallState>({
  phase: 'checking',
  offer: false,
  installed: false,
  sizeMB: 0,
  progress: 0,
  detail: '',
  error: null,
});

let currentHash = '';

export function getInstallState() {
  return install;
}

async function imgCachedHash(): Promise<string> {
  try {
    const db = await openIdb();
    return await new Promise<string>((resolve) => {
      const tx = db.transaction(IMG_IDB_STORE, 'readonly');
      const req = tx.objectStore(IMG_IDB_STORE).get(IMG_IDB_KEY);
      req.onsuccess = () => resolve((req.result as { hash?: string } | undefined)?.hash ?? '');
      req.onerror = () => resolve('');
      tx.oncomplete = () => db.close();
    });
  } catch {
    return '';
  }
}

async function setImgCachedHash(hash: string): Promise<void> {
  try {
    const db = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMG_IDB_STORE, 'readwrite');
      tx.objectStore(IMG_IDB_STORE).put({ hash }, IMG_IDB_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch {
    // fingerprint loss just means a re-download next launch
  }
}

export async function checkInstall(): Promise<void> {
  try {
    const [dbRes, imgRes] = await Promise.all([
      fetch('/db/manifest.json', { cache: 'no-store' }),
      fetch('/img/manifest.json', { cache: 'no-store' }),
    ]);
    if (!dbRes.ok || !imgRes.ok) {
      // Server unreachable (or no bundle published): nothing to offer — an
      // offline visitor must never see a download button that can't work.
      install.phase = 'idle';
      return;
    }
    const dbManifest = (await dbRes.json()) as {
      latest: number;
      references?: { version: number; size: number }[] | null;
    };
    const imgManifest = (await imgRes.json()) as { hash?: string; zipSize?: number };
    const dbEntry = dbManifest.references?.find((r) => r.version === dbManifest.latest);
    const dbSize = dbEntry?.size ?? 0;
    const zipSize = imgManifest.zipSize ?? 0;
    install.sizeMB = Math.max(1, Math.round((dbSize + zipSize) / 1048576));
    currentHash = imgManifest.hash ?? '';
    install.installed = !!currentHash && (await imgCachedHash()) === currentHash;
    install.offer = !!currentHash && !install.installed;
    install.phase = 'idle';
  } catch {
    // Offline or server unreachable: no offer, never block on the network.
    install.phase = 'idle';
  }
}

async function ensureRefDbReady(): Promise<void> {
  const refdb = getRefDbState();
  if (refdb.status === 'ready') return;
  if (refdb.status === 'idle' || refdb.status === 'error') {
    await loadReferenceDb();
  }
  // A concurrent load (e.g. the app's own effect once a cached session exists)
  // may already be running — wait for it instead of starting a second one.
  while (refdb.status === 'downloading' || refdb.status === 'initializing') {
    await new Promise((r) => setTimeout(r, 100));
  }
  if ((getRefDbState().status as string) !== 'ready') {
    throw new Error(refdb.error ?? 'data download failed');
  }
}

export async function runInstall(): Promise<void> {
  install.phase = 'installing';
  install.progress = 0;
  install.detail = 'Downloading app data…';
  install.error = null;
  try {
    // 1) Reference db (small) — 0..25%
    await ensureRefDbReady();
    install.progress = 25;

    // 2) Image bundle — 25..65%
    install.detail = 'Downloading images…';
    const res = await fetch('/img/images.zip', { cache: 'no-store' });
    if (!res.ok) throw new Error(`image bundle download failed (${res.status})`);
    const total = Number(res.headers.get('Content-Length')) || 0;
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        if (total > 0) install.progress = 25 + 40 * (received / total);
      }
    }
    const data = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) {
      data.set(c, off);
      off += c.length;
    }
    chunks.length = 0;
    install.detail = 'Preparing images…';

    // 3) Extract into Cache Storage — 65..98%
    if (!('caches' in window)) throw new Error('offline storage is unavailable in this browser');
    const cache = await caches.open(IMG_CACHE);
    const files: UnzipFile[] = [];
    const unzip = new Unzip((file) => files.push(file));
    unzip.register(AsyncUnzipInflate);
    // Feed in chunks: a single multi-MB push overflows the stack inside fflate.
    const CHUNK = 1 << 20;
    for (let off = 0; off < data.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, data.length);
      unzip.push(data.subarray(off, end), end >= data.length);
    }
    for (let i = 0; i < files.length; i++) {
      try {
        const bytes = await new Promise<Uint8Array>((resolve, reject) => {
          const chunks: Uint8Array[] = [];
          files[i].ondata = (err, chunk, final) => {
            if (err) { reject(err); return; }
            if (chunk) chunks.push(chunk);
            if (final) {
              let total = 0;
              for (const c of chunks) total += c.length;
              const out = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) { out.set(c, off); off += c.length; }
              resolve(out);
            }
          };
          files[i].start();
        });
        await cache.put('/img/' + files[i].name, new Response(bytes.buffer as ArrayBuffer, { headers: { 'Content-Type': 'image/webp' } }));
      } catch {
        // skip a bad entry rather than abort the whole install
      }
      install.progress = 65 + 33 * ((i + 1) / Math.max(files.length, 1));
    }
    install.progress = 98;

    // 4) Mark installed
    if (!currentHash) {
      try {
        const imgRes = await fetch('/img/manifest.json', { cache: 'no-store' });
        currentHash = (await imgRes.json()).hash ?? '';
      } catch {}
    }
    if (currentHash) await setImgCachedHash(currentHash);
    install.progress = 100;
    install.installed = true;
    install.offer = false;
    install.phase = 'idle';
  } catch (e) {
    install.phase = 'idle'; // back to the login screen; error shows by the button
    install.error = e instanceof Error ? e.message : 'install failed';
  }
}