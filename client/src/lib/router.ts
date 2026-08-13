import { createRouter } from 'sv-router';
import Villagers from './Villagers.svelte';
import VillagerDetail from './VillagerDetail.svelte';

export const { p, navigate, isActive, route } = createRouter({
  '/': Villagers,
  '/villager/:name': VillagerDetail,
});
