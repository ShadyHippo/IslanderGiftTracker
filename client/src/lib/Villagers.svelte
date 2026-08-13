<script lang="ts">
import { onDestroy } from 'svelte';
  import { getRefDbState, loadReferenceDb } from './refdb.svelte';
  import { allVillagers, villagerImages, type Villager } from './villagers';
import { logout } from './session.svelte';
import { p } from './router';

  const refdb = getRefDbState();

  let villagers: Villager[] = $state([]);
  let images = $state(new Map<string, Uint8Array<ArrayBuffer>>());
  let query = $state('');
  let loggingOut = $state(false);

  const urls = new Map<string, string>();

  $effect(() => {
    const db = refdb.db;
    if (db) {
      villagers = allVillagers(db);
      images = villagerImages(db);
    }
  });

  onDestroy(() => {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  });

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return villagers;
    return villagers.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.species.toLowerCase().includes(q) ||
        v.personality.toLowerCase().includes(q) ||
        v.hobby.toLowerCase().includes(q),
    );
  });

  function imgFor(name: string): string | null {
    const data = images.get(name);
    if (!data) return null;
    let url = urls.get(name);
    if (!url) {
      url = URL.createObjectURL(new Blob([data]));
      urls.set(name, url);
    }
    return url;
  }

  const PALETTE = [
    'bg-green-600',
    'bg-teal-600',
    'bg-sky-600',
    'bg-indigo-600',
    'bg-violet-600',
    'bg-rose-500',
    'bg-amber-500',
    'bg-orange-600',
  ];

  function avatarClass(name: string): string {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  async function onLogout() {
    loggingOut = true;
    await logout();
    loggingOut = false;
  }
</script>

<div class="flex min-h-screen flex-col bg-green-50">
  <header class="sticky top-0 z-10 border-b border-green-200 bg-white/95 px-4 pb-3 pt-4 backdrop-blur">
    <div class="mb-3 flex items-center justify-between gap-2">
      <h1 class="text-xl font-bold text-green-800">Villagers</h1>
      <button
        onclick={onLogout}
        disabled={loggingOut}
        class="rounded-lg border border-green-300 bg-white px-3 py-1.5 text-sm text-green-800 hover:bg-green-100 disabled:opacity-60"
      >
        {loggingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
    <input
      bind:value={query}
      type="search"
      placeholder="Search by name, species, personality…"
      class="w-full rounded-lg border border-green-300 px-3 py-2.5 text-base text-green-900 placeholder-green-400 focus:border-green-600 focus:outline-none focus:ring-2 focus:ring-green-200"
    />
    {#if refdb.status === 'ready'}
      <p class="mt-2 text-xs text-green-700">
        {filtered.length} of {villagers.length} villagers
      </p>
    {/if}
  </header>

  <main class="flex-1 p-4">
    {#if refdb.status === 'downloading'}
      <div class="mx-auto max-w-sm rounded-xl border border-green-200 bg-white p-6 text-center">
        <p class="mb-3 text-green-800">Downloading reference data… {refdb.progress}%</p>
        <div class="h-2 w-full overflow-hidden rounded-full bg-green-100">
          <div
            class="h-full rounded-full bg-green-600 transition-all"
            style="width: {refdb.progress}%"
          ></div>
        </div>
      </div>
    {:else if refdb.status === 'initializing'}
      <div class="mx-auto max-w-sm rounded-xl border border-green-200 bg-white p-6 text-center">
        <p class="text-green-800">Loading villagers…</p>
      </div>
    {:else if refdb.status === 'error'}
      <div class="mx-auto max-w-sm rounded-xl border border-red-200 bg-white p-6 text-center">
        <p class="mb-3 text-red-700">{refdb.error}</p>
        <button
          onclick={() => void loadReferenceDb()}
          class="rounded-lg bg-green-700 px-4 py-2 font-semibold text-white hover:bg-green-800"
        >
          Retry
        </button>
      </div>
    {:else if refdb.status === 'ready'}
      {#if filtered.length === 0}
        <p class="py-10 text-center text-green-700">No villagers match “{query}”.</p>
      {:else}
        <ul class="mx-auto max-w-2xl divide-y divide-green-200 overflow-hidden rounded-xl border border-green-200 bg-white">
          {#each filtered as v (v.name)}
            <li>
              <a
                href={p('/villager/:name', { params: { name: v.name } })}
                class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-green-50"
              >
                {#if imgFor(v.name)}
                  <img
                    src={imgFor(v.name)!}
                    alt={v.name}
                    class="h-12 w-12 shrink-0 rounded-full object-cover"
                    loading="lazy"
                  />
                {:else}
                  <span
                    class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-bold text-white {avatarClass(v.name)}"
                  >
                    {v.name.charAt(0).toUpperCase()}
                  </span>
                {/if}
                <div class="min-w-0 flex-1">
                  <p class="truncate font-semibold text-green-900">{v.name}</p>
                  <p class="truncate text-sm text-green-700">
                    {v.species} · {v.personality}{v.hobby ? ` · ${v.hobby}` : ''}
                  </p>
                </div>
                <span class="text-green-400">›</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </main>
</div>
