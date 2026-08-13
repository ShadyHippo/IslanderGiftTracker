import type { Database } from 'sql.js';
import type { VillagerRow } from './villagers';

export interface GiftIdea {
  name: string;
  variation: string;
  category: string;
  style: string;
  labelThemes: string;
  colors: string[];
  /** 2 = perfect match (primary color + style, or furniture color), 1 = good. */
  tier: number;
  colorMatch: string[];
  /** color2-only matches (clothing trim) — never make an item "perfect". */
  trimMatch: string[];
  styleMatch: string[];
}

// Giftable sheets (items table stores the raw sheet name as category).
// Excluded: Villagers, Special NPCs, Reactions, Message Cards, Recipes,
// Achievements, Construction, Photos, Posters (collectibles, not gift ideas).
const GIFTABLE_CATEGORIES = [
  'Housewares',
  'Miscellaneous',
  'Wall-mounted',
  'Ceiling Decor',
  'Interior Structures',
  'Wallpaper',
  'Floors',
  'Rugs',
  'ToolsGoods',
  'Fencing',
  'Other',
  'Tops',
  'Bottoms',
  'Dress-Up',
  'Headwear',
  'Accessories',
  'Socks',
  'Shoes',
  'Bags',
  'Umbrellas',
  'Clothing Other',
  'Music',
  'Insects',
  'Fish',
  'Sea Creatures',
  'Fossils',
  'Artwork',
  'Gyroids',
];

const CLOTHING_CATEGORIES = new Set([
  'Tops',
  'Bottoms',
  'Dress-Up',
  'Headwear',
  'Accessories',
  'Socks',
  'Shoes',
  'Bags',
  'Umbrellas',
  'Clothing Other',
]);

const norm = (s: unknown) =>
  typeof s === 'string' ? s.trim().toLowerCase() : '';

/** Rank giftable items by overlap with the villager's favorite colors + styles. */
export function giftIdeas(db: Database, villager: VillagerRow, limit = 30): GiftIdea[] {
  const favColors = [villager.color_1, villager.color_2].filter(Boolean).map(norm);
  const favStyles = [villager.style_1, villager.style_2].filter(Boolean).map(norm);
  if (!favColors.length && !favStyles.length) return [];

  const placeholders = GIFTABLE_CATEGORIES.map(() => '?').join(',');
  const res = db.exec(
    `SELECT name, category, variation, style, color1, color2, label_themes
     FROM items WHERE category IN (${placeholders})`,
    GIFTABLE_CATEGORIES,
  );
  if (!res.length) return [];

  const out: GiftIdea[] = [];
  for (const row of res[0].values) {
    const [name, category, variation, style, color1, color2, labelThemes] = row;
    if (typeof name !== 'string') continue;
    const isClothing = CLOTHING_CATEGORIES.has(String(category));
    const itemColors = [color1, color2].filter(Boolean).map(norm);
    const itemStyles = typeof style === 'string' && style
      ? style.split(';').map(norm)
      : [];
    const colorMatch = favColors.filter((c) => itemColors.includes(c));
    const styleMatch = isClothing ? favStyles.filter((s) => itemStyles.includes(s)) : [];

    // Clothing: the primary color (color1) is the real color of the item; color2
    // is usually trim ("White" on every apron). A "perfect" match needs the
    // primary color AND a favorite style. Furniture: both colors are prominent.
    let tier = 0;
    let primaryMatch: string[] = [];
    let trimMatch: string[] = [];
    if (isClothing) {
      const c1 = norm(color1);
      const c2 = norm(color2);
      primaryMatch = favColors.includes(c1) ? [c1] : [];
      trimMatch = favColors.includes(c2) && c1 !== c2 ? [c2] : [];
      if (primaryMatch.length > 0 && styleMatch.length > 0) tier = 2;
      else if (primaryMatch.length > 0 || trimMatch.length > 0 || styleMatch.length > 0) tier = 1;
    } else {
      if (colorMatch.length > 0) tier = 2;
    }
    if (tier === 0) continue;
    out.push({
      name,
      variation: typeof variation === 'string' ? variation : '',
      category: String(category),
      style: typeof style === 'string' ? style : '',
      labelThemes: typeof labelThemes === 'string' ? labelThemes : '',
      colors: [color1, color2].filter(Boolean).map(String),
      tier,
      colorMatch: isClothing ? primaryMatch : colorMatch,
      trimMatch,
      styleMatch,
    });
  }

  out.sort((a, b) => b.tier - a.tier || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

/** Items that are in the villager's house (furniture_name_list, lowercase names). */
export function houseItems(villager: VillagerRow, limit = 12): string[] {
  const raw = villager.furniture_name_list ?? '';
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .slice(0, limit);
}
