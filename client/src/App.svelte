<script lang="ts">
  import { onMount } from 'svelte';
  import { Router } from 'sv-router';
  import { getSession, checkSession } from './lib/session.svelte';
  import { getRefDbState, loadReferenceDb } from './lib/refdb.svelte';
  import Login from './lib/Login.svelte';
  import './lib/router';

  const session = getSession();
  const refdb = getRefDbState();

  onMount(() => {
    void checkSession();
  });

  // The reference db is app-level state: load it as soon as we're logged in,
  // regardless of which route we land on (deep links included).
  $effect(() => {
    if (session.user && refdb.status === 'idle') {
      void loadReferenceDb();
    }
  });
</script>

{#if session.checking}
  <div class="flex min-h-screen items-center justify-center bg-green-50">
    <p class="text-green-700">Loading…</p>
  </div>
{:else if !session.user}
  <Login />
{:else}
  <Router />
{/if}
