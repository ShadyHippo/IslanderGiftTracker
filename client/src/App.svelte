<script lang="ts">
  import { onMount } from 'svelte';
  import { Router } from 'sv-router';
  import { getSession, checkSession } from './lib/session.svelte';
  import { getRefDbState, loadReferenceDb } from './lib/refdb.svelte';
  import { getProgressState, loadProgress, flushProgressOnUnload, saveProgress } from './lib/progress.svelte';
  import Login from './lib/Login.svelte';
  import './lib/router';

  const session = getSession();
  const refdb = getRefDbState();
  const progress = getProgressState();

  // Build marker so the user can confirm which deploy is running.
  const BUILD_HASH: string =
    typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev';
  const BUILD_TIME: string =
    typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';

  onMount(() => {
    void checkSession();
  });

  // The reference db is app-level state: load it as soon as we're logged in,
  // regardless of which route we land on (deep links included).
  $effect(() => {
    if (session.user && refdb.status === 'idle') {
      void loadReferenceDb();
    }
  });

  // Same for the user's progress db (gift log) — a tiny second sqlite file.
  $effect(() => {
    if (session.user && progress.status === 'idle') {
      void loadProgress();
    }
  });

  // Flush any pending changes when the tab closes; the 1.5s debounce covers
  // the normal case, this covers closing the tab mid-edit.
  $effect(() => {
    const handler = () => flushProgressOnUnload();
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  });

  // Retry save when the browser comes back online
  $effect(() => {
    const onOnline = () => {
      if (progress.dirty && !progress.saving) {
        void saveProgress();
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  });
</script>

{#if session.checking}
  <div class="flex min-h-screen items-center justify-center bg-green-50">
    <p class="text-green-700">Loading…</p>
  </div>
{:else if !session.user}
  <Login />
{:else}
  <Router />

  {#if progress.status === 'ready'}
    <div class="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-1" style="padding-bottom: env(safe-area-inset-bottom, 0px)">
      {#if progress.error}
        <p class="rounded-lg bg-red-100 px-3 py-1 text-xs font-medium text-red-700">{progress.error}</p>
      {/if}
      <p
        data-save-status
        class="rounded-full px-4 py-2 text-sm font-semibold shadow-lg {progress.dirty
          ? 'bg-amber-100 text-amber-800'
          : 'bg-green-100 text-green-600'}"
      >
        {#if progress.saving}
          Saving…
        {:else if progress.dirty}
          Unsaved changes
        {:else if progress.savedAt}
          Saved {progress.savedAt}
        {:else}
          Saved
        {/if}
      </p>
    </div>
  {/if}
  <p class="pointer-events-none fixed bottom-1 left-2 z-50 select-text text-[10px] leading-none text-green-800/40" style="padding-bottom: env(safe-area-inset-bottom, 0px)">
    {BUILD_HASH}{BUILD_TIME ? ` · ${BUILD_TIME}` : ''}
  </p>
{/if}
