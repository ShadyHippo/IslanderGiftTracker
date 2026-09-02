<script lang="ts">
  import { navigate } from './router';
</script>

<div class="min-h-screen bg-green-50 dark:bg-green-950">
  <header class="sticky top-0 z-10 border-b border-green-200 bg-white/95 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur dark:border-green-800 dark:bg-green-900/95">
    <button
      onclick={() => void navigate('/')}
      class="rounded-lg border border-green-300 bg-white px-3 py-1.5 text-sm text-green-800 hover:bg-green-100 dark:border-green-700 dark:bg-green-900 dark:text-green-100 dark:hover:bg-green-800"
    >
      ← Back
    </button>
  </header>

  <main class="mx-auto max-w-2xl space-y-6 p-4 pb-16">
    <h1 class="text-2xl font-bold text-green-800 dark:text-green-100">Terms of Service</h1>
    <p class="text-xs text-green-600 dark:text-green-400">Last updated: August 2026</p>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-900">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">The short version</h2>
      <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
        This is a free, hobby-run fan tool for tracking Animal Crossing gift
        ideas. Use it kindly, don't try to break it, and don't expect
        commercial-grade guarantees. Your gift log is yours; delete it anytime.
      </p>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-900">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">1. The service</h2>
      <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
        Islander Gift Tracker matches furniture and clothing items to Animal
        Crossing: New Horizons villagers and lets you keep a personal gift log.
        It is provided as-is, free of charge, with no guarantee of
        availability, accuracy, or fitness for any purpose. Game data is
        compiled from community sources and may contain errors.
      </p>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-900">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">2. Accounts</h2>
      <ul class="list-disc space-y-1 pl-5 text-sm leading-relaxed text-green-700 dark:text-green-300">
        <li>Depending on how this instance is configured, you sign in with a username/password account created for you, or with your Google account (which creates your account automatically on first sign-in).</li>
        <li>You're responsible for keeping your credentials to yourself. The app works best with one account per person.</li>
        <li>Accounts and their data may be deleted for abuse, or if the operator needs to reclaim resources.</li>
      </ul>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-900">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">3. Acceptable use</h2>
      <ul class="list-disc space-y-1 pl-5 text-sm leading-relaxed text-green-700 dark:text-green-300">
        <li>Don't automate, scrape, or hammer the service — it runs on a home connection.</li>
        <li>Don't use it for anything illegal, or to harass other players.</li>
        <li>Don't attempt to access other users' data or the server itself.</li>
      </ul>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-900">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">4. Your data</h2>
      <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
        Your gift log and tags belong to you. You can export a copy anytime
        (About → Download my data) and delete everything permanently (About →
        Delete my account). See the
        <a
          href="/privacy"
          class="font-medium text-green-700 underline decoration-dotted hover:text-green-900 dark:text-green-300 dark:hover:text-green-50"
        >privacy policy</a>
        for exactly what is stored. Backups on the server are kept for a limited
        window and pruned automatically.
      </p>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-900">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">5. Availability</h2>
      <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
        This is a best-effort hobby service. It may be slow, unavailable, or
        discontinued without notice. Once you've installed the offline data,
        the app keeps working on your device even if the server disappears.
      </p>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-900">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">6. Intellectual property</h2>
      <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
        Animal Crossing: New Horizons and all related assets are © Nintendo.
        This app is not affiliated with or endorsed by Nintendo. All game data
        and artwork belong to their original owners.
      </p>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-900">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">7. Liability</h2>
      <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
        To the maximum extent permitted by law, the operator is not liable for
        any damages or data loss arising from your use of the service. Export
        your gift log if it matters to you.
      </p>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-900">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">8. Changes</h2>
      <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
        These terms may change as the service evolves; material changes will be
        reflected on this page. Questions? Open an issue at
        <a
          href="https://github.com/ShadyHippo/IslanderGiftTracker/issues"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-green-700 underline decoration-dotted hover:text-green-900 dark:text-green-300 dark:hover:text-green-50"
        >the project's issue tracker</a>.
      </p>
    </section>
  </main>
</div>
