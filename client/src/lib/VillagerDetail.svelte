<script lang="ts">
  import { onDestroy } from 'svelte';
  import { getRefDbState } from './refdb.svelte';
  import { villagerByName, villagerImage, type VillagerRow } from './villagers';
  import { route, navigate } from './router';

  const refdb = getRefDbState();

  const name = $derived(route.params.name ?? '');
  let villager: VillagerRow | null = $state(null);
  let imgUrl: string | null = $state(null);
  // Non-reactive: revoking/creating inside the effect must not re-trigger it.
  let createdUrl: string | null = null;

  function goBack() {
    if (window.history.length > 1) void navigate(-1);
    else void navigate('/');
  }

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

  onDestroy(() => {
    if (createdUrl) URL.revokeObjectURL(createdUrl);
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
