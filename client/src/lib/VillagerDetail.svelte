<script lang="ts">
  import { getRefDbState } from './refdb.svelte';
  import { villagerByName, villagerImageUrl, slugify, type VillagerRow } from './villagers';
  import {
    giftIdeasByGroup,
    giftImageUrls,
    houseItems,
    houseItemsDetailed,
    houseImageUrls,
    housePhotoUrls,
    type GiftGroup,
    type GiftIdea,
    type HouseItemDetail,
  } from './gifts';
  import {
    getProgressState,
    giftedItems,
    toggleGifted,
    toggleFavorite,
    toggleOnIsland,
    allVillagerFlags,
    type VillagerFlags,
  } from './progress.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { route, navigate } from './router';
  import { createDebouncedQuery } from './search.svelte';

  const refdb = getRefDbState();
  const progress = getProgressState();

  const name = $derived(route.params.name ?? '');
  let villager: VillagerRow | null = $state(null);

  // Same flags the search-page pills read — the header buttons below mirror
  // those exactly (look + behavior), just for this one villager.
  const flags = $derived.by(() => {
    if (!progress.db) return new Map<string, VillagerFlags>();
    void progress.version;
    return allVillagerFlags();
  });
  let imgUrl: string | null = $state(null);
  let groups: GiftGroup[] = $state([]);
  let house = $state<Map<string, HouseItemDetail>>(new Map());
  let houseImgs = $state(new Map<string, string>());
  let housePhotosData = $state({ interior: null as string | null, exterior: null as string | null });
  let showAll = $state<Record<string, boolean>>({});
  let groupImages = $state(new Map<string, Map<string, string>>());

  const VISIBLE = 20;

  function goBack() {
    if (window.history.length > 1) void navigate(-1);
    else void navigate('/');
  }

  // Free-text search replaces the old category pills: matches name, variation
  // and category, same feel as the villager search page. Same asymmetric
  // debounce + 2-char minimum as the main list.
  const giftSearch = createDebouncedQuery(2);
  const giftQ = $derived(slugify(giftSearch.applied.trim()));
  /** Precomputed per-item haystacks — built once when the villager loads,
   //  so keystrokes only run string.includes, never slugify-per-item. */
  let groupIndex = $state(new Map<string, { idea: GiftIdea; hay: string }[]>());

  // Filtered items per group, computed ONCE per query change. The template
  // used to call searchItems() up to three times per group per render —
  // redundant work that WebKit amplified into visible jank while typing.
  const searchedGroups = $derived.by(() => {
    if (!giftQ) return groups.map((group) => ({ group, items: group.items }));
    return groups.map((group) => {
      const idx = groupIndex.get(group.key);
      const items = !idx
        ? group.items
        : idx.filter((e) => e.hay.includes(giftQ)).map((e) => e.idea);
      return { group, items };
    });
  });

  function visibleItems(items: GiftIdea[], groupKey: string): GiftIdea[] {
    return showAll[groupKey] ? items : items.slice(0, VISIBLE);
  }

  function thumbFor(groupKey: string, idea: GiftIdea): string | null {
    const byName = groupImages.get(groupKey);
    if (!byName) return null;
    const key = `${idea.name}\u0000${idea.variation}`;
    return byName.get(key) ?? byName.get(`${idea.name}\u0000`) ?? null;
  }

  const fmt = (n: number) => n.toLocaleString();

  function houseImgUrl(name: string): string | null {
    return houseImgs.get(name) ?? null;
  }

  function housePhotoUrl(kind: 'interior' | 'exterior'): string | null {
    return housePhotosData[kind];
  }

  // Gift log state for this villager (reads progress.version so toggles re-render).
  const gifted = $derived.by(() => {
    if (!villager || !progress.db) return new Set<string>();
    void progress.version;
    return giftedItems(villager.name);
  });

  // Load the villager row + icon once the reference db is ready.
  $effect(() => {
    if (!name) return;
    const db = refdb.db;
    if (!db) return;
    villager = villagerByName(db, name);
    imgUrl = villagerImageUrl(db, name);
  });

  // Reads villager, writes only groups/house (no self-loop).
  $effect(() => {
    if (!villager) return;
    const db = refdb.db;
    if (!db) return;
    const nextGroups = giftIdeasByGroup(db, villager);
    groups = nextGroups;
    groupIndex = new Map(
      nextGroups.map((g) => [
        g.key,
        g.items.map((i) => ({ idea: i, hay: slugify(`${i.name} ${i.variation} ${i.category}`) })),
      ]),
    );
    const names = houseItems(villager, 999);
    house = houseItemsDetailed(db, villager.name, names);
    houseImgs = houseImageUrls(db, villager.name, names);
    housePhotosData = housePhotoUrls(db, villager.name);
  });

  // Load thumbnails for the currently visible items per group (reads filter
  // state; writes only the groupImages map — no self-loop).
  $effect(() => {
    if (!searchedGroups.length) return;
    const db = refdb.db;
    if (!db) return;
    const next = new Map<string, Map<string, string>>();
    for (const { group, items } of searchedGroups) {
      const names = [...new Set(visibleItems(items, group.key).map((i) => i.name))];
      next.set(group.key, giftImageUrls(db, group, names));
    }
    groupImages = next;
  });

  const likes = $derived.by(() => {
    if (!villager) return [];
    const out: { label: string; value: string }[] = [];
    const colors = [villager.color_1, villager.color_2].filter(Boolean);
    if (colors.length) out.push({ label: 'Favorite colors', value: colors.join(' & ') });
    const styles = [villager.style_1, villager.style_2].filter(Boolean);
    if (styles.length) out.push({ label: 'Favorite styles', value: styles.join(' & ') });
    if (villager.favorite_song) out.push({ label: 'Favorite song', value: villager.favorite_song });
    if (villager.favorite_saying) out.push({ label: 'Favorite saying', value: villager.favorite_saying });
    return out;
  });


</script>

<div class="min-h-screen bg-green-50">
  <header class="sticky top-0 z-10 flex items-center gap-2 border-b border-green-200 bg-white/95 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
    <button
      onclick={goBack}
      class="rounded-lg border border-green-300 bg-white px-3 py-1.5 text-sm text-green-800 hover:bg-green-100"
    >
      ← Back
    </button>
    <ConnectionStatus />
    <h1 class="min-w-0 flex-1 truncate text-xl font-bold text-green-800">{name}</h1>
    {#if villager}
      {@const fav = flags.get(villager.name)?.favorite ?? false}
      {@const island = flags.get(villager.name)?.onIsland ?? false}
      <button
        aria-label={`Toggle favorite for ${villager.name}`}
        aria-pressed={fav}
        title={fav ? 'Unfavorite' : 'Favorite'}
        onclick={() => toggleFavorite(villager!.name)}
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-bold transition-colors {fav
          ? 'border-amber-400 bg-amber-400 text-white'
          : 'border-green-300 text-amber-500 hover:bg-green-100'}"
      >
        ★
      </button>
      <button
        aria-label={`Toggle on-island for ${villager.name}`}
        aria-pressed={island}
        title={island ? 'Not on my island' : 'On my island'}
        onclick={() => toggleOnIsland(villager!.name)}
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-bold transition-colors {island
          ? 'border-green-700 bg-green-700 text-white'
          : 'border-green-300 text-green-600 hover:bg-green-100'}"
      >
        ✓
      </button>
    {/if}
  </header>

  <main class="mx-auto max-w-2xl space-y-3 p-3">
    {#if refdb.status !== 'ready'}
      <p class="py-10 text-center text-green-700">Loading…</p>
    {:else if !villager}
      <p class="py-10 text-center text-green-700">Villager not found.</p>
    {:else}
      <!-- Compact hero: the old p-5 + 96px avatar pushed every card below the
           fold, forcing a scroll before any real content. -->
      <section class="flex items-center gap-3 rounded-xl border border-green-200 bg-white p-3">
        {#if imgUrl}
          <img src={imgUrl} alt={name} class="h-16 w-16 rounded-full object-cover" />
        {:else}
          <span class="flex h-16 w-16 items-center justify-center rounded-full bg-green-600 text-xl font-bold text-white">
            {name.charAt(0).toUpperCase()}
          </span>
        {/if}
        <div class="min-w-0">
          <p class="text-lg font-bold text-green-900">{villager.name}</p>
          <p class="truncate text-sm text-green-700">
            {villager.species}{villager.gender ? ` · ${villager.gender.toLowerCase()}` : ''} ·
            {villager.personality}{villager.hobby ? ` · ${villager.hobby}` : ''}
          </p>
        </div>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5">
        <h2 class="mb-3 font-semibold text-green-900">About</h2>
        <dl class="space-y-2">
          {#if villager.birthday}
            <div class="flex items-baseline justify-between gap-4">
              <dt class="text-sm text-green-700">Birthday</dt>
              <dd class="font-medium text-green-900">{villager.birthday}</dd>
            </div>
          {/if}
          {#if villager.catchphrase}
            <div class="flex items-baseline justify-between gap-4">
              <dt class="text-sm text-green-700">Catchphrase</dt>
              <dd class="font-medium text-green-900">“{villager.catchphrase}”</dd>
            </div>
          {/if}
        </dl>
      </section>

      {#if likes.length}
        <section class="rounded-xl border border-green-200 bg-white p-5">
          <h2 class="mb-3 font-semibold text-green-900">Likes</h2>
          <dl class="space-y-2">
            {#each likes as like}
              <div class="flex items-baseline justify-between gap-4">
                <dt class="text-sm text-green-700">{like.label}</dt>
                <dd class="font-medium text-green-900">{like.value}</dd>
              </div>
            {/each}
          </dl>
        </section>
      {/if}

      <section class="rounded-xl border border-green-200 bg-white p-5">
        <h2 class="mb-1 font-semibold text-green-900">Gift ideas</h2>
        <p class="mb-3 text-xs text-green-700">
          Matched against their favorite colors &amp; styles.
        </p>
        <input
          bind:value={giftSearch.raw}
          type="search"
          placeholder="Search gifts by name…"
          class="mb-3 w-full rounded-lg border border-green-300 px-3 py-2.5 text-[17px] text-green-900 placeholder-green-400 focus:border-green-600 focus:outline-none focus:ring-2 focus:ring-green-200"
        />
        {#if groups.length === 0}
          <p class="text-sm text-green-700">No matches found.</p>
        {:else}
          {#snippet groupDetails(group: GiftGroup, items: GiftIdea[])}
            <details class="group rounded-xl border border-green-200">
              <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                <span class="flex items-baseline gap-2">
                  <span class="font-semibold text-green-900">{group.label}</span>
                  <span class="text-xs text-green-600">
                    {fmt(group.perfect)}
                  </span>
                </span>
                <span class="text-green-400 transition-transform group-open:rotate-90">›</span>
              </summary>

              {#if items.length > 0}
                <ul class="divide-y divide-green-100 border-t border-green-100">
                {#each visibleItems(items, group.key) as idea}
                  {@const isGifted = gifted.has(idea.name)}
                  <li class="flex items-start gap-3 px-4 py-2.5 transition-opacity {isGifted ? 'opacity-60' : ''}">
                    {#if thumbFor(group.key, idea)}
                      <img
                        src={thumbFor(group.key, idea)!}
                        alt={idea.name}
                        class="h-12 w-12 shrink-0 rounded-lg object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    {:else}
                      <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-green-100 text-green-600">
                        {idea.name.charAt(0).toUpperCase()}
                      </span>
                    {/if}
                    <div class="min-w-0 flex-1">
                      <div class="flex items-baseline justify-between gap-3">
                        <p class="font-medium text-green-900">
                          {idea.name}{idea.variation ? ` (${idea.variation})` : ''}
                        </p>
                        <span class="shrink-0 text-xs text-green-600">{idea.category}</span>
                      </div>
                      <div class="mt-1 flex flex-wrap gap-1">
                        {#each idea.colorMatch as c}
                          <span class="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">
                            ♥ {c}
                          </span>
                        {/each}
                        {#each idea.styleMatch as s}
                          <span class="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">
                            style: {s}
                          </span>
                        {/each}
                      </div>
                      {#if idea.labelThemes}
                        <p class="mt-1 text-xs text-green-500">Themes: {idea.labelThemes}</p>
                      {/if}
                      {#if idea.source}
                        <p class="mt-1 text-xs text-green-600">Buy: {idea.source}</p>
                      {/if}
                    </div>
                    <button
                      aria-label={isGifted ? 'Already gifted — undo' : 'Mark as gifted'}
                      title={isGifted ? 'Already gifted — undo' : 'Mark as gifted'}
                      onclick={() => toggleGifted(villager!.name, idea.name)}
                      class="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-bold transition-colors {isGifted
                        ? 'border-green-700 bg-green-700 text-white'
                        : 'border-green-300 text-green-600 hover:bg-green-100'}"
                    >
                      ✓
                    </button>
                  </li>
                {/each}
                </ul>

                {#if !showAll[group.key] && items.length > VISIBLE}
                  <button
                    class="w-full border-t border-green-100 px-4 py-2.5 text-sm font-medium text-green-700 hover:bg-green-50"
                    onclick={() => (showAll[group.key] = true)}
                  >
                    Show all {fmt(items.length - VISIBLE)} more
                  </button>
                {/if}
              {/if}
            </details>
          {/snippet}

          <div class="space-y-2">
            {#each searchedGroups as { group, items }}
              {@render groupDetails(group, items)}
            {/each}
          </div>
        {/if}
      </section>

      {#if house.size > 0}
        <section class="rounded-xl border border-green-200 bg-white p-5">
          <h2 class="mb-3 font-semibold text-green-900">Their house</h2>
          {#if housePhotoUrl('interior')}
            <img
              src={housePhotoUrl('interior')!}
              alt="Inside {villager.name}'s house"
              class="mb-3 w-full rounded-lg object-cover"
              loading="lazy"
            />
          {/if}
          {#if housePhotoUrl('exterior')}
            <img
              src={housePhotoUrl('exterior')!}
              alt="Outside {villager.name}'s house"
              class="mb-3 w-full rounded-lg object-cover"
              loading="lazy"
            />
          {/if}
          <details class="group mt-3 rounded-xl border border-green-200">
            <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
              <span class="flex items-baseline gap-2">
                <span class="font-semibold text-green-900">House furniture</span>
                <span class="text-xs text-green-600">{house.size}</span>
              </span>
              <span class="text-green-400 transition-transform group-open:rotate-90">›</span>
            </summary>
            <ul class="divide-y divide-green-100 border-t border-green-100">
              {#each [...house.values()] as item (item.name)}
                {@const img = houseImgUrl(item.name)}
                <li class="flex items-start gap-3 px-4 py-2.5">
                  {#if img}
                    <img
                      src={img}
                      alt={item.name}
                      class="h-12 w-12 shrink-0 rounded-lg object-cover"
                      loading="lazy"
                    />
                  {:else}
                    <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-green-100 text-green-600">
                      {item.name.charAt(0).toUpperCase()}
                    </span>
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="font-medium text-green-900">{item.name}</p>
                    {#if item.category}
                      <p class="text-xs text-green-600">{item.category}</p>
                    {/if}
                  </div>
                  {#if item.colors.length > 0}
                    <div class="flex shrink-0 flex-wrap justify-end gap-1">
                      {#each item.colors as c}
                        <span class="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">♥ {c}</span>
                      {/each}
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          </details>
        </section>
      {/if}

      <p class="px-2 pb-6 text-center text-xs text-green-600">
        Favorites are coming in the next step.
      </p>
    {/if}
  </main>
</div>
