# AGENTS.md

Self-hosted ACNH gift-tracker PWA. Go server (`server/`, native) serves the
SPA from `client/dist` plus a sql.js reference database (`/db/*`); the Svelte
client keeps all data client-side in IndexedDB. Builds/tests run in containers
via Makefile targets (`make dev-ref`, `make client-build`, `make client-check`,
`make e2e`, `make app-up`). No npm tooling on the host; Go/Python run natively.

## Pristine full-data backup — do NOT trim or delete

- Location: **`pristine/reference.v1.db`** (gitignored; local disk only).
- Captured 2026-08-17 from the then-current dev build (`reference.db`, 662 MB,
  `PRAGMA quick_check` = ok). This is the **maximum dataset the project will
  ever have**: every item/villager, all images, all house photos/items.
- It is the restore point for anything pared out later. When future builds drop
  tables/columns/filters, never modify this copy to match — treat it as
  read-only history. If a decision reverts (e.g. re-add a category, restore
  full-size images, un-trim the `items` table), the data lives here.
- Serveable compressed snapshot: `dev-data/ref/reference.v1.db.gz` (same era,
  620 MB) if a byte-for-byte served artifact is ever needed.
- Restoring: `cp pristine/reference.v1.db dev-data/ref/reference.db` (then
  re-gzip to `reference.v1.db.gz`), or rebuild with `make dev-ref` and ignore
  the trimmed config. Verify with `PRAGMA quick_check` after any restore.

## Pristine images backup — the manually-corrected dev build (do NOT delete)

- Location: **`pristine/images/`** (gitignored; local disk only). Contains
  `reference.db` + the full `img/` tree it references.
- Captured 2026-08-19 from the good dev build being served (`reference.db` =
  `reference.v12.db.gz`, `PRAGMA quick_check` = ok). This is the **only copy
  with correct per-item house images**: the 92 `house_item_images` rows that a
  bot manually repointed (Ace/Shino/Ione/Marlo/Raymond/Pietro/Roswell/etc.) to
  the right variant images, plus color data. All 4777 image URLs resolve to
  files on disk (verified).
- It is the restore point for `dev-data/ref/reference.db` while the reproducible
  build pipeline is being fixed. `scripts/build_db.py` now reproduces these
  images: `house_overrides.json` drives both the variant colors AND the exact
  per-villager variant icon (via `fetch_variant_icon`), applied accent-
  insensitively so accented cargo names (`Viché`/`Renée`) match override keys.
  This snapshot remains the reference to diff a fresh build against, and the
  restore point if a future decision reverts any trimming.
- Restoring: `cp pristine/images/reference.db dev-data/ref/reference.db` and
  `cp -a pristine/images/img dev-data/ref/`. Verify with `PRAGMA quick_check`
  and spot-check `house_item_images` URLs resolve.

## Reference db pipeline (scripts/build_db.py)

Builds `dev-data/ref/reference.db` from the xlsx + Nookipedia (item icons,
nh_house per-villager colors/photos, per-villager exact item icons). Stage
`[2c/4]` writes house data; `[3/4]` fetches images with a disk cache under
`cache/`. Builds are atomic (.tmp + rename). `dev-data/` (progress, users,
ref) is runtime data — never commit.