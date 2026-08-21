<script lang="ts">
  import { login } from '../lib/session.svelte';
  import { getInstallState, runInstall } from '../lib/install.svelte';
  import { openAbout } from './about.svelte';

  const install = getInstallState();

  let username = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);

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

<div class="flex min-h-screen items-center justify-center bg-green-50 p-6">
  <form
    onsubmit={onSubmit}
    class="w-full max-w-sm rounded-2xl border border-green-200 bg-white p-6 shadow-sm"
  >
    <h1 class="mb-1 text-2xl font-bold text-green-800">ACNH Gift Tracker</h1>
    <p class="mb-6 text-sm text-green-700">Sign in to your island</p>

    <label class="mb-4 block">
      <span class="mb-1 block text-sm font-medium text-green-800">Username</span>
      <input
        bind:value={username}
        type="text"
        name="username"
        autocomplete="username"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
        required
        placeholder="e.g. wife"
        class="w-full rounded-lg border border-green-300 px-3 py-2.5 text-base text-green-900 placeholder-green-400 focus:border-green-600 focus:outline-none focus:ring-2 focus:ring-green-200"
      />
    </label>

    <label class="mb-5 block">
      <span class="mb-1 block text-sm font-medium text-green-800">Password</span>
      <input
        bind:value={password}
        type="password"
        name="password"
        autocomplete="current-password"
        required
        class="w-full rounded-lg border border-green-300 px-3 py-2.5 text-base text-green-900 placeholder-green-400 focus:border-green-600 focus:outline-none focus:ring-2 focus:ring-green-200"
      />
    </label>

    {#if error}
      <p class="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
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

    {#if install.offer}
      <div class="mt-5 border-t border-green-100 pt-4">
        <button
          type="button"
          onclick={() => runInstall()}
          class="w-full rounded-lg border border-green-300 bg-green-50 px-4 py-2.5 text-sm font-semibold text-green-800 transition-colors hover:bg-green-100 focus:outline-none focus:ring-2 focus:ring-green-200"
        >
          Install offline data (~{install.sizeMB} MB)
        </button>
        {#if install.error}
          <p class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {install.error}
          </p>
        {/if}
        <p class="mt-2 text-xs leading-relaxed text-green-600">
          Downloads ~{install.sizeMB} MB · uses ~{install.onDeviceMB} MB of space on this device,
          keeping every image available offline. Tip: add this page to your home screen first
          (browser menu → “Add to Home screen” / “Install”) so it runs like an app in its own
          window.
        </p>
      </div>
    {:else if install.installed}
      <p class="mt-4 text-center text-xs font-medium text-green-600">✓ Offline data installed</p>
    {/if}

    <div class="mt-5 border-t border-green-100 pt-4">
      <button
        type="button"
        onclick={openAbout}
        class="w-full rounded-lg border border-green-300 bg-white px-4 py-2.5 text-sm font-semibold text-green-800 transition-colors hover:bg-green-100 focus:outline-none focus:ring-2 focus:ring-green-200"
      >
        About
      </button>
    </div>
  </form>
</div>
