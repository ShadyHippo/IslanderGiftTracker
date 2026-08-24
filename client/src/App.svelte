<script lang="ts">
  import { onMount } from 'svelte';
  import { Router } from 'sv-router';
  import { getSession, checkSession } from './lib/session.svelte';
  import { getRefDbState, loadReferenceDb } from './lib/refdb.svelte';
  import { getProgressState, loadProgress, flushProgressOnUnload, saveProgress } from './lib/progress.svelte';
  import { getInstallState, checkInstall } from './lib/install.svelte';
  import { maybeAutoOpenAbout } from './lib/about.svelte';
  import Login from './lib/Login.svelte';
  import About from './lib/About.svelte';
  import SaveBadges from './lib/SaveBadges.svelte';
  import { route } from './lib/router';

  // Pages that must render WITHOUT a login (Google's OAuth branding requires
  // publicly reachable privacy policy + terms): direct links and logged-out
  // visitors get the real page, never the login wall.
  const PUBLIC_PATHS = new Set(['/privacy', '/tos']);
  const isPublicPage = $derived(PUBLIC_PATHS.has(route.pathname));

  const session = getSession();
  const refdb = getRefDbState();
  const progress = getProgressState();
  const install = getInstallState();

  // --- Boot spinner -----------------------------------------------------------
  // Cold start, password sign-in, and the return trip from Google all funnel
  // through here: one calm, opaque, centered spinner while the on-device dbs
  // warm up, instead of bars flashing and half-built screens. HARD CAP: 2s for
  // the post-auth boot, 1.2s for the initial session check — the spinner is
  // never allowed to become a second loading screen.
  const BOOT_CAP_MS = 2000;
  const SESSION_CHECK_CAP_MS = 1200;
  let bootStartedAt = 0;
  let authCheckStartedAt = 0;
  let bootExpired = $state(false);
  let authCheckExpired = $state(false);
  // A failed OAuth redirect lands on /?login_error=... — show the form (with
  // the reason) immediately instead of spinning.
  const hasLoginError =
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).has('login_error');

  const waitingForSession = $derived(
    session.checking && !session.user && !authCheckExpired && !hasLoginError,
  );
  const booting = $derived(
    session.user && refdb.status !== 'ready' && !bootExpired,
  );

  $effect(() => {
    if (booting && bootStartedAt === 0) {
      bootStartedAt = Date.now();
      const t = setTimeout(() => (bootExpired = true), BOOT_CAP_MS);
      return () => clearTimeout(t);
    }
  });

  $effect(() => {
    if (waitingForSession && authCheckStartedAt === 0) {
      authCheckStartedAt = Date.now();
      const t = setTimeout(() => (authCheckExpired = true), SESSION_CHECK_CAP_MS);
      return () => clearTimeout(t);
    }
  });

  onMount(() => {
    void checkSession();
    void checkInstall();
    // The first-visit About modal must never cover a public legal page.
    if (!isPublicPage) maybeAutoOpenAbout();
  });

  // The reference db is app-level state: load it as soon as we're logged in,
  // regardless of which route we land on (deep links included).
  $effect(() => {
    if (session.user && refdb.status === 'idle') {
      void loadReferenceDb();
    }
  });

  // Same for the user's progress db (gift log) — a tiny second sqlite file.
  $effect(() => {
    if (session.user && progress.status === 'idle') {
      void loadProgress();
    }
  });

  // Flush any pending changes when the tab closes; the 1.5s debounce covers
  // the normal case, this covers closing the tab mid-edit.
  $effect(() => {
    const handler = () => flushProgressOnUnload();
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  });

  // Retry save when the browser comes back online
  $effect(() => {
    const onOnline = () => {
      if (progress.dirty && !progress.saving) {
        void saveProgress();
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  });

  // Keep the proxy/container warm — ping /health every 4 min while the
  // tab is visible so acnh.datahippo.top doesn't cold-start for family.
  $effect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      fetch('/health', { cache: 'no-store', keepalive: true }).catch(() => {});
    };
    const start = () => {
      if (timer) return;
      ping();
      timer = setInterval(ping, 4 * 60 * 1000);
    };
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    const onVis = () => { if (document.visibilityState === 'visible') start(); else stop(); };
    document.addEventListener('visibilitychange', onVis);
    start();
    return () => { document.removeEventListener('visibilitychange', onVis); stop(); };
  });
</script>

{#if waitingForSession || booting}
  <!--
    Calm boot screen: opaque so nothing underneath flashes through. Shown
    while the session confirms and the on-device reference db decompresses —
    both are local/fast when cached, and the caps above guarantee this never
    outstays its welcome.
  -->
  <div class="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-4 bg-green-50" style="padding-top: env(safe-area-inset-top, 0px)">
    <span class="h-10 w-10 animate-spin rounded-full border-4 border-green-200 border-t-green-700"></span>
    <p class="text-sm font-medium text-green-700">Getting your island ready…</p>
  </div>
{:else if !session.user && !isPublicPage}
  <!--
    No cached user: show the login form immediately (no network wait).
    checkSession() revalidates in the background — anyone holding a valid
    cookie flips into the app as soon as it confirms; offline devices fall
    back to their cached user instead of ever seeing this.
  -->
  <Login />
{:else}
  <Router />

  {#if session.user}
    {#if progress.status === 'ready'}
      <SaveBadges />
    {/if}
    {#if refdb.status === 'downloading' || (refdb.status === 'initializing' && refdb.downloaded)}
      <div class="fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-1 bg-amber-100/95 px-4 py-2 text-center text-sm font-medium text-amber-900 shadow backdrop-blur" style="padding-top: env(safe-area-inset-top, 12px)">
        <span class="flex items-center gap-2">
          <span class="h-3 w-3 animate-spin rounded-full border-2 border-amber-900/30 border-t-amber-900"></span>
          {#if refdb.status === 'downloading'}
            Downloading data… {refdb.progress}%
          {:else}
            Preparing data…
          {/if}
        </span>
      </div>
    {/if}
  {/if}
{/if}

<About />

{#if install.phase === 'installing'}
  <!-- Full-screen takeover: blocks browsing so lazy loads don't compete with
       the bundle download on the server's uplink. Overlays (not replaces)
       whatever is underneath, keeping the login form state intact. -->
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-green-50/95 p-6 backdrop-blur-sm">
    <div class="w-full max-w-sm">
      <p class="mb-3 text-center text-sm font-medium text-green-800">{install.detail}</p>
      <div class="h-3 w-full overflow-hidden rounded-full bg-green-100">
        <div class="h-full bg-green-700 transition-all duration-200" style="width: {install.progress}%"></div>
      </div>
      <p class="mt-2 text-center text-xs text-green-700">{Math.round(install.progress)}%</p>
    </div>
  </div>
{/if}
