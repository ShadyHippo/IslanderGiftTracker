<script lang="ts">
  import { getAbout, dismissAbout } from './about.svelte';

  const about = getAbout();

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && about.open) dismissAbout();
  }
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
