<script lang="ts">
  import { getAbout, dismissAbout } from './about.svelte';
  import { getProgressState, exportProgressFile } from './progress.svelte';
  import { getSession, clearLocalSession } from './session.svelte';
  import { deleteAccount } from './api';
  import { detectPlatform, isStandalone, installHint } from './platform.svelte';
  import { navigate } from './router';
  import { purgeOfflineCaches } from './maintenance';

  const about = getAbout();
  const progress = getProgressState();
  const session = getSession();

  // Build marker so the user can confirm which deploy is running.
  const BUILD_HASH: string =
    typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev';
  const BUILD_TIME: string =
    typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';

  // Platform can't change while the app runs (installing the PWA always
  // means a fresh session), so these are plain values, not state.
  const platform = { p: detectPlatform(), standalone: isStandalone() };

  let clearing = $state(false);
  async function onClearCache(): Promise<void> {
    if (clearing) return;
    if (!confirm('Clear offline cache and hard reload?\n\nRe-downloads images on next load. Your gift progress is kept (re-synced from server).')) return;
    clearing = true;
    await purgeOfflineCaches();
    location.reload();
  }

  function openPrivacy() {
    dismissAbout();
    void navigate('/privacy');
  }

  let deleting = $state(false);
  async function onDeleteAccount() {
    if (deleting) return;
    const msg =
      'Delete your account PERMANENTLY?\n\n' +
      'This wipes your gift log and all server backups of it. ' +
      'Download your data first if you want to keep a copy.';
    if (!confirm(msg)) return;
    if (!confirm('Last chance — this cannot be undone. Delete?')) return;
    deleting = true;
    try {
      await deleteAccount();
      clearLocalSession();
      // Full navigation so every in-memory store resets cleanly.
      window.location.assign('/');
    } catch {
      alert('Could not delete the account right now — try again later.');
      deleting = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && about.open) dismissAbout();
  }

  // Click outside the dialog closes it.
  //
  // The pointerdown handler records — but does NOT act on — whether the
  // gesture started outside the modal. Closing on pointerdown would unmount
  // the backdrop mid-gesture, so on touch devices the browser re-hit-tests
  // the synthesized click at the finger's position and it lands on whatever
  // was beneath (tapping the dimmed background to close could toggle a
  // villager's favorite/island state behind the popup). By unmounting only
  // on the click (backdrop still present when the click's target resolves),
  // the click can never pass through to content below.
  //
  // The flag also stops the same click that OPENS the modal (the header
  // About button) from immediately closing it: pointerdown ran while the
  // modal was still closed, so the flag stays false.
  let gestureStartedOutside = false;

  function onWindowPointerDown(e: PointerEvent) {
    gestureStartedOutside = false;
    if (!about.open) return;
    const modal = document.querySelector('[data-about-modal]');
    if (modal && !modal.contains(e.target as Node)) gestureStartedOutside = true;
  }

  function onOutsideClick(e: MouseEvent) {
    if (!gestureStartedOutside) return;
    gestureStartedOutside = false;
    if (!about.open) return;
    const modal = document.querySelector('[data-about-modal]');
    if (modal && !modal.contains(e.target as Node)) dismissAbout();
  }
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onWindowPointerDown} onclick={onOutsideClick} />

{#if about.open}
  <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
    <div
      data-about-modal
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      tabindex="-1"
      class="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl border border-green-200 bg-white p-6 shadow-lg"
    >
      <h2 id="about-title" class="mb-4 text-xl font-bold text-green-800">Welcome to ACNH Gift Tracker!</h2>

      <!-- ═══════ 1. One-device warning ═══════ -->
      <div class="mb-4 rounded-lg border-2 border-red-500 bg-yellow-100 p-3">
        <p class="text-sm font-extrabold text-red-900">⚠️ WARNING: ONE DEVICE IF OFFLINE</p>
        <p class="mt-1 text-sm font-bold leading-snug text-red-900">
          Use this app/website on ONE device only. Signing in on a second device and 
          using offline functionality can permanently overwrite your data. 
        </p>
      </div>

      <!-- ═══════ 2. Install like an app (collapsible) ═══════ -->
      <details class="group mb-5">
        <summary class="flex cursor-pointer list-none items-center justify-between gap-3">
          <h3 class="text-sm font-bold text-green-900">Install like an app</h3>
          <span class="text-green-400 transition-transform group-open:rotate-90">›</span>
        </summary>
        {#if platform.standalone}
          <p class="text-xs leading-relaxed text-green-700">
            ✓ Already installed — running as an app.
          </p>
        {:else}
          <p class="text-xs leading-relaxed text-green-700">
            {installHint(platform.p)} It then opens in its own window, full
            screen, and keeps working offline (or when my server is down).
          </p>
        {/if}
      </details>

      <!-- ═══════ 3. Support ═══════ -->
      <a
        href="https://buymeacoffee.com/timvandyke"
        target="_blank"
        rel="noopener noreferrer"
        class="mb-3 block w-full rounded-lg bg-[#FFDD00] px-4 py-2.5 text-center text-base font-bold text-black no-underline transition-[filter] hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-yellow-400"
      >
        ☕ Buy me a coffee
      </a>

      <!-- ═══════ 4. Close ═══════ -->
      <button
        type="button"
        data-about-close
        onclick={dismissAbout}
        class="w-full rounded-lg bg-green-700 px-4 py-2.5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-green-800 focus:outline-none focus:ring-2 focus:ring-green-300"
      >
        Got it
      </button>

      <!-- ═══════ 5. Links + build marker ═══════ -->
      <div class="mb-4 flex items-center justify-between gap-3 text-xs">
        <a
          href="https://github.com/ShadyHippo/IslanderGiftTracker"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-green-700 underline decoration-dotted hover:text-green-900"
        >
          Source code ↗
        </a>
        <div class="flex items-center gap-3">
          <button
            type="button"
            onclick={openPrivacy}
            class="font-medium text-green-700 underline decoration-dotted hover:text-green-900"
          >
            Privacy policy
          </button>
          <button
            type="button"
            onclick={() => { dismissAbout(); void navigate('/tos'); }}
            class="font-medium text-green-700 underline decoration-dotted hover:text-green-900"
          >
            Terms
          </button>
        </div>
      </div>

      <!-- ═══════ 6. Your data & offline mode (export + danger zone, collapsible) ═══════ -->
      <details class="group mb-5">
        <summary class="flex cursor-pointer list-none items-center justify-between gap-3">
          <h3 class="text-sm font-bold text-green-900">Your data &amp; offline mode</h3>
          <span class="text-green-400 transition-transform group-open:rotate-90">›</span>
        </summary>
        <p class="text-xs leading-relaxed text-green-700">
          I'm just a hobbyist with a server, my server has nightly downtime when 
          the router reboots and when I do maintenance on my server. 
        </p>
        <p class="text-xs leading-relaxed text-green-700">
          Everything works offline once installed — your gift log lives on this
          device and syncs to the server automatically when both are online.
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
            A copy of your gift log that you own and keep.
          </p>
        {/if}
        <button
          type="button"
          onclick={onClearCache}
          disabled={clearing}
          class="mt-2 text-[11px] font-medium text-green-600 underline decoration-dotted hover:text-green-800 disabled:opacity-50"
          title="Clear offline cache & hard reload"
        >
          {clearing ? 'Clearing…' : 'Clear offline cache & reload'}
        </button>
        {#if session.user}
          <div class="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
            <p class="text-xs font-semibold text-red-800">Danger zone</p>
            <button
              type="button"
              onclick={onDeleteAccount}
              disabled={deleting}
              class="mt-2 w-full rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:opacity-60"
            >
              {deleting ? 'Deleting…' : 'Delete my account'}
            </button>
          </div>
        {/if}
      </details>

      <p class="mb-3 select-text text-center text-[10px] leading-none text-green-800/40">
        {BUILD_HASH}{BUILD_TIME ? ` · ${BUILD_TIME}` : ''}
      </p>

      <!-- ═══════ 7. Legal ═══════ -->
      <p class="mb-5 text-xs leading-relaxed text-green-700">
        Animal Crossing: New Horizons and all related assets are © Nintendo.
        This app is not affiliated with or endorsed by Nintendo.
      </p>
    </div>
  </div>
{/if}
