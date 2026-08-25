/**
 * Offline-cache maintenance for the About modal's "Clear offline cache &
 * reload" action. Pure machinery — the confirm dialog and button state live
 * in the component so the wording stays editable there.
 *
 * Clears, in order: every Cache Storage entry (app shell + image caches),
 * every service worker registration, and the acnh/imgcache IndexedDB store
 * that holds the extracted image bundle. Any failure is swallowed on purpose:
 * the reload that follows re-fetches whatever survived.
 */
export async function purgeOfflineCaches(): Promise<void> {
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
  // Clear the precache fingerprint so images re-cache on next load
  try {
    const idb: IDBDatabase = await new Promise((res, rej) => {
      const req = indexedDB.open('acnh', 2);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    await new Promise<void>((res) => {
      const tx = idb.transaction('imgcache', 'readwrite');
      tx.objectStore('imgcache').clear();
      tx.oncomplete = () => { idb.close(); res(); };
      tx.onerror = () => { idb.close(); res(); };
    });
  } catch {}
}
