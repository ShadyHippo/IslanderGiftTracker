<script lang="ts">
  import { onMount } from 'svelte';
  import { getSession, checkSession, logout } from './lib/session.svelte';
  import Login from './lib/Login.svelte';

  const session = getSession();

  onMount(() => {
    void checkSession();
  });

  let loggingOut = $state(false);

  async function onLogout() {
    loggingOut = true;
    await logout();
    loggingOut = false;
  }
</script>

{#if session.checking}
  <div class="flex min-h-screen items-center justify-center bg-green-50">
    <p class="text-green-700">Loading…</p>
  </div>
{:else if !session.user}
  <Login />
{:else}
  <main class="flex min-h-screen flex-col items-center justify-center gap-4 bg-green-50 p-6">
    <h1 class="text-3xl font-bold text-green-800">ACNH Gift Tracker</h1>
    <p class="text-green-700">
      Signed in as <span class="font-semibold">{session.user.username}</span>
    </p>
    <button
      onclick={onLogout}
      disabled={loggingOut}
      class="rounded-lg border border-green-300 bg-white px-4 py-2 text-green-800 hover:bg-green-100 disabled:opacity-60"
    >
      {loggingOut ? 'Signing out…' : 'Sign out'}
    </button>
  </main>
{/if}
