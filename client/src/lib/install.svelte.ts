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
  /** Download size (db + zip), megabytes. */
  sizeMB: number;
  /** Space the extracted images occupy on device, megabytes. */
  onDeviceMB: number;
  progress: number;
  detail: string;
  error: string | null;
}

const install = $state<InstallState>({
  phase: 'checking',
  offer: false,
  installed: false,
  sizeMB: 0,
  onDeviceMB: 0,
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

function newUnzip(onFile: (file: UnzipFile) => void): Unzip {
  const unzip = new Unzip(onFile);
  unzip.register(AsyncUnzipInflate);
  return unzip;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
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
    const imgManifest = (await imgRes.json()) as {
      hash?: string;
      zipSize?: number;
      totalBytes?: number;
    };
    const dbEntry = dbManifest.references?.find((r) => r.version === dbManifest.latest);
    const dbSize = dbEntry?.size ?? 0;
    const zipSize = imgManifest.zipSize ?? 0;
    install.sizeMB = Math.max(1, Math.round((dbSize + zipSize) / 1048576));
    install.onDeviceMB = Math.max(1, Math.round((dbSize + (imgManifest.totalBytes ?? zipSize)) / 1048576));
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

    // 2) Image bundle — STREAMED. Network chunks feed straight into the
    // unzipper and each image lands in Cache Storage as its bytes arrive, so
    // peak memory is a few chunks + the largest single image — never the whole
    // archive. A dropped connection resumes via HTTP Range (the server supports
    // it) instead of restarting the ~200 MB download from byte zero.
    if (!('caches' in window)) throw new Error('offline storage is unavailable in this browser');
    const cache = await caches.open(IMG_CACHE);

    install.detail = 'Downloading images…';
    let entriesFound = 0;
    let entriesDone = 0;
    let entriesFailed = 0;
    // Writes are chained so only one cache.put runs at a time.
    let putChain: Promise<void> = Promise.resolve();

    const onFile = (file: UnzipFile) => {
      entriesFound++;
      const chunks: Uint8Array[] = [];
      file.ondata = (err, chunk, final) => {
        if (err) {
          entriesFailed++;
          return;
        }
        if (chunk) chunks.push(chunk);
        if (final) {
          const out = concatChunks(chunks);
          chunks.length = 0;
          const name = file.name;
          putChain = putChain.then(async () => {
            try {
              await cache.put('/img/' + name, new Response(out.buffer as ArrayBuffer, {
                headers: { 'Content-Type': 'image/webp' },
              }));
            } catch {
              entriesFailed++;
            }
            entriesDone++;
          });
        }
      };
      file.start();
    };

    let received = 0;
    let total = 0;
    let unzip = newUnzip(onFile);
    const MAX_ATTEMPTS = 5;

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {};
      if (received > 0) headers.range = `bytes=${received}-`;
      const res = await fetch('/img/images.zip', { headers, cache: 'no-store' });
      if (!res.ok && res.status !== 206) {
        throw new Error(`image bundle download failed (${res.status})`);
      }
      if (res.status === 206 && received > 0) {
        // Resumed: Content-Range carries the full length ("bytes a-b/total").
        const cr = res.headers.get('Content-Range');
        const t = cr ? Number(cr.split('/')[1]) : NaN;
        if (Number.isFinite(t) && t > 0) total = t;
      } else {
        if (received > 0) {
          // Server ignored Range and restarted from zero — re-create the
          // extractor; splicing would corrupt it.
          unzip = newUnzip(onFile);
          received = 0;
        }
        total = Number(res.headers.get('Content-Length')) || 0;
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('streaming not supported in this browser');
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            unzip.push(value);
            received += value.length;
            if (total > 0) install.progress = 25 + 70 * Math.min(1, received / total);
          }
        }
        unzip.push(new Uint8Array(0), true); // end of archive
        break; // downloaded fully
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS - 1) {
          throw new Error(
            `download interrupted at ${(received / 1048576).toFixed(0)} MB of ` +
            `${(total / 1048576).toFixed(0)} MB — check your connection and try again ` +
            '(it resumes where it left off)',
          );
        }
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }

    await putChain; // flush trailing writes
    // A meaningful number of failures means device storage gave out mid-install
    // — that must NEVER masquerade as success (it leaves a half-empty cache).
    if (entriesFailed >= Math.max(5, Math.ceil(entriesFound * 0.001))) {
      throw new Error(
        `${entriesFailed} of ${entriesFound} images could not be stored — ` +
        'your device may be out of space. Free up room and try again.',
      );
    }
    install.progress = 98;

    // Purge side-effect copies an older service worker may have made (the zip
    // is ~200 MB of dead weight, and a stale manifest poisons future updates).
    await cache.delete('/img/images.zip');
    await cache.delete('/img/manifest.json');

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