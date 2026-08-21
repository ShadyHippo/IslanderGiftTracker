<script lang="ts">
  import { getProgressState } from './progress.svelte';

  // Two round status badges replacing the old text pill:
  //  - local:   amber floppy (writing)  → green floppy-check (on device)
  //  - network: amber cloud (pending)   → green cloud-check (server confirmed)
  // Icon AND color change together so state is readable without color.
  const progress = getProgressState();

  const network = $derived(
    progress.saving ? 'syncing' : progress.dirty ? 'pending' : 'synced',
  );
</script>

{#snippet floppyCheck()}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M7 3v4a1 1 0 0 0 1 1h7" />
    <path d="m9 17 2 2 4-4" />
  </svg>
{/snippet}

{#snippet floppy()}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
    <path d="M7 3v4a1 1 0 0 0 1 1h7" />
  </svg>
{/snippet}

{#snippet cloudCheck()}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    <path d="m9.5 14 2 2 3.5-3.5" />
  </svg>
{/snippet}

{#snippet cloud()}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
  </svg>
{/snippet}

{#snippet spinner()}
  <span class="h-4 w-4 animate-spin rounded-full border-2 border-amber-800/30 border-t-amber-800"></span>
{/snippet}

<div class="fixed bottom-4 right-4 z-50 flex items-center gap-2" style="padding-bottom: env(safe-area-inset-bottom, 0px)">
  {#if progress.error}
    <span class="rounded-lg bg-red-100 px-3 py-1 text-xs font-medium text-red-700">{progress.error}</span>
  {/if}
  <span
    data-save-local={progress.localSaved ? 'saved' : 'writing'}
    title={progress.localSaved ? 'Saved on this device' : 'Saving to this device…'}
    aria-label={progress.localSaved ? 'Saved on this device' : 'Saving to this device'}
    class="flex h-9 w-9 items-center justify-center rounded-full shadow-lg {progress.localSaved
      ? 'bg-green-100 text-green-600'
      : 'bg-amber-100 text-amber-800'}"
  >
    {#if progress.localSaved}
      {@render floppyCheck()}
    {:else}
      {@render floppy()}
    {/if}
  </span>
  <span
    data-save-network={network}
    title={network === 'synced'
      ? 'Synced to server'
      : network === 'syncing'
        ? 'Syncing…'
        : 'Waiting to sync (offline or unsaved)'}
    aria-label={network === 'synced' ? 'Synced to server' : network === 'syncing' ? 'Syncing changes' : 'Waiting to sync'}
    class="flex h-9 w-9 items-center justify-center rounded-full shadow-lg {network === 'synced'
      ? 'bg-green-100 text-green-600'
      : 'bg-amber-100 text-amber-800'}"
  >
    {#if network === 'synced'}
      {@render cloudCheck()}
    {:else if network === 'syncing'}
      {@render spinner()}
    {:else}
      {@render cloud()}
    {/if}
  </span>
</div>
