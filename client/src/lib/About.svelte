<script lang="ts">
  import { getAbout, dismissAbout } from './about.svelte';
  import { getProgressState, exportProgressFile } from './progress.svelte';
  import { getSession } from './session.svelte';
  import { detectPlatform, isStandalone, installHint } from './platform.svelte';
  import { navigate } from './router';

  const about = getAbout();
  const progress = getProgressState();
  const session = getSession();

  // Build marker so the user can confirm which deploy is running.
  const BUILD_HASH: string =
    typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev';
  const BUILD_TIME: string =
    typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';

  let clearing = $state(false);
  async function hardReload(): Promise<void> {
    if (clearing) return;
    if (!confirm('Clear offline cache and hard reload?\n\nRe-downloads images on next load. Your gift progress is kept (re-synced from server).')) return;
    clearing = true;
    try {
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
    } catch {}
    location.reload();
  }

  function openPrivacy() {
    dismissAbout();
    void navigate('/privacy');
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && about.open) dismissAbout();
  }

  const platform = $state({ p: 'desktop' as ReturnType<typeof detectPlatform>, standalone: false });
  $effect(() => {
    if (about.open) {
      platform.p = detectPlatform();
      platform.standalone = isStandalone();
    }
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if about.open}
  <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
    <div
      data-about-modal
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      class="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl border border-green-200 bg-white p-6 shadow-lg"
    >
      <h2 id="about-title" class="mb-4 text-xl font-bold text-green-800">About this app</h2>

      <div class="mb-4 rounded-lg border-2 border-red-500 bg-yellow-100 p-3">
        <p class="text-sm font-extrabold text-red-900">⚠️ ONE DEVICE PER ACCOUNT</p>
        <p class="mt-1 text-sm font-bold leading-snug text-red-900">
          Use this account on ONE device only. Signing in on a second device can
          permanently overwrite your data.
        </p>
      </div>

      <section class="mb-5">
        <h3 class="mb-1 text-sm font-bold text-green-900">Your data &amp; offline mode</h3>
        <p class="text-xs leading-relaxed text-green-700">
          Everything works offline once installed — your gift log lives on this
          device and syncs to the server automatically whenever you're online.
          The badges at the bottom tell you where you stand: green means safely
          saved and synced.
        </p>
        <p class="mt-2 text-xs leading-relaxed text-green-700">
          Clearing your browser's site data deletes the offline copies on this
          device. Anything already synced is safe on the server; unsaved edits
          would be lost. The server also keeps recent backups of your data.
        </p>
        {#if session.user && progress.status === 'ready'}
          <button
            type="button"
            onclick={() => exportProgressFile(session.user!.username)}
            class="mt-3 w-full rounded-lg border border-green-300 bg-white px-4 py-2.5 text-sm font-semibold text-green-800 transition-colors hover:bg-green-100 focus:outline-none focus:ring-2 focus:ring-green-200"
          >
            ⬇ Download my data (.sqlite)
          </button>
          <p class="mt-1 text-center text-[11px] text-green-600">
            A byte-exact copy of your gift log that you own and keep.
          </p>
        {/if}
      </section>

      <section class="mb-5">
        <h3 class="mb-1 text-sm font-bold text-green-900">Install like an app</h3>
        {#if platform.standalone}
          <p class="text-xs leading-relaxed text-green-700">
            ✓ Already installed — you're running it as an app.
          </p>
        {:else}
          <p class="text-xs leading-relaxed text-green-700">
            {installHint(platform.p)} It then opens in its own window, full
            screen, and keeps working without internet.
          </p>
        {/if}
        <button
          type="button"
          onclick={hardReload}
          disabled={clearing}
          class="mt-2 text-[11px] font-medium text-green-600 underline decoration-dotted hover:text-green-800 disabled:opacity-50"
          title="Clear offline cache & hard reload"
        >
          {clearing ? 'Clearing…' : 'Clear offline cache & reload'}
        </button>
      </section>

      <p class="mb-2 text-sm leading-relaxed text-green-900">
        This is a non-commercial fan project. We own nothing of the images — all
        artwork and game content belong to their original owners.
      </p>
      <p class="mb-5 text-xs leading-relaxed text-green-700">
        Animal Crossing: New Horizons and all related assets are © Nintendo.
        This app is not affiliated with or endorsed by Nintendo.
      </p>

      <a
        href="https://buymeacoffee.com/timvandyke"
        target="_blank"
        rel="noopener noreferrer"
        class="mb-3 block w-full rounded-lg bg-[#FFDD00] px-4 py-2.5 text-center text-base font-bold text-black no-underline transition-[filter] hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-yellow-400"
      >
        ☕ Buy me a coffee
      </a>

      <div class="mb-4 flex items-center justify-between gap-3 text-xs">
        <a
          href="https://github.com/ShadyHippo/IslanderGiftTracker"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-green-700 underline decoration-dotted hover:text-green-900"
        >
          Source code ↗
        </a>
        <button
          type="button"
          onclick={openPrivacy}
          class="font-medium text-green-700 underline decoration-dotted hover:text-green-900"
        >
          Privacy policy
        </button>
      </div>

      <p class="mb-3 select-text text-center text-[10px] leading-none text-green-800/40">
        {BUILD_HASH}{BUILD_TIME ? ` · ${BUILD_TIME}` : ''}
      </p>

      <button
        type="button"
        data-about-close
        onclick={dismissAbout}
        class="w-full rounded-lg bg-green-700 px-4 py-2.5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-green-800 focus:outline-none focus:ring-2 focus:ring-green-300"
      >
        Got it
      </button>
    </div>
  </div>
{/if}
