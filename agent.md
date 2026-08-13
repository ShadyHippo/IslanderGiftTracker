# agent.md — ACNH Gift Tracker

Read `plan.md` for the full plan, decisions log, and schemas. This file is the quick-start for agents: stack, conventions, and hard avoids.

## Project

PWA for iPhone to track Animal Crossing: New Horizons gift data: lookup what villagers like, log gifts given, sync per-user progress db to a home server. Source data: `Data Spreadsheet for Animal Crossing New Horizons.xlsx` (no images; text only).

## Locked stack

- **Server**: Go, single static binary docker image. SQLite via `modernc.org/sqlite` (pure Go, no cgo). Auth = bcrypt + session cookie, minimal (wife + husband, password each). No password-change UI — admin reset via on-server flag: `acnh-server -set-password <user> -password <new>`. Login rate-limited per-IP (failed attempts, 10/15min default, XFF-aware, 429). Restore = manual file ops only (versions endpoint lists backups).
- **Client**: Svelte 5 + TypeScript + Vite + Tailwind CSS v4. `sql.js` (SQLite → WASM) for in-browser sqlite.
- **Phone storage**: IndexedDB (byte blob for progress.db) + Cache API (service worker) for the app shell and `reference.db.gz`. No real filesystem usage.
- **Two databases**:
  - `reference.db` — readonly, versioned artifact rebuilt from the xlsx (`reference.v{N}.db.gz`). Server serves it; client does all query logic locally.
  - `progress.db` — writable, one per user: `gifts(id, villager, item, date, note, created_at)` + `meta(key, value)`.
- **Hosting**: docker on home server, reverse-proxied by SWAG (nginx) at `nookipedia.datahippo.top` (Cloudflare/Let's Encrypt cert — required for iOS PWA install).
- **Sync**: auto on app open + manual Sync button. Last-write-wins (phone is the only writer). Server keeps timestamped backups before each replace.

## Conventions

- Python 3.12 stdlib only for tooling (`tools/build_db.py` must not need pip packages — the machine has none installed).
- xlsx parsing = `zipfile` + `xml.etree.ElementTree` (xlsx is a zip of XML; sheet names in `xl/workbook.xml`, strings in `xl/sharedStrings.xml`, cells `<c t="s"><v>idx</v></c>`).
- Empty cells can be absent `<c/>` or `<v/>` with `None` text — handle both.
- Agent must be able to run the build and rebuild dbs when the spreadsheet updates; version numbers bump in the manifest.
- Keep everything dockerizable; no host-specific paths baked in.
- Mobile-first UI; target modern iOS Safari + desktop Chrome/Safari only.

## Explicitly avoid

- **No external APIs** for game data (Nookipedia API needs a key; spreadsheet already has canonical fav styles/colors).
- **No plain JavaScript** in the client — TypeScript only (user explicitly ruled out vanilla JS).
- **No go-app / Go WASM UI** — ruled out; UI is Svelte.
- **No React** — user chose Svelte (most readable for a non-frontend person).
- **No monkeycache** (dotnet JSON blob offline store) — replaced by the second sqlite db (progress.db).
- **No real filesystem / File System Access API on iOS** — unsupported in Safari; IndexedDB instead. No export/import file buttons (user chose IndexedDB-only).
- **No legacy browser support, no polyfills.**
- **No images in v1** — replaced: images ARE in scope, fetched at build time from dodo.ac (see Images section in plan.md).
- **No multi-device write merge** — phone is the only writer; don't add row-level sync complexity.
- **No dotnet server** — Go.

## Images (build-time fetching, see plan.md "Images" section)

- Source spreadsheet has NO images (no `xl/media/`). Fetch from dodo.ac at build time.
- URL = `dodo.ac/np/images/{md5(fn)[0]}/{md5(fn)[:2]}/{fn}`; **browser User-Agent required** (403 otherwise).
- Filenames: `{TitleCase}_NH_Icon.png` first, then `_NH_Texture.png`, `_NH.png`, `_NH_Villager_Icon.png`. Keep `K.K.` intact in title-casing.
- Thumbs: `dodo.ac/np/images/thumb/{h}/{hh}/{fn}/128px-{fn}` — only 128px is reliable.
- Fallback: Nookipedia MediaWiki API (`nookipedia.com/w/api.php`, no key): `prop=pageimages` or `generator=images`; gyroids/reactions/recipes live in `/Gallery` subpages.
- In-db BLOBs for **everything** (master-first, user decision): single `images(category, name, data, url)` table. Measure size after build; pare only if actually needed.
- Build script must print per-category hit-rate.

## Repo layout (planned)

```
plan.md
agent.md
Data Spreadsheet for Animal Crossing New Horizons.xlsx
tools/build_db.py          # xlsx -> reference.db -> reference.v{N}.db.gz
server/                    # Go: auth, db endpoints, static serving, Dockerfile
client/                    # Svelte 5 + TS + Vite + Tailwind v4 + sql.js
```

## Status

Reference db built (master 807 MB, `--thumb` option available). Server complete & tested (2026-08-13): auth + rate limiting + `-set-password` admin flag, progress get/put with versioned backups + sqlite validation, reference manifest/download, SPA static serving, unit tests passing (`go test ./...`), Dockerfile/compose/SWAG conf. Next: PWA client.
