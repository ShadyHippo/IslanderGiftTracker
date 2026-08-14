<script lang="ts">
  import { onDestroy } from 'svelte';
  import { getRefDbState } from './refdb.svelte';
  import { villagerByName, villagerImage, type VillagerRow } from './villagers';
  import { giftIdeasByGroup, giftImagesForGroup, houseItems, typeTree, type GiftGroup, type GiftIdea } from './gifts';
  import TypePills from './TypePills.svelte';
  import { route, navigate } from './router';

  const refdb = getRefDbState();

  const name = $derived(route.params.name ?? '');
  let villager: VillagerRow | null = $state(null);
  let imgUrl: string | null = $state(null);
  let groups: GiftGroup[] = $state([]);
  let house: string[] = $state([]);
  interface GroupFilter {
    types: string[];
    buyable: boolean;
  }
  const NO_FILTER: GroupFilter = { types: [], buyable: false };
  let groupFilters = $state<Record<string, GroupFilter>>({});
  let showAll = $state<Record<string, boolean>>({});
  let groupImages = $state(new Map<string, Map<string, Uint8Array<ArrayBuffer>>>());
  // Non-reactive: revoking/creating inside the effect must not re-trigger it.
  let createdUrl: string | null = null;
  const urlCache = new Map<string, string>();

  const VISIBLE = 20;

  function goBack() {
    if (window.history.length > 1) void navigate(-1);
    else void navigate('/');
  }

  function toggleType(groupKey: string, typePath: string) {
    const f = groupFilters[groupKey] ?? { ...NO_FILTER };
    const set = new Set(f.types);
    if (set.has(typePath)) set.delete(typePath);
    else set.add(typePath);
    groupFilters[groupKey] = { ...f, types: [...set] };
  }

  function toggleBuyable(groupKey: string) {
    const f = groupFilters[groupKey] ?? { ...NO_FILTER };
    groupFilters[groupKey] = { ...f, buyable: !f.buyable };
  }

  function clearFilters(groupKey: string) {
    groupFilters[groupKey] = { ...NO_FILTER };
  }

  // Type pills are OR (Kitchen + Appliance = both subtrees); buyable is AND.
  // Clothing uses its flat categories as the single pill level.
  function filteredItems(group: GiftGroup): GiftIdea[] {
    const f = groupFilters[group.key] ?? NO_FILTER;
    let items = group.items;
    if (f.types.length > 0) {
      items = items.filter((i) => {
        const tp = group.key === 'furniture' ? i.typePath : i.category;
        return f.types.some((t) => tp === t || tp.startsWith(t + '/'));
      });
    }
    if (f.buyable) items = items.filter((i) => i.buyable);
    return items;
  }

  function visibleItems(group: GiftGroup): GiftIdea[] {
    const items = filteredItems(group);
    return showAll[group.key] ? items : items.slice(0, VISIBLE);
  }

  function thumbFor(groupKey: string, idea: GiftIdea): string | null {
    const byName = groupImages.get(groupKey);
    if (!byName) return null;
    const key = `${idea.name}\u0000${idea.variation}`;
    const bytes = byName.get(key) ?? byName.get(`${idea.name}\u0000`);
    if (!bytes) return null;
    const cacheKey = `${groupKey}|${key}`;
    let url = urlCache.get(cacheKey);
    if (!url) {
      url = URL.createObjectURL(new Blob([bytes]));
      urlCache.set(cacheKey, url);
    }
    return url;
  }

  const fmt = (n: number) => n.toLocaleString();

  // Furniture + Clothing are the giftable categories (villagers visibly use
  // them); everything else is nested under "Irrelevant".
  const primaryGroups = $derived(groups.filter((g) => g.key === 'furniture' || g.key === 'clothing'));
  const otherGroups = $derived(groups.filter((g) => g.key !== 'furniture' && g.key !== 'clothing'));
  const otherCount = $derived(otherGroups.reduce((n, g) => n + g.perfect, 0));
  // Category trees for the filter pills: furniture drills the type_path tree,
  // clothing is a flat single level of its categories.
  const groupTrees = $derived(
    new Map(
      groups.map((g) => [
        g.key,
        typeTree(g.items, g.key === 'clothing' ? (i) => i.category : undefined),
      ]),
    ),
  );

  $effect(() => {
    if (!name) return;
    const db = refdb.db;
    if (!db) return;
    villager = villagerByName(db, name);
    const bytes = villagerImage(db, name);
    if (createdUrl) URL.revokeObjectURL(createdUrl);
    createdUrl = bytes ? URL.createObjectURL(new Blob([bytes])) : null;
    imgUrl = createdUrl;
  });

  // Reads villager, writes only groups/house (no self-loop).
  $effect(() => {
    if (!villager) return;
    const db = refdb.db;
    if (!db) return;
    groups = giftIdeasByGroup(db, villager);
    house = houseItems(villager);
  });

  // Load thumbnails for the currently visible items per group (reads filter
  // state; writes only the groupImages map — no self-loop).
  $effect(() => {
    if (!groups.length) return;
    const db = refdb.db;
    if (!db) return;
    const next = new Map<string, Map<string, Uint8Array<ArrayBuffer>>>();
    for (const g of groups) {
      const names = [...new Set(visibleItems(g).map((i) => i.name))];
      next.set(g.key, giftImagesForGroup(db, g, names));
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

  onDestroy(() => {
    for (const url of urlCache.values()) URL.revokeObjectURL(url);
    urlCache.clear();
    if (createdUrl) URL.revokeObjectURL(createdUrl);
  });
</script>

<div class="min-h-screen bg-green-50">
  <header class="sticky top-0 z-10 flex items-center gap-2 border-b border-green-200 bg-white/95 px-4 py-3 backdrop-blur">
    <button
      onclick={goBack}
      class="rounded-lg border border-green-300 bg-white px-3 py-1.5 text-sm text-green-800 hover:bg-green-100"
    >
      ← Back
    </button>
    <h1 class="truncate text-xl font-bold text-green-800">{name}</h1>
  </header>

  <main class="mx-auto max-w-2xl space-y-4 p-4">
    {#if refdb.status !== 'ready'}
      <p class="py-10 text-center text-green-700">Loading…</p>
    {:else if !villager}
      <p class="py-10 text-center text-green-700">Villager not found.</p>
    {:else}
      <section class="flex items-center gap-4 rounded-xl border border-green-200 bg-white p-5">
        {#if imgUrl}
          <img src={imgUrl} alt={name} class="h-24 w-24 rounded-full object-cover" />
        {:else}
          <span class="flex h-24 w-24 items-center justify-center rounded-full bg-green-600 text-3xl font-bold text-white">
            {name.charAt(0).toUpperCase()}
          </span>
        {/if}
        <div>
          <p class="text-2xl font-bold text-green-900">{villager.name}</p>
          <p class="text-green-700">
            {villager.species}{villager.gender ? ` · ${villager.gender.toLowerCase()}` : ''} ·
            {villager.personality}
          </p>
          {#if villager.hobby}
            <p class="text-sm text-green-700">Hobby: {villager.hobby}</p>
          {/if}
        </div>
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

      {#if house.length}
        <section class="rounded-xl border border-green-200 bg-white p-5">
          <h2 class="mb-3 font-semibold text-green-900">Their house</h2>
          <div class="flex flex-wrap gap-1.5">
            {#each house as item}
              <span class="rounded-full bg-green-100 px-2.5 py-1 text-xs text-green-800">
                {item}
              </span>
            {/each}
          </div>
        </section>
      {/if}

      <section class="rounded-xl border border-green-200 bg-white p-5">
        <h2 class="mb-1 font-semibold text-green-900">Gift ideas</h2>
        <p class="mb-3 text-xs text-green-700">
          Matched against their favorite colors &amp; styles.
        </p>
        {#if groups.length === 0}
          <p class="text-sm text-green-700">No matches found.</p>
        {:else}
          {#snippet groupDetails(group: GiftGroup)}
            <details class="group rounded-xl border border-green-200">
              <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                <span class="flex items-baseline gap-2">
                  <span class="font-semibold text-green-900">{group.label}</span>
                  <span class="text-xs text-green-600">
                    {fmt(group.perfect)} perfect
                    {#if group.good}· {fmt(group.good)} more{/if}
                  </span>
                </span>
                <span class="text-green-400 transition-transform group-open:rotate-90">›</span>
              </summary>

              {#if group.key === 'furniture' || group.key === 'clothing'}
                <TypePills
                  tree={groupTrees.get(group.key) ?? []}
                  selected={groupFilters[group.key]?.types ?? []}
                  buyable={groupFilters[group.key]?.buyable ?? false}
                  onToggleType={(p) => toggleType(group.key, p)}
                  onToggleBuyable={() => toggleBuyable(group.key)}
                  onClear={() => clearFilters(group.key)}
                />
              {/if}

              <ul class="divide-y divide-green-100 border-t border-green-100">
                {#each visibleItems(group) as idea}
                  <li class="flex items-start gap-3 px-4 py-2.5">
                    {#if thumbFor(group.key, idea)}
                      <img
                        src={thumbFor(group.key, idea)!}
                        alt={idea.name}
                        class="h-12 w-12 shrink-0 rounded-lg object-cover"
                        loading="lazy"
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
                        {#if idea.tier === 2}
                          <span class="rounded-full bg-green-700 px-2 py-0.5 text-xs font-semibold text-white">
                            ★ Perfect match
                          </span>
                        {/if}
                        {#each idea.colorMatch as c}
                          <span class="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">
                            ♥ {c}
                          </span>
                        {/each}
                        {#each idea.trimMatch as c}
                          <span class="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                            ♥ {c} ({idea.secondaryLabel})
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
                    </div>
                  </li>
                {/each}
              </ul>

              {#if !showAll[group.key] && filteredItems(group).length > VISIBLE}
                <button
                  class="w-full border-t border-green-100 px-4 py-2.5 text-sm font-medium text-green-700 hover:bg-green-50"
                  onclick={() => (showAll[group.key] = true)}
                >
                  Show all {fmt(filteredItems(group).length - VISIBLE)} more
                </button>
              {/if}
            </details>
          {/snippet}

          <div class="space-y-2">
            {#each primaryGroups as group}
              {@render groupDetails(group)}
            {/each}

            {#if otherGroups.length > 0}
              <details class="group rounded-xl border border-green-200">
                <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                  <span class="flex items-baseline gap-2">
                    <span class="font-semibold text-green-900">Irrelevant</span>
                    <span class="text-xs text-green-600">{fmt(otherCount)} perfect</span>
                  </span>
                  <span class="text-green-400 transition-transform group-open:rotate-90">›</span>
                </summary>
                <div class="space-y-2 border-t border-green-100 p-2">
                  {#each otherGroups as group}
                    {@render groupDetails(group)}
                  {/each}
                </div>
              </details>
            {/if}
          </div>
        {/if}
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

      <p class="px-2 pb-6 text-center text-xs text-green-600">
        Gift log &amp; favorites are coming in the next step.
      </p>
    {/if}
  </main>
</div>
