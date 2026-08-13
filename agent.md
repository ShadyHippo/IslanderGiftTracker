# agent.md — ACNH Gift Tracker

Read `plan.md` for the full plan, decisions log, and schemas. This file is the quick-start for agents: stack, conventions, and hard avoids.

## Project

PWA for iPhone to track Animal Crossing: New Horizons gift data: lookup what villagers like, log gifts given, sync per-user progress db to a home server. Source data: `res/Data Spreadsheet for Animal Crossing New Horizons.xlsx` (no images; text only — images fetched from dodo.ac at build time).

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

- Python 3.12 stdlib only for tooling (`scripts/build_db.py` must not need pip packages — the machine has none installed).
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
- **No hotlinking at runtime for the reference db** — images ship in the db as BLOBs (master-first, user decision); see Images section below.
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

## Repo layout

```
README.md                  # project overview + quickstart
plan.md                    # full plan, schemas, decisions log
agent.md                   # this file
Makefile
res/                       # source data (inputs only)
  Data Spreadsheet for Animal Crossing New Horizons.xlsx
scripts/build_db.py          # xlsx -> reference.db -> reference.v{N}.db.gz
scripts/smoke.sh              # curl E2E
server/                    # Go: auth, db endpoints, static serving, deploy/
client/                    # (next) Svelte 5 + TS + Vite + Tailwind v4 + sql.js
```

## Tools & when to use them

All via `make` (root Makefile) + `go test`. **Node/pnpm only ever run inside containers** (`make client-*`) — never on the host; that's a hard constraint from the user (npm supply-chain risk).

| Command | What it does | Use when |
|---|---|---|
| `make server-run` | `go run ./server` natively on :8080 | Fast server iteration; serves `client/dist` if built |
| `make client-build` | containerized `vite build` → `client/dist` | After client edits (TS/Svelte compile check) |
| `make client-check` | containerized `svelte-check` | Type-check Svelte/TS (0 errors expected) |
| `make client-dev` | containerized vite dev server :5173, hot reload, proxies `/api`+`/db` to Go :8080 | UI development loop |
| `make app-up` / `app-down` / `app-logs` | full app in docker (`docker-compose.dev.yml`) → localhost:8080 | Whole-stack verification; test login `wife`/`devpass` |
| `make dev-ref` | builds small dev reference db → `dev-data/ref/` (3.6 MB gz) | After db-build script changes; the real 750 MB db is deploy-only |
| `make build-db` | full reference db build (xlsx + dodo.ac images) → repo root | Only for producing the real deploy artifact |
| `cd server && go test ./...` | Go unit + integration tests | After any server code change — must be green |
| `make smoke` | curl E2E (13 checks: auth, upload validation, backups, manifest, 404s) | After server changes; fast, no deps |
| `make e2e` | headless Chromium via playwright container; screenshot → `tests/e2e/smoke.png` | UI verification (the way to "see" the client); requires app running; first run pulls ~1.5 GB image |
| `acnh-server -set-password <u> -password <p>` | admin password reset (server binary/container) | User forgot password; no self-service path |

**Testing workflow:** server changes → `go test` + `make smoke`; client changes → `make client-build` (and `client-check`); whole app → `make app-up` then `make e2e` (+ manual browser).

**Gotchas (cost real time, don't repeat):**
- `docker-compose.dev.yml` runs the container as host uid (`user: "1000:1000"`) because `/data` is a host bind mount — without it, the container's uid 10001 can't write. Docker auto-creates missing bind dirs as **root** — pre-create them (`client-dirs`, `dev-ref` do this).
- Dockerfile must use `golang:1.25-alpine` — go.mod requires go ≥ 1.25 (modernc.org/sqlite).
- `build_db.py` has `--out-dir`, `--thumb N`, `--limit N`, `--no-images`; `--thumb 128` + `--limit 5` is the dev-size db.
- Makefile client targets: `$$PWD`/`$$(id -u)` are shell-expanded on purpose; `$(...)` single-dollar gets eaten by make.
- pnpm: exact pins live in `client/package.json` + `pnpm-lock.yaml` (commit both); installs are `--frozen-lockfile`; `chokidar@4.0.3` is a documented trust-policy exception; TypeScript must stay 5.x (svelte-check crashes on TS 7).

## Status

Reference db built (master 807 MB, `--thumb` option available). Server complete & tested (2026-08-13): auth + rate limiting + `-set-password` admin flag, progress get/put with versioned backups + sqlite validation, reference manifest/download, SPA static serving, unit tests passing (`go test ./...`), Dockerfile/compose/SWAG conf. Client scaffolded & building in containers (`make client-setup/build/check/dev` — node/pnpm never on the host): Svelte 5 + TS + Vite 8 + Tailwind v4 + sql.js, 8 deps exact-pinned, chokidar@4.0.3 trust-policy exception (vetted), TS 5.x (svelte-check vs TS 7). Server serves built client.

Testing/launch tooling (2026-08-13): `make smoke` (curl E2E, 13 checks), `make app-up/app-down/app-logs` (full app in docker, `docker-compose.dev.yml`, test login wife/devpass), `make dev-ref` (small dev reference db), `make e2e` (headless Chromium via playwright container, screenshot to tests/e2e/). Next: PWA features (login, villager views, gift log, sync, service worker).
