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

/** Best-effort final flush when the tab is closing (keepalive survives unload). */
export function flushProgressOnUnload(): void {
  const db = state.db;
  if (!db || !state.dirty) return;
  try {
    fetch('/api/progress', {
      method: 'PUT',
      body: new Blob([db.export() as unknown as BlobPart]),
      keepalive: true,
    });
  } catch {
    // best effort; the debounced save usually already covered this
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
  try {
    const bytes = await progressDownload();
    const SQL = await initSql();
    const db = new SQL.Database(new Uint8Array(bytes));
    db.exec(SCHEMA); // server pre-creates it, but stay safe with a fresh/empty file
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
  scheduleSave();
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;
const MAX_RETRY_DELAY = 30000;

/** Upload the user's progress db to the server — the single backup file. */
export async function saveProgress(): Promise<void> {
  const db = state.db;
  if (!db || state.saving) return;
  state.saving = true;
  state.error = null;
  try {
    await progressUpload(db.export());
    state.dirty = false;
    state.savedAt = new Date().toLocaleTimeString();
    retryCount = 0;
  } catch (e) {
    state.error = e instanceof Error ? e.message : 'save failed';
    // Schedule retry with exponential backoff
    retryCount++;
    const delay = Math.min(1000 * Math.pow(2, retryCount - 1), MAX_RETRY_DELAY);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      state.dirty = true; // mark so the badge shows correctly
      void saveProgress();
    }, delay);
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
  scheduleSave();
}

export function toggleFavorite(name: string) {
  flipFlag(name, 'favorite');
}

export function toggleOnIsland(name: string) {
  flipFlag(name, 'on_island');
}
