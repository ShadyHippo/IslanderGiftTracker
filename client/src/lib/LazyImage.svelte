<script lang="ts">
  import { onMount } from 'svelte';
  import { acquireImage, releaseImage, fetchStoreAcquire } from './imagedb';

  // Lazy image backed by IndexedDB. Renders a placeholder until the image is
  // near the viewport, then resolves bytes from IDB (offline) or the network
  // (online, caching into IDB for next time). Keeps images entirely off the
  // service worker / Cache Storage boot path.
  //
  // The wrapper span always exists (it carries the observer target); sizing +
  // shape classes go on it via `class`. For fixed-size icons (h-12 w-12
  // rounded-full …) the wrapper clips via overflow-hidden and the img fills
  // it; for natural-height content (w-full photos) the img keeps its aspect.

  interface Props {
    path: string | null;
    alt: string;
    /** Sizing + shape classes applied to the wrapper (e.g. "h-12 w-12 rounded-full"). */
    class?: string;
    /** Character shown inside the placeholder before/instead of the image. */
    placeholder?: string;
    /** Placeholder colors (defaults to the green box used across the app). */
    placeholderClass?: string;
  }

  let {
    path,
    alt,
    class: sizeClass = '',
    placeholder = '',
    placeholderClass = 'bg-green-100 text-green-600',
  }: Props = $props();

  let url: string | null = $state(null);
  let el: HTMLSpanElement | null = $state(null);

  async function resolve() {
    if (url || !path) return;
    // 1) IndexedDB hit — offline-friendly, no network.
    const hit = await acquireImage(path);
    if (hit) {
      url = hit;
      return;
    }
    // 2) Online miss — fetch, cache into IDB for next time, show now.
    if (navigator.onLine) {
      const fetched = await fetchStoreAcquire(path);
      if (fetched) url = fetched;
    }
    // 3) Offline + not cached: leave placeholder (url stays null).
  }

  onMount(() => {
    let io: IntersectionObserver | null = null;
    if (path) {
      if (typeof IntersectionObserver === 'undefined' || !el) {
        void resolve();
      } else {
        io = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (e.isIntersecting) {
                io?.disconnect();
                void resolve();
                break;
              }
            }
          },
          { rootMargin: '200px' },
        );
        io.observe(el);
      }
    }
    return () => {
      io?.disconnect();
      if (path && url) releaseImage(path);
    };
  });
</script>

<span bind:this={el} data-path={path ?? undefined} class="inline-flex overflow-hidden {sizeClass}">
  {#if url}
    <img src={url} {alt} class="h-full w-full object-cover" decoding="async" />
  {:else}
    <span class="flex h-full w-full items-center justify-center {placeholderClass}" role="img" aria-label={alt}>
      {placeholder}
    </span>
  {/if}
</span>
