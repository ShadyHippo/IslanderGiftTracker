<script lang="ts">
  import { navigate } from './router';
</script>

<div class="min-h-screen bg-green-50">
  <header class="sticky top-0 z-10 border-b border-green-200 bg-white/95 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur">
    <button
      onclick={() => void navigate('/')}
      class="rounded-lg border border-green-300 bg-white px-3 py-1.5 text-sm text-green-800 hover:bg-green-100"
    >
      ← Back
    </button>
  </header>

  <main class="mx-auto max-w-2xl space-y-6 p-4 pb-16">
    <h1 class="text-2xl font-bold text-green-800">Privacy policy</h1>
    <p class="text-xs text-green-600">Last updated: August 2026</p>

    <section class="rounded-xl border border-green-200 bg-white p-5">
      <h2 class="mb-2 font-semibold text-green-900">What we store</h2>
      <ul class="list-disc space-y-1 pl-5 text-sm leading-relaxed text-green-700">
        <li>Your <strong>account</strong>: a name plus either a password hash (never stored in readable form) or your Google account identity — an opaque ID and your email address, depending on how this instance is set up.</li>
        <li>Your <strong>gift log and villager flags</strong> (favorites, on-island) — this is the data you create.</li>
        <li>Recent backups of that data on the server</li>
      </ul>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5">
      <h2 class="mb-2 font-semibold text-green-900">What we don't do</h2>
      <ul class="list-disc space-y-1 pl-5 text-sm leading-relaxed text-green-700">
        <li>No analytics, ads, or third-party trackers of any kind.</li>
        <li>No selling or sharing of data — there is no one to sell it to.</li>
        <li>No cookies beyond the single session cookie that keeps you logged in.</li>
      </ul>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5">
      <h2 class="mb-2 font-semibold text-green-900">On your device</h2>
      <p class="text-sm leading-relaxed text-green-700">
        To work offline, the app stores its reference data, images, and your
        gift log in your browser's local storage (IndexedDB / Cache Storage).
        This stays on your device. Clearing the site's data in your browser
        removes it; anything already synced is still safe on the server.
      </p>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5">
      <h2 class="mb-2 font-semibold text-green-900">Deleting your data</h2>
      <p class="text-sm leading-relaxed text-green-700">
        You can download a copy of your gift log anytime from
        <strong>About → Download my data</strong>. To delete everything —
        account, gift log, and all server backups — use
        <strong>About → Delete my account</strong>; it takes effect immediately
        and needs no one's approval. If something goes wrong,
        <a
          href="https://github.com/ShadyHippo/IslanderGiftTracker/issues"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-green-700 underline decoration-dotted hover:text-green-900"
        >the project's issue tracker</a>
        is there as a fallback.
      </p>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5">
      <h2 class="mb-2 font-semibold text-green-900">Fan project</h2>
      <p class="text-sm leading-relaxed text-green-700">
        This is a non-commercial fan project. Animal Crossing: New Horizons and
        all related assets are © Nintendo. This app is not affiliated with or
        endorsed by Nintendo.
      </p>
    </section>

    <p class="text-center text-sm text-green-700">
      Also read the
      <a
        href="/tos"
        class="font-medium text-green-700 underline decoration-dotted hover:text-green-900"
      >Terms of Service</a>.
    </p>
  </main>
</div>
