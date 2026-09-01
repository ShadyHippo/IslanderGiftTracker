import { getRefDbState, loadReferenceDb, openIdb } from './refdb.svelte';
import { putMany, requestPersistentStorage } from './imagedb';
import { Unzip, AsyncUnzipInflate, type UnzipFile } from 'fflate';

// Image bundle install: download the db + one stored zip of every webp image,
// extract into IndexedDB, and mark the device as installed. Offered on the
// login screen (with a hint to add the app to the home screen first); never
// gates the app — declining just means images cache lazily as they're viewed.
//
// Images go to IndexedDB (not Cache Storage) on purpose: a ~25k-entry Cache
// Storage cache is opened wholesale by WebKit on the first caches.open() of
// every cold start, which made PWA boot slow. IDB does indexed point lookups
// and is never touched by the service worker's navigation path.

const IMG_IDB_STORE = 'imgcache';
const IMG_IDB_KEY = 'hash';

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
  install.detail = 'Preparing app data…';
  install.error = null;
  try {
    // 1) Reference db (usually cached) — 0..10%. The bar used to hard-jump to
    // 25% here, which read as broken; a real first-run download reports its
    // own finer-grained progress via the refdb banner instead.
    await ensureRefDbReady();
    install.progress = 10;

    // 2) Image bundle — STREAMED. Network chunks feed straight into the
    // unzipper and each image lands in IndexedDB as its bytes arrive, so peak
    // memory is a few chunks + one flush batch — never the whole archive. A
    // dropped connection resumes via HTTP Range (the server supports it)
    // instead of restarting the ~200 MB download from byte zero.
    if (!('indexedDB' in window)) throw new Error('offline storage is unavailable in this browser');

    install.detail = 'Downloading images…';
    let entriesFound = 0;
    let entriesStored = 0;
    let entriesFailed = 0;
    // Writes are chained and flushed in batches: one IDB transaction per file
    // would be ~25k transactions; batching keeps memory AND transaction count
    // bounded (a batch of small webps is only a few MB).
    let putChain: Promise<void> = Promise.resolve();
    let pending: { path: string; buf: ArrayBuffer; type: string }[] = [];
    const flush = () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      putChain = putChain.then(async () => {
        entriesFailed += await putMany(batch);
        entriesStored += batch.length;
        // Extraction phase (after the stream ends): 80%..97% follows the
        // stored-file count so the bar keeps moving while trailing writes drain.
        if (streamEnded && entriesFound > 0) {
          install.progress = Math.min(
            97,
            80 + 17 * (entriesStored / entriesFound),
          );
        }
      });
    };
    // Progress is single-writer per phase: while the stream is reading, the
    // byte-based download formula owns the bar. Only after the stream ends do
    // stored-file counts take over. Both formulas firing at once used to
    // make the bar visibly flash between download % and the 97% extraction
    // cap, because puts complete while chunks are still arriving.
    let streamEnded = false;

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
          pending.push({ path: '/img/' + file.name, buf: out.buffer as ArrayBuffer, type: 'image/webp' });
          if (pending.length >= 200) flush();
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
            if (total > 0) install.progress = 10 + 70 * Math.min(1, received / total);
          }
        }
        install.detail = 'Saving images to this device…';
        streamEnded = true;
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

    flush(); // trailing partial batch
    await putChain;
    // A meaningful number of failures means device storage gave out mid-install
    // — that must NEVER masquerade as success (it leaves a half-empty store).
    if (entriesFailed >= Math.max(5, Math.ceil(entriesFound * 0.001))) {
      throw new Error(
        `${entriesFailed} of ${entriesFound} images could not be stored — ` +
        'your device may be out of space. Free up room and try again.',
      );
    }
    install.progress = 98;

    // Ask the browser not to evict the bundle under storage pressure — this is
    // the data that makes airplane mode work.
    await requestPersistentStorage();

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