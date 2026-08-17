import type { Database } from 'sql.js';
import type { VillagerRow } from './villagers';

export interface GiftIdea {
  name: string;
  variation: string;
  category: string;
  labelThemes: string;
  /** matched favorite primary colors. */
  colorMatch: string[];
  /** matched favorite styles (clothing only). */
  styleMatch: string[];
  /** true when the item has a purchase price (not NFS/''). */
  buyable: boolean;
  /** where the item can be bought/obtained (xlsx Source column, e.g. "Nook's Cranny"). */
  source: string;
  /** Furniture: cataloged category path ('Kitchen/Appliance/Fridge'); clothing: ''. */
  typePath: string;
}

export interface GiftGroup {
  key: string;
  label: string;
  categories: string[];
  perfect: number;
  items: GiftIdea[];
}

export const FURNITURE_CATS = ['Housewares', 'Miscellaneous', 'Wall-mounted', 'Ceiling Decor', 'Interior Structures'];

export const GIFT_GROUPS: { key: string; label: string; categories: string[] }[] = [
  {
    key: 'furniture',
    label: 'Furniture',
    categories: FURNITURE_CATS,
  },
  {
    key: 'clothing',
    label: 'Clothing',
    categories: ['Tops', 'Bottoms', 'Dress-Up', 'Headwear', 'Accessories', 'Socks', 'Shoes', 'Bags', 'Umbrellas', 'Clothing Other'],
  },
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
    `SELECT name, category, variation, style, color1, color2, label_themes, buy, source, type_path
     FROM items WHERE category IN (${placeholders})`,
    allCats,
  );

  const groups = new Map<string, GiftGroup>();
  for (const g of GIFT_GROUPS) {
    groups.set(g.key, { ...g, perfect: 0, items: [] });
  }

  if (res.length) {
    for (const row of res[0].values) {
      const [name, category, variation, style, color1, , labelThemes, buy, source, typePath] = row;
      if (typeof name !== 'string') continue;
      const groupKey = GIFT_GROUPS.find((g) => g.categories.includes(String(category)))?.key;
      if (!groupKey) continue;
      const group = groups.get(groupKey)!;
      const isClothing = groupKey === 'clothing';
      const itemStyles =
        typeof style === 'string' && style ? style.split(';').map(norm) : [];
      const styleMatch = isClothing ? favStyles.filter((s) => itemStyles.includes(s)) : [];

      // Perfect only. Clothing: primary color (color1) + favorite style.
      // Furniture: primary color (color1). color2/base trims never count.
      const c1 = norm(color1);
      const colorMatch = favColors.includes(c1) ? [c1] : [];
      if (isClothing ? !(colorMatch.length > 0 && styleMatch.length > 0) : colorMatch.length === 0) {
        continue;
      }
      group.items.push({
        name,
        variation: typeof variation === 'string' ? variation : '',
        category: String(category),
        labelThemes: typeof labelThemes === 'string' ? labelThemes : '',
        colorMatch,
        styleMatch,
        buyable: typeof buy === 'string' && parseFloat(buy) > 0,
        source: typeof source === 'string' ? source : '',
        typePath: typeof typePath === 'string' ? typePath : '',
      });
    }
  }

  const out: GiftGroup[] = [];
  for (const g of groups.values()) {
    if (g.items.length === 0) continue;
    // Deduped by item name (best variation wins — buyable over NFS),
    // buyable first, then name.
    const best = new Map<string, GiftIdea>();
    for (const idea of g.items) {
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
    out.push(g);
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

export interface HouseItemDetail {
  /** display name (titlecased, as passed in). */
  name: string;
  category: string;
  /** distinct color1/color2 values across the item's variations. */
  colors: string[];
}

// Items/names are inconsistently cased in the xlsx ('accessories stand',
// '1-Up Mushroom'), so all house queries match case-insensitively.
const FURNITURE_PH = FURNITURE_CATS.map(() => '?').join(',');

/** True when the ref DB contains the build-time house tables (old refs don't). */
function hasHouseTables(db: Database): boolean {
  const res = db.exec(
    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('house_items','house_images')",
  );
  return !!res.length && Number(res[0].values[0]?.[0]) === 2;
}

/** Per-item details for the villager's house items, keyed by display name.
 * Uses the build-time `house_items` table (Nookipedia nh_house), which carries
 * the EXACT variant colors of the villager's original house. Falls back to
 * aggregating every variation's colors only for items with no data. */
export function houseItemsDetailed(
  db: Database,
  villagerName: string,
  names: string[],
): Map<string, HouseItemDetail> {
  const out = new Map<string, HouseItemDetail>();
  if (!names.length) return out;
  // Exact per-villager colors from the build (lowercase match on villager name).
  const exactByKey = new Map<string, HouseItemDetail>();
  if (hasHouseTables(db)) {
    const houseRes = db.exec('SELECT name, category, color1, color2 FROM house_items WHERE lower(villager) = ?', [
      villagerName.toLowerCase(),
    ]);
    if (houseRes.length) {
      for (const [dbName, category, color1, color2] of houseRes[0].values) {
        if (typeof dbName !== 'string') continue;
        const key = dbName.toLowerCase();
        const existing = exactByKey.get(key);
        const colors = new Set<string>(existing?.colors ?? []);
        if (typeof color1 === 'string' && color1.trim()) colors.add(color1.trim());
        if (typeof color2 === 'string' && color2.trim()) colors.add(color2.trim());
        exactByKey.set(key, {
          name: existing?.name ?? dbName,
          category: typeof category === 'string' && category.trim() ? category.trim() : (existing?.category ?? ''),
          colors: [...colors],
        });
      }
    }
  }
  // Fallback: aggregate colors across ALL variants for items without data
  // (mismatched names, offline build without the house_items table, etc.).
  const missing = names.filter((n) => !exactByKey.has(n.toLowerCase()));
  if (missing.length) {
    const namePh = missing.map(() => '?').join(',');
    const res = db.exec(
      `SELECT name, category, color1, color2 FROM items
       WHERE lower(name) IN (${namePh}) AND category IN (${FURNITURE_PH})`,
      [...missing.map((n) => n.toLowerCase()), ...FURNITURE_CATS],
    );
    if (res.length) {
      const colorsBy = new Map<string, Set<string>>();
      const catBy = new Map<string, string>();
      for (const [dbName, category, color1, color2] of res[0].values) {
        if (typeof dbName !== 'string') continue;
        const key = dbName.toLowerCase();
        let set = colorsBy.get(key);
        if (!set) {
          set = new Set();
          colorsBy.set(key, set);
        }
        if (typeof color1 === 'string' && color1.trim()) set.add(color1.trim());
        if (typeof color2 === 'string' && color2.trim()) set.add(color2.trim());
        if (typeof category === 'string' && category.trim() && !catBy.has(key)) catBy.set(key, category.trim());
      }
      for (const name of missing) {
        const key = name.toLowerCase();
        const colors = [...(colorsBy.get(key) ?? [])].sort();
        const category = catBy.get(key) ?? '';
        if (colors.length || category) exactByKey.set(key, { name, category, colors });
      }
    }
  }
  for (const name of names) {
    const hit = exactByKey.get(name.toLowerCase());
    if (hit) out.set(name, { ...hit, name });
  }
  return out;
}

/** Full-quality interior/exterior photos of the villager's original house. */
export function housePhotos(
  db: Database,
  villagerName: string,
): { interior: Uint8Array<ArrayBuffer> | null; exterior: Uint8Array<ArrayBuffer> | null } {
  const out: { interior: Uint8Array<ArrayBuffer> | null; exterior: Uint8Array<ArrayBuffer> | null } = {
    interior: null,
    exterior: null,
  };
  if (!hasHouseTables(db)) return out;
  const res = db.exec('SELECT kind, data FROM house_images WHERE lower(villager) = ?', [
    villagerName.toLowerCase(),
  ]);
  if (res.length) {
    for (const [kind, data] of res[0].values) {
      if ((kind === 'interior' || kind === 'exterior') && data instanceof Uint8Array) {
        out[kind] = data as Uint8Array<ArrayBuffer>;
      }
    }
  }
  return out;
}

/** Image bytes for house items, keyed by display name. Prefers the exact
 *  per-villager icon from the build-time `house_item_images` table (nh_house —
 *  includes clothing like chef's outfit, which the furniture-only query below
 *  would skip); falls back to the generic images table. */
export function houseImages(
  db: Database,
  villagerName: string,
  names: string[],
): Map<string, Uint8Array<ArrayBuffer>> {
  const out = new Map<string, Uint8Array<ArrayBuffer>>();
  if (!names.length) return out;
  let found = new Set<string>();
  try {
    const namePh = names.map(() => '?').join(',');
    const res = db.exec(
      `SELECT name, data FROM house_item_images WHERE lower(villager) = ? AND lower(name) IN (${namePh})`,
      [villagerName.toLowerCase(), ...names.map((n) => n.toLowerCase())],
    );
    if (res.length) {
      for (const [dbName, data] of res[0].values) {
        if (typeof dbName !== 'string' || !(data instanceof Uint8Array)) continue;
        const match = names.find((n) => n.toLowerCase() === dbName.toLowerCase());
        if (match) {
          out.set(match, data as Uint8Array<ArrayBuffer>);
          found.add(match.toLowerCase());
        }
      }
    }
  } catch {
    // older ref db without house_item_images — fall through to generic
  }
  const missing = names.filter((n) => !found.has(n.toLowerCase()));
  if (!missing.length) return out;
  const namePh = missing.map(() => '?').join(',');
  const res = db.exec(
    `SELECT name, variation, data FROM images
     WHERE lower(name) IN (${namePh}) AND category IN (${FURNITURE_PH})`,
    [...missing.map((n) => n.toLowerCase()), ...FURNITURE_CATS],
  );
  if (!res.length) return out;
  const best = new Map<string, { variation: string; data: Uint8Array<ArrayBuffer> }>();
  for (const row of res[0].values) {
    const [dbName, variation, data] = row;
    if (typeof dbName !== 'string' || !(data instanceof Uint8Array)) continue;
    const key = dbName.toLowerCase();
    const varStr = typeof variation === 'string' ? variation : '';
    const existing = best.get(key);
    if (!existing || (varStr === '' && existing.variation !== '')) {
      best.set(key, { variation: varStr, data: data as Uint8Array<ArrayBuffer> });
    }
  }
  for (const name of missing) {
    const hit = best.get(name.toLowerCase());
    if (hit) out.set(name, hit.data);
  }
  return out;
}
