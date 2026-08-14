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
  /** color2-only matches (base/trim color) — never make an item "perfect". */
  trimMatch: string[];
  /** matched favorite styles (clothing only). */
  styleMatch: string[];
  /** chip label for color2 matches: "trim" (clothing) vs "secondary" (furniture). */
  secondaryLabel: string;
  /** true when the item has a purchase price (not NFS/''). */
  buyable: boolean;
  /** Furniture: cataloged category path ('Kitchen/Appliance/Fridge'); clothing: ''. */
  typePath: string;
}

export interface GiftGroup {
  key: string;
  label: string;
  categories: string[];
  perfect: number;
  good: number;
  items: GiftIdea[];
}

export const GIFT_GROUPS: { key: string; label: string; categories: string[] }[] = [
  {
    key: 'furniture',
    label: 'Furniture',
    categories: ['Housewares', 'Miscellaneous', 'Wall-mounted', 'Ceiling Decor', 'Interior Structures'],
  },
  {
    key: 'clothing',
    label: 'Clothing',
    categories: ['Tops', 'Bottoms', 'Dress-Up', 'Headwear', 'Accessories', 'Socks', 'Shoes', 'Bags', 'Umbrellas', 'Clothing Other'],
  },
  { key: 'surfaces', label: 'Surfaces', categories: ['Wallpaper', 'Floors', 'Rugs'] },
  { key: 'music', label: 'Music', categories: ['Music'] },
  { key: 'critters', label: 'Critters', categories: ['Insects', 'Fish', 'Sea Creatures'] },
  { key: 'collections', label: 'Collections', categories: ['Fossils', 'Artwork', 'Gyroids'] },
  { key: 'tools', label: 'Tools & Outdoors', categories: ['ToolsGoods', 'Fencing'] },
  { key: 'other', label: 'Other', categories: ['Other'] },
];
const norm = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

/** Rank giftable items by overlap with the villager's favorites, grouped by type. */
export function giftIdeasByGroup(db: Database, villager: VillagerRow): GiftGroup[] {
  const favColors = [villager.color_1, villager.color_2].filter(Boolean).map(norm);
  const favStyles = [villager.style_1, villager.style_2].filter(Boolean).map(norm);
  if (!favColors.length && !favStyles.length) return [];

  const allCats = GIFT_GROUPS.flatMap((g) => g.categories);
  const placeholders = allCats.map(() => '?').join(',');
  const res = db.exec(
    `SELECT name, category, variation, style, color1, color2, label_themes, buy, type_path
     FROM items WHERE category IN (${placeholders})`,
    allCats,
  );

  const groups = new Map<string, GiftGroup>();
  for (const g of GIFT_GROUPS) {
    groups.set(g.key, { ...g, perfect: 0, good: 0, items: [] });
  }

  if (res.length) {
    for (const row of res[0].values) {
      const [name, category, variation, style, color1, color2, labelThemes, buy, typePath] = row;
      if (typeof name !== 'string') continue;
      const groupKey = GIFT_GROUPS.find((g) => g.categories.includes(String(category)))?.key;
      if (!groupKey) continue;
      const group = groups.get(groupKey)!;
      const isClothing = groupKey === 'clothing';
      const itemStyles =
        typeof style === 'string' && style ? style.split(';').map(norm) : [];
      const styleMatch = isClothing ? favStyles.filter((s) => itemStyles.includes(s)) : [];

      // Clothing: primary color (color1) + favorite style = perfect; color2 is
      // usually trim and can't claim "perfect". Furniture: any favorite color.
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
      // Furniture: primary color (color1) match = perfect; color2 is the
      // base/trim (every kitchen scale is color2=White) and can't claim perfect.
      } else {
        const c1 = norm(color1);
        const c2 = norm(color2);
        primaryMatch = favColors.includes(c1) ? [c1] : [];
        trimMatch = favColors.includes(c2) && c1 !== c2 ? [c2] : [];
        if (primaryMatch.length > 0) tier = 2;
        else if (trimMatch.length > 0) tier = 1;
      }
      if (tier === 0) continue;
      if (tier === 2) group.perfect++;
      else group.good++;
      group.items.push({
        name,
        variation: typeof variation === 'string' ? variation : '',
        category: String(category),
        style: typeof style === 'string' ? style : '',
        labelThemes: typeof labelThemes === 'string' ? labelThemes : '',
        colors: [color1, color2].filter(Boolean).map(String),
        tier,
        colorMatch: primaryMatch,
        trimMatch,
        styleMatch,
        secondaryLabel: isClothing ? 'trim' : 'secondary',
        buyable: typeof buy === 'string' && parseFloat(buy) > 0,
        typePath: typeof typePath === 'string' ? typePath : '',
      });
    }
  }

  const out: GiftGroup[] = [];
  for (const g of groups.values()) {
    if (g.items.length === 0) continue;
    // Trim: perfect matches only, deduped by item name (best variation wins —
    // buyable over NFS), buyable first, then name.
    const best = new Map<string, GiftIdea>();
    for (const idea of g.items) {
      if (idea.tier !== 2) continue;
      const key = idea.name.toLowerCase();
      const existing = best.get(key);
      if (!existing || (idea.buyable && !existing.buyable)) {
        best.set(key, idea);
      }
    }
    g.items = [...best.values()].sort(
      (a, b) => Number(b.buyable) - Number(a.buyable) || a.name.localeCompare(b.name),
    );
    g.perfect = g.items.length;
    g.good = 0;
    out.push(g);
  }
  return out;
}

/**
 * Curated "top picks": perfect matches only, deduped by item name (best
 * variation wins: buyable over NFS), buyable first, then round-robined across
 * groups so the top list spans categories instead of stacking one type.
 */
export function curatedPicks(groups: GiftGroup[], limit = 10): GiftIdea[] {
  const queues: GiftIdea[][] = [];
  for (const g of groups) {
    const best = new Map<string, GiftIdea>();
    for (const idea of g.items) {
      if (idea.tier !== 2) continue;
      const key = idea.name.toLowerCase();
      const existing = best.get(key);
      if (!existing || (idea.buyable && !existing.buyable)) {
        best.set(key, idea);
      }
    }
    queues.push(
      [...best.values()].sort(
        (a, b) => Number(b.buyable) - Number(a.buyable) || a.name.localeCompare(b.name),
      ),
    );
  }
  const out: GiftIdea[] = [];
  let cursor = 0;
  while (out.length < limit) {
    let picked = false;
    for (let k = 0; k < queues.length; k++) {
      const q = queues[(cursor + k) % queues.length];
      if (q.length > 0) {
        out.push(q.shift()!);
        picked = true;
        break;
      }
    }
    if (!picked) break;
    cursor++;
  }
  return out;
}

/** Image bytes for the given item names in a group (category + name + variation). */
export function giftImagesForGroup(
  db: Database,
  group: GiftGroup,
  names: string[],
): Map<string, Uint8Array<ArrayBuffer>> {
  const out = new Map<string, Uint8Array<ArrayBuffer>>();
  if (names.length === 0) return out;
  const catPh = group.categories.map(() => '?').join(',');
  const namePh = names.map(() => '?').join(',');
  const res = db.exec(
    `SELECT name, variation, data FROM images
     WHERE category IN (${catPh}) AND name IN (${namePh})`,
    [...group.categories, ...names],
  );
  if (!res.length) return out;
  for (const row of res[0].values) {
    const [name, variation, data] = row;
    if (typeof name === 'string' && data instanceof Uint8Array) {
      out.set(`${name}\u0000${typeof variation === 'string' ? variation : ''}`, data);
    }
  }
  return out;
}

export interface TypeNode {
  /** full path, e.g. 'Kitchen/Appliance'. */
  path: string;
  label: string;
  /** items under this node (including all descendants). */
  count: number;
  children: TypeNode[];
}

/**
 * Build the category tree from a group's items. Each item is counted at every
 * ancestor level, so a node's count = how many items selecting it would show.
 * `pathOf` maps an item to its path: furniture uses typePath (multi-level),
 * clothing uses the flat category (single level).
 */
export function typeTree(
  items: GiftIdea[],
  pathOf: (i: GiftIdea) => string = (i) => i.typePath,
): TypeNode[] {
  const counts = new Map<string, number>();
  for (const idea of items) {
    const parts = pathOf(idea)
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      counts.set(acc, (counts.get(acc) ?? 0) + 1);
    }
  }
  const nodes = new Map<string, TypeNode>();
  for (const [path, count] of counts) {
    nodes.set(path, { path, label: path.split('/').pop()!, count, children: [] });
  }
  const tree: TypeNode[] = [];
  for (const node of nodes.values()) {
    const i = node.path.lastIndexOf('/');
    if (i === -1) tree.push(node);
    else nodes.get(node.path.slice(0, i))!.children.push(node);
  }
  const byLabel = (a: TypeNode, b: TypeNode) => a.label.localeCompare(b.label);
  tree.sort(byLabel);
  for (const node of nodes.values()) node.children.sort(byLabel);
  return tree;
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
