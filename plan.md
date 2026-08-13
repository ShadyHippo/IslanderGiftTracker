# ACNH Gift Tracker — Project Plan

A mobile-first PWA for the wife's iPhone: log in on the home server, look up what Animal Crossing: New Horizons villagers like, and keep a per-villager gift log — fully offline-capable.

## Source data

- `res/Data Spreadsheet for Animal Crossing New Horizons.xlsx` (source spreadsheet, from `~/Downloads`; provenance + update steps in `README.md` → Source data)
- 40 sheets, ~30k rows total. Category sheets: furniture (Housewares, Miscellaneous, Wall-mounted, Ceiling Decor, Interior Structures), surfaces (Wallpaper, Floors, Rugs), collectibles (Photos, Posters), clothing (Tops, Bottoms, Dress-Up, Headwear, Accessories, Socks, Shoes, Bags, Umbrellas, Clothing Other), Tools/Goods, Fencing, Music, critters (Insects, Fish, Sea Creatures), Fossils, Artwork, Gyroids, Other, Construction, Recipes, Achievements, Villagers, Special NPCs, Reactions, Message Cards, Seasons and Events, Paradise Planning.
- **No images in the spreadsheet** — every Image column is empty; no `xl/media/` in the xlsx; the 40 `drawing*.xml` files are 775-byte placeholders. Only internal IDs in `Filename` columns (e.g. `brd09`, `squ05`).
- Images are instead fetched at **build time** from **dodo.ac** (Nookipedia's public image CDN) — see the Images section below.

## Research findings (what villagers "like")

- There is **no per-villager list of specific items**. ACNH gift quality is rule-based: match the item's color/style against the villager's favorites.
- The spreadsheet already contains the canonical data: **Style 1/2** (favorite clothing styles: Active/Cool/Cute/Elegant/Gorgeous/Simple) and **Color 1/2** (favorite colors), plus Favorite Song, Favorite Saying, birthday, hobby, personality.
- This is the same model Nookipedia's API (`nh_details.fav_styles` / `fav_colors`), acnh.co, Nook Plaza, and `conniejkchan/acnh-villager-stylist` use. **No external API / key needed — fully offline.**
- Gift matcher rule: item color/style overlaps villager Color 1/2 or Style 1/2 → good gift. *(Build-time check: whether clothing sheets carry a Style column; if absent, matcher is color-based — still the canonical heuristic.)*

## Architecture

```
SERVER (Go, dead stupid, docker, behind SWAG):
  - auth: who are you → which dbs do you need
  - serves /db/reference.v{N}.db.gz (versioned — new version = new file + manifest)
  - receives progress db uploads, stores versioned backups (never lose data)
  - serves the built PWA shell

CLIENT (PWA on iPhone, all logic local):
  - sql.js: real SQLite (WASM) in the browser
  - downloads + caches reference.db.gz once (Cache API / service worker)
  - progress.db: gift log, loaded at login, written locally,
    auto-uploaded on app open + manual Sync button
  - gift matching = item style/color vs villager favorites
```

### The two-database model (as designed)

- **reference.db** — readonly, versioned artifact rebuilt from the xlsx. Mirrored server↔client; server serves db files + versioned updates, client does all query logic against its own copy.
- **progress.db** — writable, one per user. Lives in the browser's IndexedDB as a byte blob (iOS Safari has no File System Access API; IndexedDB is the correct, bulletproof storage). Loaded into sql.js memory at start, exported back to bytes on sync, uploaded to server.

### iOS / PWA constraints

- PWA install + service worker require **HTTPS** (plain LAN HTTP won't install). Use domain `nookipedia.datahippo.top` behind existing SWAG + Cloudflare/Let's Encrypt cert (iOS trusts it).
- No File System Access API on iOS Safari — IndexedDB + Cache API instead (both fully supported).
- Target: modern iOS Safari + desktop Chrome/Safari only. No legacy support, no polyfills.

## Database schemas

### reference.db (readonly, versioned, rebuilt from spreadsheet)

39 source tables (one per sheet, snake_cased; `Read Me` skipped):
`housewares`, `miscellaneous`, `wall_mounted`, `ceiling_decor`, `interior_structures`, `wallpaper`, `floors`, `rugs`, `photos`, `posters`, `tools_goods`, `fencing`, `tops`, `bottoms`, `dress_up`, `headwear`, `accessories`, `socks`, `shoes`, `bags`, `umbrellas`, `clothing_other`, `music`, `insects`, `fish`, `sea_creatures`, `fossils`, `artwork`, `gyroids`, `other`, `construction`, `recipes`, `achievements`, `villagers`, `special_npcs`, `reactions`, `message_cards`, `seasons_events`, `paradise_planning`

App-facing tables (what the client queries):
- `villagers` — 29-col profile: name, species, gender, personality, subtype, hobby, birthday, catchphrase, Style 1/2, Color 1/2, favorite song/saying, default clothing/umbrella, wallpaper, flooring, etc.
- `items` — flattened from clothing/furniture/critter sheets: `name, category, color1, color2, buy, sell, source` (~30k rows) — search + gift matcher
- `meta(key, value)` — schema version, build date, source hash

Shipped as `reference.v1.db.gz`, target ≤3 MB download.

### progress.db — the user write db (spec, draft v1)

Everything the user writes lives in one per-user SQLite db (`progress.db`), kept as a
byte blob in IndexedDB on the phone, loaded into sql.js, and mirrored to the server.

**Principles**
- Single writer (the phone), last-write-wins on whole-db upload. No merge, ever.
- Local-first: the phone copy is the source of truth; the server is mirror + versioned
  backup. Fresh install / cleared IndexedDB → download the server copy on first open.
- Reference data is never copied here: `villagers.name` / item names are TEXT join keys
  into `reference.db` (which is rebuilt and versioned; no FKs that would break).
- Every write feature must be: (1) in the schema, (2) in the client's `ensureSchema`
  (idempotent migrations), (3) survive upload (server checks are generic).

**Feature inventory (what the user can write)**
| Feature | Table | Status |
|---|---|---|
| Favorite villagers | `villager_state` | **locked** (user requested; not yet built) |
| On-island villagers | `villager_state` | **locked** (user requested) |
| Gift given, per villager (item + date + note) | `gifts` | **locked** (plan; works for any villager, favorite or not) |
| Free-text notes per villager ("moved in", "waiting for her photo") | `villager_state.notes` | proposed — cheap, high value |
| Gift wishlist ("want to give later") paired with the matcher | `wishlist` | proposed — natural matcher output; skip if out of scope |

Explicitly **not** here: item catalog checklists ("which items I own"), villager
photos/birthday reminders (read-only views over `reference.db`), multi-device sync.

**Schema (draft v2, `meta.schema_version = 2`)**
```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
-- keys: schema_version, owner (username), last_synced (ISO8601)

CREATE TABLE villager_state (
  villager   TEXT PRIMARY KEY,            -- reference.db villagers.name
  favorite   INTEGER NOT NULL DEFAULT 0,
  on_island  INTEGER NOT NULL DEFAULT 0,
  notes      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL                -- ISO8601 UTC
);

CREATE TABLE gifts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  villager   TEXT NOT NULL,               -- villagers.name (no FK, by design)
  item       TEXT NOT NULL,               -- name snapshot as given/picked; survives
                                          -- reference rebuilds; free text OK
  date       TEXT NOT NULL,               -- YYYY-MM-DD (day the gift was given)
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_gifts_villager ON gifts(villager);
```

**Open questions (awaiting user)** — mark these in the next planning pass:
1. Wishlist table in or out?
2. `villager_state.notes` in or out?
3. One row per gift (item), or allow bundles ("gave 3 things on 1 day")?

**Client lifecycle**
- Load: IndexedDB blob → sql.js → `ensureSchema(db)` (runs CREATE TABLE IF NOT EXISTS +
  meta bumps; additive only, never destructive).
- Read/write: sql.js in memory; every write sets `dirty`.
- Save: `db.export()` → blob → IndexedDB (cheap, do on every write).
- Sync: auto on app open + manual button. If server copy exists and local is empty
  (fresh install) → download instead. Otherwise upload; server stores a timestamped
  backup before replacing (already implemented, 20 kept).

**Server facts that constrain the spec**
- `GET/PUT /api/progress`, per-user file, 64 MB upload cap, validation = sqlite magic +
  `PRAGMA quick_check` only — **schema-agnostic**, so any table set above is accepted
  unchanged. No server code change needed for the new tables.
- Server's own empty-seed template is still `gifts`+`meta` v1; irrelevant because the
  client runs `ensureSchema` on anything it downloads.

### Server storage

- `users(id, username, password_hash)` — bcrypt + session cookie (wife + husband accounts)
- files: `data/progress/{username}.db` + `data/progress/backups/{username}-{timestamp}.db`

## Server (Go)

- Auth: username + password per user, bcrypt, session cookie. "Minimal, one password each." Passwords stored as **bcrypt hashes** (salted, one-way, cost 10) in `users.db` — plaintext never stored. **No password-change UI** (user decision): admin reset on-server via `acnh-server -set-password <user> -password <new>`. **Login rate-limited** per-IP on failed attempts (default 10/15 min, env-configurable, XFF-aware behind SWAG, success resets, 429 on excess). **Restore is manual only** (user decision): `/api/progress/versions` lists backups; operator swaps files by hand.
- Endpoints:
  - `POST /api/login`, `GET /api/me`, `POST /api/logout`
  - `GET /db/manifest.json` — versioned reference db registry
  - `GET /db/reference.v{N}.db.gz` — reference download (gzipped)
  - `GET /api/progress` — download user's progress db (or empty template)
  - `PUT /api/progress` — upload; server saves timestamped backup before replacing
- Static file serving of built PWA.
- Dockerfile + docker-compose entry; SWAG site config for `nookipedia.datahippo.top`.

## Client (Svelte 5 + TypeScript + Vite + Tailwind v4, sql.js)

- Screens: login → villager list (searchable) → villager detail (profile, likes, gift log, "is this a good gift?" matcher, add gift) → Sync.
- Gift log entry: item + date + note.
- Sync: auto on app open + manual Sync button. Last-write-wins (single writer: phone only), server keeps versioned backups.
- No export/import file buttons (per decision) — IndexedDB + server backups are the safety net.
- Service worker: caches app shell + reference.db.gz.

## Decisions log

| Topic | Decision |
|---|---|
| Users | Multi-user, simple (wife + husband, password each, own gift logs) |
| Gift log | Item + date + note |
| Gift suggestion | Rule-based from spreadsheet (color/style match), no external API |
| Server language | Go (known well, single static binary docker image, modernc.org/sqlite) |
| Hosting | Subdomain `nookipedia.datahippo.top` via existing SWAG + Cloudflare cert |
| Client stack | Svelte 5 + TS + Vite + Tailwind v4 |
| Offline reference | Versioned `reference.db.gz` mirrored server↔client; server is auth + db server, client does all logic |
| Sync | Auto on open + manual button; versioned backups; phone is only writer |
| Phone storage | IndexedDB (no real filesystem on iOS); no export/import buttons |
| Images | Yes — all categories. Fetched at build time from dodo.ac; curated set stored as BLOBs in reference.db; bulk categories hotlinked at runtime (see Images section) |

## Images (verified 2026-08-13)

**Source**: spreadsheet has no images. Nookipedia's image CDN `dodo.ac` serves public PNGs (no auth, no API key). Works with a **browser User-Agent** only — plain bots get 403.

**URL construction** (MediaWiki hash path):
```
https://dodo.ac/np/images/{md5(filename)[0]}/{md5(filename)[:2]}/{urlencoded-filename}
```

**Filename patterns** (title-case name, spaces→underscores), tried in order:
1. `{Name}_NH_Icon.png` — works for most items (furniture, clothing, walls, fencing, tools, art, critters, posters, cards) — 2–55 KB
2. `{Name}_NH_Texture.png` — paintings/music/wallpapers (can be 100 KB–1 MB)
3. `{Name}_NH.png` — full images (can be big)
4. `{Name}_NH_Villager_Icon.png` — villager icons (417, 5–10 KB) ✓ verified

**Thumbnails**: dodo.ac serves MediaWiki thumbs — `.../thumb/{h0}/{h01}/{file}/128px-{file}` — **128px works; other sizes may 404** (only pre-generated sizes exist). Use 128px for oversized textures (e.g. `Acorn_Card_NH.png` 1 MB → 128px ~5 KB).

**Known gotchas**:
- Title-caser must preserve `K.K.` (plain `capitalize()` mangles it to `K.k.`)
- NPCs use inconsistent names (`Blathers_NH_2.png`) → wiki API fallback
- Gyroids/reactions/recipes have no images on their main pages → images live on `/Gallery` subpages → fallback: `list=search` for `{Name}/Gallery` + `generator=images`
- dodo.ac URLs for wiki pages: `https://nookipedia.com/w/api.php?action=query&...` (pageimages / generator=images) — open, no key

**Wiki API fallback** (when all filename patterns 404):
```
/api.php?action=query&prop=pageimages&piprop=thumbnail&pithumbsize=128&titles={Name}
/api.php?action=query&generator=images&titles={Name}&prop=imageinfo&iiprop=url
```

**Size budget & strategy** (≈28.4k data rows, ~15–20k unique items — do NOT fit in the phone db):
- **In reference.db as BLOBs** (curated set she looks up / collects): villagers (417 icons), special NPCs (~75), insects (~80), fish (~80), sea creatures (~40), fossils (~73), artwork (~70), gyroids (~190), music (~110), reactions, message cards — ~1.5–2.5k images ≈ **10–20 MB** (sql.js loads whole db into memory; keep under ~25 MB)
- **Hotlinked at runtime** from dodo.ac for bulk categories (furniture ~9k, clothing ~5.5k, etc.): browser UA is accepted, browser HTTP cache absorbs repeat views, graceful placeholder offline
- Build script produces a **hit-rate report** (per category: how many images resolved) so naming gaps are visible and fixable iteratively
- BLOBs render in client as `URL.createObjectURL` / data URLs; sql.js stores BLOBs as Uint8Array natively

## Next steps

1. **DONE — Go server built & tested locally** (2026-08-13): `server/` with auth (bcrypt + in-memory sessions, `ACNH_INIT_USERS` bootstrap), `GET/PUT /api/progress` (sqlite magic + `PRAGMA quick_check` validation, timestamped backups, 20 kept, versions endpoint), `/db/manifest.json` (sha256-hashed, memoized) + ranged downloads, SPA static serving with fallback placeholder. `CGO_ENABLED=0 go build` clean; full curl E2E passed. Deploy: `server/deploy/` Dockerfile + compose + SWAG conf.

2. **Client** — Svelte 5 + TS + Vite + Tailwind v4 + sql.js + pnpm (8 deps, scripts blocked except esbuild, 1-day cooldown, exact pins). PWA: login, villager list/detail, gift log, sync. Needs Node 24 + pnpm (corepack).

3. **Rebuild reference db** (`--thumb` option available) — deferred per user.


