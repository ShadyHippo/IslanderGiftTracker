<script lang="ts">
  import { getRefDbState, loadReferenceDb } from './refdb.svelte';
  import { allVillagers, slugify, villagerImageUrls, type Villager } from './villagers';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import {
    getProgressState,
    allVillagerFlags,
    toggleFavorite,
    toggleOnIsland,
    type VillagerFlags,
  } from './progress.svelte';
  import { logout } from './session.svelte';
  import { openAbout } from './about.svelte';
  import { p } from './router';
  import { createDebouncedQuery } from './search.svelte';
  import { getNet } from './net.svelte';

  const refdb = getRefDbState();
  const progress = getProgressState();
  const net = getNet();

  // Asymmetric debounce: typing applies instantly, backspacing settles after
  // a short idle so the list doesn't regrow on every deleted character.
  const search = createDebouncedQuery(2);

  let villagers: Villager[] = $state([]);
  let images = $state(new Map<string, string>());
  /** Precomputed search haystack per villager — built once, not per keystroke. */
  let searchIndex = $state<{ v: Villager; hay: string }[]>([]);
  let showFavorites = $state(false);
  let showIsland = $state(false);
  let loggingOut = $state(false);

  $effect(() => {
    const db = refdb.db;
    if (db) {
      // Build from a LOCAL: reading the `villagers` state here would make
      // this effect depend on its own write and loop forever.
      const rows = allVillagers(db);
      villagers = rows;
      images = villagerImageUrls(db);
      searchIndex = rows.map((v) => ({
        v,
        hay: `${slugify(v.name)} ${slugify(v.species)} ${slugify(v.personality)} ${slugify(v.hobby)}`,
      }));
    }
  });

  const flags = $derived.by(() => {
    if (!progress.db) return new Map<string, VillagerFlags>();
    void progress.version;
    return allVillagerFlags();
  });



  const filtered = $derived.by(() => {
    let list = searchIndex;
    if (search.active) {
      const q = slugify(search.applied.trim());
      if (q) list = list.filter((e) => e.hay.includes(q));
    }
    if (showFavorites) list = list.filter((e) => flags.get(e.v.name)?.favorite);
    if (showIsland) list = list.filter((e) => flags.get(e.v.name)?.onIsland);
    return list.map((e) => e.v);
  });

  function imgFor(name: string): string | null {
    return images.get(name) ?? null;
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

  // Filters are mutually exclusive: selecting one clears the other.
  function toggleFavorites() {
    showFavorites = !showFavorites;
    if (showFavorites) showIsland = false;
  }

  function toggleIsland() {
    showIsland = !showIsland;
    if (showIsland) showFavorites = false;
  }
</script>

<div class="flex min-h-screen flex-col bg-green-50">
  <header class="sticky top-0 z-10 border-b border-green-200 bg-white/95 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur">
    <div class="mb-3 flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2">
        <ConnectionStatus />
        <h1 class="text-xl font-bold text-green-800">Villagers</h1>
      </div>
      <button
        onclick={onLogout}
        disabled={loggingOut || (!net.online && progress.dirty)}
        title={!net.online && progress.dirty
          ? "You have unsaved changes that haven't synced yet — they'll upload when you're back online."
          : undefined}
        class="rounded-lg border border-green-300 bg-white px-3 py-1.5 text-sm text-green-800 hover:bg-green-100 disabled:opacity-60"
      >
        {loggingOut ? 'Signing out…' : !net.online && progress.dirty ? 'Unsaved…' : 'Sign out'}
      </button>
    </div>
    <input
      bind:value={search.raw}
      type="search"
      placeholder="Search by name, species, personality…"
      class="w-full rounded-lg border border-green-300 px-3 py-2.5 text-[17px] text-green-900 placeholder-green-400 focus:border-green-600 focus:outline-none focus:ring-2 focus:ring-green-200"
    />
    {#if refdb.status === 'ready'}
      <div class="mt-2 flex gap-2">
        <button
          aria-pressed={showFavorites}
          onclick={toggleFavorites}
          class="rounded-full border px-3 py-1.5 text-sm transition-colors {showFavorites
            ? 'border-amber-400 bg-amber-100 text-amber-800'
            : 'border-green-300 bg-white text-green-700 hover:bg-green-100'}"
        >
          ★ Favorites
        </button>
        <button
          aria-pressed={showIsland}
          onclick={toggleIsland}
          class="rounded-full border px-3 py-1.5 text-sm transition-colors {showIsland
            ? 'border-green-700 bg-green-700 text-white'
            : 'border-green-300 bg-white text-green-700 hover:bg-green-100'}"
        >
          ✓ On my island
        </button>
        <button
          type="button"
          onclick={openAbout}
          class="ml-auto self-center rounded-lg border border-green-300 bg-white px-3 py-1.5 text-sm font-semibold text-green-800 transition-colors hover:bg-green-100 focus:outline-none focus:ring-2 focus:ring-green-200"
        >
          About
        </button>
      </div>
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
    {:else if refdb.status === 'checking'}
      <!-- silent: the boot spinner (App.svelte) covers this window -->
      <p class="py-10 text-center text-green-700">Loading…</p>
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
        <p class="py-10 text-center text-green-700">No villagers match “{search.raw}”.</p>
      {:else}
        <ul class="mx-auto max-w-2xl divide-y divide-green-200 overflow-hidden rounded-xl border border-green-200 bg-white">
          {#each filtered as v (v.name)}
            {@const fav = flags.get(v.name)?.favorite ?? false}
            {@const island = flags.get(v.name)?.onIsland ?? false}
            <!-- content-visibility lets the browser skip off-screen rows, which
                 takes the edge off regrowing the full list when filters turn
                 off or characters get deleted -->
            <li class="flex items-center gap-2 px-4 py-3 [content-visibility:auto] [contain-intrinsic-size:auto_72px] hover:bg-green-50">
              <a
                href={p('/villager/:name', { params: { name: slugify(v.name) } })}
                class="flex min-w-0 flex-1 items-center gap-3"
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
              <button
                aria-label={`Toggle favorite for ${v.name}`}
                aria-pressed={fav}
                title={fav ? 'Unfavorite' : 'Favorite'}
                onclick={() => toggleFavorite(v.name)}
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-bold transition-colors {fav
                  ? 'border-amber-400 bg-amber-400 text-white'
                  : 'border-green-300 text-amber-500 hover:bg-green-100'}"
              >
                ★
              </button>
              <button
                aria-label={`Toggle on-island for ${v.name}`}
                aria-pressed={island}
                title={island ? 'Not on my island' : 'On my island'}
                onclick={() => toggleOnIsland(v.name)}
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-bold transition-colors {island
                  ? 'border-green-700 bg-green-700 text-white'
                  : 'border-green-300 text-green-600 hover:bg-green-100'}"
              >
                ✓
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </main>
</div>
