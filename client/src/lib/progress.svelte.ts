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
  dirty: false,
  saving: false,
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

async function idbSaveProgress(bytes: ArrayBuffer): Promise<void> {
  try {
    const db = await openProgIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PROG_STORE, 'readwrite');
      tx.objectStore(PROG_STORE).put(bytes, PROG_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch { /* non-critical */ }
}

async function idbLoadProgress(): Promise<ArrayBuffer | null> {
  try {
    const db = await openProgIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PROG_STORE, 'readonly');
      const req = tx.objectStore(PROG_STORE).get(PROG_KEY);
      req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch { return null; }
}

/** Best-effort final flush when the tab is closing (keepalive survives unload). */
export function flushProgressOnUnload(): void {
  const db = state.db;
  if (!db || !state.dirty) return;
  const bytes = db.export();
  // Always persist to IndexedDB — survives offline tab close
  void idbSaveProgress(bytes.buffer);
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
    // Try server first; fall back to IndexedDB cache
    let bytes: ArrayBuffer;
    try {
      bytes = await progressDownload();
      // Got fresh data from server — update local cache
      await idbSaveProgress(bytes);
    } catch {
      // Server unreachable — try local cache
      const cached = await idbLoadProgress();
      if (!cached || cached.byteLength === 0) {
        throw new Error('Cannot reach server and no local backup found.');
      }
      bytes = cached;
    }
    const db = new SQL.Database(new Uint8Array(bytes));
    db.exec(SCHEMA);
    state.db = db;
    state.version++;
    state.dirty = false;
    state.status = 'ready';
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
  pendingMutation = true;
  scheduleSave();
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMutation = false;

/**
 * Save progress to server + IndexedDB. On failure, retry once after 2s.
 * Further retries only happen when the user triggers a new mutation.
 */
export async function saveProgress(): Promise<void> {
  const db = state.db;
  if (!db || state.saving) return;
  state.saving = true;
  state.error = null;
  pendingMutation = false;
  const bytes = db.export();
  try {
    // Always persist locally first — data is safe even if server is down
    await idbSaveProgress(bytes.buffer);
    await progressUpload(bytes);
    state.dirty = false;
    state.savedAt = new Date().toLocaleTimeString();
  } catch (e) {
    state.error = 'Save failed — will retry on next edit';
    state.dirty = true;
    // One retry after 2s; no further auto-retries
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      // Only retry if no mutation happened (mutation will trigger its own save)
      if (!pendingMutation) void saveProgress();
    }, 2000);
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
  pendingMutation = true;
  scheduleSave();
}

export function toggleFavorite(name: string) {
  flipFlag(name, 'favorite');
}

export function toggleOnIsland(name: string) {
  flipFlag(name, 'on_island');
}
