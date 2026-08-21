import type { Database } from 'sql.js';
import { initSql } from './refdb.svelte';
import { progressDownload, progressUpload } from './api';

/**
 * Per-user progress db: a second, tiny sqlite database holding ONLY the user's
 * own data (gift log). It's uploaded/downloaded as a single file via
 * /api/progress — that one file is everything the user needs to back up.
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villager TEXT NOT NULL,
  item TEXT NOT NULL,
  date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS villagers (
  name TEXT PRIMARY KEY,
  favorite INTEGER NOT NULL DEFAULT 0,
  on_island INTEGER NOT NULL DEFAULT 0
);`;

export interface VillagerFlags {
  favorite: boolean;
  onIsland: boolean;
}

const state = $state({
  status: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
  db: null as Database | null,
  /** Bumped on every mutation so $derived callers re-query the db. */
  version: 0,
  /** Unsynced edits exist (network badge amber until the server confirms). */
  dirty: false,
  saving: false,
  /** The device-local copy is persisted (local badge green). */
  localSaved: true,
  error: null as string | null,
  savedAt: null as string | null,
});

export function getProgressState() {
  return state;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

const AUTOSAVE_MS = 1500;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveProgress();
  }, AUTOSAVE_MS);
}

/**
 * Persist the current progress db to IndexedDB immediately.
 * Called on every edit so a mutation survives even if the tab is killed before
 * the debounced server sync runs — online or offline. Writes are marked
 * UNSYNCED: only a confirmed server upload clears that flag (see loadProgress).
 */
function persistLocal(): void {
  const db = state.db;
  if (!db) return;
  try {
    const bytes = db.export();
    state.localSaved = false;
    void idbSaveProgress(bytes.buffer, true)
      .catch(() => {})
      .finally(() => {
        state.localSaved = true;
      });
  } catch {
    state.localSaved = true;
  }
}

/** Persist raw bytes to IndexedDB so data survives offline tab close. */
const PROG_IDB = 'acnh';
const PROG_STORE = 'progress';
const PROG_KEY = 'current';

function openProgIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PROG_IDB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('refdb')) db.createObjectStore('refdb');
      if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress');
      if (!db.objectStoreNames.contains('imgcache')) db.createObjectStore('imgcache');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
  });
}

interface ProgRecord {
  bytes: ArrayBufferLike;
  /** True while local edits have not been confirmed by the server. */
  unsynced: boolean;
}

async function idbSaveProgress(bytes: ArrayBufferLike, unsynced: boolean): Promise<void> {
  try {
    const db = await openProgIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PROG_STORE, 'readwrite');
      tx.objectStore(PROG_STORE).put({ bytes, unsynced } satisfies ProgRecord, PROG_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch { /* non-critical */ }
}

async function idbLoadProgress(): Promise<ProgRecord | null> {
  try {
    const db = await openProgIdb();
    return new Promise((resolve) => {
      const tx = db.transaction(PROG_STORE, 'readonly');
      const req = tx.objectStore(PROG_STORE).get(PROG_KEY);
      req.onsuccess = () => {
        db.close();
        // Legacy records were bare ArrayBuffers (no unsync flag) — treat them
        // as unsynced so we push rather than risk clobbering unknown edits.
        const r = req.result as ProgRecord | ArrayBuffer | undefined;
        if (!r) return resolve(null);
        if (r instanceof ArrayBuffer) return resolve({ bytes: r, unsynced: true });
        resolve(r.bytes ? { bytes: r.bytes, unsynced: !!r.unsynced } : null);
      };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch { return null; }
}

/** Best-effort final flush when the tab is closing (keepalive survives unload). */
export function flushProgressOnUnload(): void {
  const db = state.db;
  if (!db || !state.dirty) return;
  const bytes = db.export();
  // Always persist to IndexedDB — survives offline tab close
  void idbSaveProgress(bytes.buffer, true);
  // Only attempt the server PUT when the network is up. Offline it can never
  // succeed, and an in-flight keepalive request during unload aborts the next
  // navigation (ERR_FAILED), preventing the app from reloading offline to
  // recover the IndexedDB copy. The 'online' listener re-syncs on reconnect.
  if (!navigator.onLine) return;
  try {
    fetch('/api/progress', {
      method: 'PUT',
      body: new Blob([bytes as unknown as BlobPart]),
      keepalive: true,
    });
  } catch {
    // best effort
  }
}

export async function loadProgress(): Promise<void> {
  if (state.status === 'loading' || state.status === 'ready') return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  state.status = 'loading';
  state.error = null;
  const SQL = await initSql();
  try {
    // SINGLE DEVICE RULE: if this device has edits the server never confirmed,
    // the LOCAL copy is the source of truth — push it up. Never pull the
    // server's older copy over unsynced local edits; that loses data.
    const cached = await idbLoadProgress();
    let bytes: ArrayBufferLike;
    let pushLocal = false;
    if (cached?.unsynced && cached.bytes.byteLength > 0) {
      bytes = cached.bytes;
      pushLocal = true;
    } else {
      try {
        bytes = await progressDownload();
        // Got fresh data from server — update local cache (in sync)
        await idbSaveProgress(bytes, false);
      } catch {
        // Server unreachable — try local cache
        if (!cached || cached.bytes.byteLength === 0) {
          throw new Error('Cannot reach server and no local backup found.');
        }
        bytes = cached.bytes;
      }
    }
    const db = new SQL.Database(new Uint8Array(bytes));
    db.exec(SCHEMA);
    state.db = db;
    state.version++;
    state.dirty = pushLocal;
    state.status = 'ready';
    // Unsynced local edits: push them to the server now (no-op while offline;
    // the 'online' listener and next edit retry later).
    if (pushLocal) void saveProgress();
  } catch (e) {
    state.status = 'error';
    state.error = e instanceof Error ? e.message : 'failed to load progress data';
  }
}

/** Item names already gifted to this villager. */
export function giftedItems(villager: string): Set<string> {
  const db = state.db;
  if (!db) return new Set();
  const out = new Set<string>();
  for (const r of db.exec('SELECT item FROM gifts WHERE villager = ?', [villager])) {
    for (const row of r.values) {
      if (typeof row[0] === 'string') out.add(row[0]);
    }
  }
  return out;
}

/** Log a gift (or delete it when already logged — undo). */
export function toggleGifted(villager: string, item: string): void {
  const db = state.db;
  if (!db) return;
  const existing = db.exec('SELECT id FROM gifts WHERE villager = ? AND item = ?', [villager, item]);
  if (existing.length && existing[0].values.length) {
    db.run('DELETE FROM gifts WHERE villager = ? AND item = ?', [villager, item]);
  } else {
    const now = new Date();
    db.run('INSERT INTO gifts (villager, item, date, note, created_at) VALUES (?, ?, ?, ?, ?)', [
      villager,
      item,
      now.toISOString().slice(0, 10),
      null,
      now.toISOString(),
    ]);
  }
  state.version++;
  state.dirty = true;
  state.error = null;
  // Persist locally NOW so the edit is safe offline, then sync to server.
  persistLocal();
  scheduleSave();
}

/**
 * Persist locally (always) and sync to the server (only when online).
 * Offline: the local copy is marked unsynced and the network badge simply
 * stays amber ("pending") — we never attempt a PUT that cannot succeed.
 */
export async function saveProgress(): Promise<void> {
  const db = state.db;
  if (!db || state.saving) return;
  const bytes = db.export();
  // Local first — data is safe on this device no matter what happens next.
  await idbSaveProgress(bytes.buffer, true);
  state.localSaved = true;
  if (!navigator.onLine) {
    state.dirty = true; // stays amber until we're back online
    return;
  }
  state.saving = true;
  try {
    await progressUpload(bytes);
    // Server confirmed — the local copy is now in sync
    await idbSaveProgress(bytes.buffer, false);
    state.dirty = false;
    state.savedAt = new Date().toLocaleTimeString();
  } catch {
    // Stay amber; re-sync happens on the next edit or when the browser fires
    // 'online' (App.svelte). No scary error text for routine offline/failed
    // syncs — the badge color IS the status.
    state.dirty = true;
  } finally {
    state.saving = false;
  }
}

/** Flags for every villager that has a row (unflagged villagers aren't present). */
export function allVillagerFlags(): Map<string, VillagerFlags> {
  const db = state.db;
  const out = new Map<string, VillagerFlags>();
  if (!db) return out;
  for (const r of db.exec('SELECT name, favorite, on_island FROM villagers')) {
    for (const row of r.values) {
      if (typeof row[0] === 'string') {
        out.set(row[0], { favorite: Number(row[1]) === 1, onIsland: Number(row[2]) === 1 });
      }
    }
  }
  return out;
}

function flipFlag(name: string, col: 'favorite' | 'on_island') {
  const db = state.db;
  if (!db) return;
  db.run('INSERT INTO villagers (name, favorite, on_island) VALUES (?, 0, 0) ON CONFLICT(name) DO NOTHING', [
    name,
  ]);
  db.run(`UPDATE villagers SET ${col} = 1 - ${col} WHERE name = ?`, [name]);
  // No flags set -> drop the row entirely so the db stays clean.
  db.run('DELETE FROM villagers WHERE favorite = 0 AND on_island = 0');
  state.version++;
  state.dirty = true;
  state.error = null;
  // Persist locally NOW so the edit is safe offline, then sync to server.
  persistLocal();
  scheduleSave();
}

export function toggleFavorite(name: string) {
  flipFlag(name, 'favorite');
}

export function toggleOnIsland(name: string) {
  flipFlag(name, 'on_island');
}
