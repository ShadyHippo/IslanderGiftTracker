<script lang="ts">
  import { onMount } from 'svelte';
  import { login } from '../lib/session.svelte';
  import { authConfig, type AuthConfig } from '../lib/api';
  import { getInstallState, runInstall } from '../lib/install.svelte';
  import { openAbout } from './about.svelte';
  import ThemeToggle from './ThemeToggle.svelte';

  const install = getInstallState();

  let username = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);

  // Which door the server exposes. Unknown until /api/auth/config answers —
  // we NEVER render a guessed door (wrong-form flash), and we cache the answer
  // so every later visit paints the right one on first render.
  const CFG_KEY = 'acnh.authcfg';
  function cachedCfg(): AuthConfig | null {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (!raw) return null;
      const v: unknown = JSON.parse(raw);
      const mode = (v as AuthConfig | null)?.mode;
      if (mode === 'password' || mode === 'google') return v as AuthConfig;
    } catch {
      /* corrupt/private-mode: fall through as unknown */
    }
    return null;
  }
  let cfg = $state<AuthConfig | null>(cachedCfg());
  const isSecure =
    typeof location !== 'undefined' &&
    (location.protocol === 'https:' || location.hostname === 'localhost');

  // OAuth failures come back as /?login_error=... after the redirect dance.
  const oauthError =
    typeof location !== 'undefined'
      ? new URLSearchParams(location.search).get('login_error')
      : null;

  async function loadConfig() {
    try {
      const c = await authConfig();
      cfg = c;
      try {
        localStorage.setItem(CFG_KEY, JSON.stringify(c));
      } catch {
        /* storage unavailable: spinner-only on future loads */
      }
    } catch {
      // Server unreachable: keep the spinner (never assume a door), retry.
      setTimeout(loadConfig, 3000);
    }
  }

  onMount(() => {
    void loadConfig();
  });

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!username.trim() || !password || submitting) return;
    error = null;
    submitting = true;
    try {
      await login(username.trim(), password);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Login failed';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="flex min-h-screen items-center justify-center bg-green-50 p-6 dark:bg-black">
  <form
    onsubmit={onSubmit}
    class="w-full max-w-sm rounded-2xl border border-green-200 bg-white p-6 shadow-sm dark:border-green-800 dark:bg-green-950"
  >
    <h1 class="mb-1 text-2xl font-bold text-green-800 dark:text-green-100">ACNH Gift Tracker</h1>
    <p class="mb-6 text-sm text-green-700 dark:text-green-300">Sign in to your island</p>

    {#if oauthError}
      <p class="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/60 dark:text-red-300" role="alert">
        {oauthError}
      </p>
    {/if}

    {#if cfg === null}
      <!-- Same gentle spinner as the boot screen: nothing flashes, nothing is
           assumed while the config round-trip is in flight. -->
      <div class="flex flex-col items-center justify-center gap-3 py-10" role="status" aria-live="polite">
        <span class="h-10 w-10 animate-spin rounded-full border-4 border-green-200 border-t-green-700 dark:border-green-700 dark:border-t-green-400"></span>
        <p class="text-sm font-medium text-green-700 dark:text-green-300">Getting your island ready…</p>
      </div>
    {:else if cfg.mode === 'google'}
      <a
        href="/api/auth/google/start"
        class="flex w-full items-center justify-center gap-3 rounded-lg border border-green-300 bg-white px-4 py-3 text-base font-semibold text-green-900 no-underline shadow-sm transition-colors hover:bg-green-50 focus:outline-none focus:ring-2 focus:ring-green-300 dark:border-green-700 dark:bg-green-950 dark:text-green-50 dark:hover:bg-green-800/60"
      >
        <svg viewBox="0 0 24 24" class="h-5 w-5" aria-hidden="true">
          <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.7-.2-2.5H12v4.8h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z" />
          <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3a7.2 7.2 0 0 1-10.8-3.8H1.2v3.1A12 12 0 0 0 12 24z" />
          <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.2a12 12 0 0 0 0 10.8l4.1-3.1z" />
          <path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.5-3.5A12 12 0 0 0 1.2 6.6l4.1 3.1A7.2 7.2 0 0 1 12 4.8z" />
        </svg>
        Continue with Google
      </a>
      {#if !isSecure}
        <p class="mt-3 text-xs leading-relaxed text-green-700 dark:text-green-300">
          Google sign-in only works over HTTPS. Visit
          <span class="font-medium">acnh.datahippo.top</span> instead of this
          address to sign in.
        </p>
      {/if}
      <p class="mt-4 text-xs leading-relaxed text-green-600 dark:text-green-400">
        Your first sign-in creates your island automatically.
      </p>
    {:else}
      <label class="mb-4 block">
      <span class="mb-1 block text-sm font-medium text-green-800 dark:text-green-100">Username</span>
      <input
        bind:value={username}
        type="text"
        name="username"
        autocomplete="username"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
        required
        placeholder="e.g. mabel"
        class="w-full rounded-lg border border-green-300 px-3 py-2.5 text-[17px] text-green-900 placeholder-green-400 focus:border-green-600 focus:outline-none focus:ring-2 focus:ring-green-200 dark:border-green-700 dark:text-green-50 dark:placeholder-green-600"
      />
    </label>

    <label class="mb-5 block">
      <span class="mb-1 block text-sm font-medium text-green-800 dark:text-green-100">Password</span>
      <input
        bind:value={password}
        type="password"
        name="password"
        autocomplete="current-password"
        required
        class="w-full rounded-lg border border-green-300 px-3 py-2.5 text-[17px] text-green-900 placeholder-green-400 focus:border-green-600 focus:outline-none focus:ring-2 focus:ring-green-200 dark:border-green-700 dark:text-green-50 dark:placeholder-green-600"
      />
    </label>

    {#if error}
      <p class="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/60 dark:text-red-300" role="alert">
        {error}
      </p>
    {/if}

      <button
        type="submit"
        disabled={submitting}
        class="w-full rounded-lg bg-green-700 px-4 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-green-800 focus:outline-none focus:ring-2 focus:ring-green-300 disabled:opacity-60"
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    {/if}

    {#if install.offer}
      <div class="mt-5 border-t border-green-100 pt-4 dark:border-green-800/70">
        <button
          type="button"
          onclick={() => runInstall()}
          class="w-full rounded-lg border border-green-300 bg-green-50 px-4 py-2.5 text-sm font-semibold text-green-800 transition-colors hover:bg-green-100 focus:outline-none focus:ring-2 focus:ring-green-200 dark:border-green-700 dark:bg-green-800/60 dark:text-green-100 dark:hover:bg-green-800"
        >
          Install offline data (~{install.sizeMB} MB)
        </button>
        {#if install.error}
          <p class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/60 dark:text-red-300" role="alert">
            {install.error}
          </p>
        {/if}
        <p class="mt-2 text-xs leading-relaxed text-green-600 dark:text-green-400">
          Downloads ~{install.sizeMB} MB · uses ~{install.onDeviceMB} MB of space on this device,
          keeping every image available offline. Tip: add this page to your home screen first
          (browser menu → “Add to Home screen” / “Install”) so it runs like an app in its own
          window.
        </p>
      </div>
    {:else if install.installed}
      <p class="mt-4 text-center text-xs font-medium text-green-600 dark:text-green-400">✓ Offline data installed</p>
    {/if}

    <div class="mt-5 flex items-center justify-between gap-3 border-t border-green-100 pt-4 dark:border-green-800/70">
      <div class="flex items-center gap-2">
        <ThemeToggle />
        <button
          type="button"
          onclick={openAbout}
          class="rounded-lg border border-green-300 bg-white px-4 py-2.5 text-sm font-semibold text-green-800 transition-colors hover:bg-green-100 focus:outline-none focus:ring-2 focus:ring-green-200 dark:border-green-700 dark:bg-green-950 dark:text-green-100 dark:hover:bg-green-800"
        >
          About
        </button>
      </div>
      <div class="flex items-center gap-3">
        <a
          href="/privacy"
          class="text-xs font-medium text-green-600 underline decoration-dotted hover:text-green-800 dark:text-green-400 dark:hover:text-green-200"
        >
          Privacy
        </a>
        <a
          href="/tos"
          class="text-xs font-medium text-green-600 underline decoration-dotted hover:text-green-800 dark:text-green-400 dark:hover:text-green-200"
        >
          Terms
        </a>
      </div>
    </div>
  </form>
</div>
