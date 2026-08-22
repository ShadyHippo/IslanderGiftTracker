import { createRouter } from 'sv-router';
import Villagers from './Villagers.svelte';
import VillagerDetail from './VillagerDetail.svelte';
import Privacy from './Privacy.svelte';

export const { p, navigate, route } = createRouter({
  '/': Villagers,
  '/villager/:name': VillagerDetail,
  '/privacy': Privacy,
});
