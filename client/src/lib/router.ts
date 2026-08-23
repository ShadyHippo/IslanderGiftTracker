import { createRouter } from 'sv-router';
import Villagers from './Villagers.svelte';
import VillagerDetail from './VillagerDetail.svelte';
import Privacy from './Privacy.svelte';
import Tos from './TOS.svelte';

export const { p, navigate, route } = createRouter({
  '/': Villagers,
  '/villager/:name': VillagerDetail,
  '/privacy': Privacy,
  '/tos': Tos,
});
