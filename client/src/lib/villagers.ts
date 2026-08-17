import type { Database } from 'sql.js';

export interface Villager {
  name: string;
  icon_image: string;
  species: string;
  gender: string;
  personality: string;
  hobby: string;
  birthday: string;
  catchphrase: string;
  favorite_song: string;
  favorite_saying: string;
  style_1: string;
  style_2: string;
  color_1: string;
  color_2: string;
}

const COLS =
  'name, icon_image, species, gender, personality, hobby, birthday, catchphrase, ' +
  'favorite_song, favorite_saying, style_1, style_2, color_1, color_2';

export function allVillagers(db: Database): Villager[] {
  const res = db.exec(`SELECT ${COLS} FROM villagers ORDER BY name`);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => (obj[c] = row[i]));
    return obj as unknown as Villager;
  });
}

/** Full villager row from the villagers table (all columns, snake_case). */
export type VillagerRow = Record<string, string>;

export function villagerByName(db: Database, name: string): VillagerRow | null {
  const res = db.exec('SELECT * FROM villagers WHERE name = ?', [name]);
  if (!res.length || !res[0].values.length) return null;
  const { columns, values } = res[0];
  const obj: Record<string, unknown> = {};
  columns.forEach((c, i) => (obj[c] = values[0][i]));
  return obj as VillagerRow;
}

/** Image URL per villager name, from the images table. */
export function villagerImageUrls(db: Database): Map<string, string> {
  const out = new Map<string, string>();
  const res = db.exec("SELECT name, url FROM images WHERE lower(category) = 'villagers'");
  if (!res.length) return out;
  const { values } = res[0];
  for (const row of values) {
    const name = row[0];
    const url = row[1];
    if (typeof name === 'string' && typeof url === 'string' && url) out.set(name, url);
  }
  return out;
}

/** Single villager's image URL, or null. */
export function villagerImageUrl(db: Database, name: string): string | null {
  const res = db.exec("SELECT url FROM images WHERE lower(category) = 'villagers' AND name = ?", [name]);
  if (!res.length || !res[0].values.length) return null;
  const url = res[0].values[0][0];
  return typeof url === 'string' && url ? url : null;
}
