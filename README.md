# ACNH Gift Tracker

A self-hosted tracker for Animal Crossing: New Horizons. A mobile-first PWA
(installable on iPhone) where you can look up what each villager likes — colors,
styles, favorite song — and keep a per-person gift log, fully offline, synced to
a home server.

Built for a household: the wife tracks gifts from her phone; the server stores
per-user progress with versioned backups. No external APIs, no accounts beyond
a simple username/password.

## How it works

Two SQLite databases, mirrored server ↔ client:

- **`reference.db`** — readonly catalog: 39 sheets of game data (~28k rows:
  furniture, clothing, critters, fossils, artwork, recipes, villagers…) plus
  every available image, fetched at build time from dodo.ac (Nookipedia's CDN).
  Versioned (`reference.vN.db.gz`); the server serves it, the client runs all
  queries locally via sql.js (SQLite compiled to WASM).
- **`progress.db`** — one writable db per user (her gift log). Lives in the
  browser's IndexedDB; auto-uploads to the server on app open + a manual Sync
  button. The server keeps timestamped backups before every replace, so data
  is never lost.

The server is deliberately dumb: auth, serve reference dbs, accept progress
uploads with backups, serve the PWA. All logic lives in the client.

## Repo layout

```
res/                       # source data (inputs only)
  Data Spreadsheet for Animal Crossing New Horizons.xlsx
scripts/build_db.py          # xlsx -> reference.db -> reference.v{N}.db.gz (+ images)
scripts/smoke.sh              # curl E2E against a fresh server instance
server/                    # Go: auth, progress/ref endpoints, static serving
server/deploy/             # Dockerfile, docker-compose, SWAG site conf
client/                    # (next) Svelte 5 + TS + Vite + Tailwind v4 + sql.js
plan.md                    # full plan, schemas, decisions log
agent.md                   # agent quick-start: stack, conventions, avoids
Makefile                   # build/run shortcuts
```

## Quickstart (dev)

Prereqs: Python 3.12 (stdlib only), Go 1.23+, Docker (for the client).

Node/pnpm only ever run inside containers — the host stays clean (see `agent.md`
for the supply-chain reasoning and pnpm guardrails).

```bash
make build-db        # parse res/xlsx, fetch images from dodo.ac, write reference.db + .gz
make server-run      # go run ./server — API on :8080, serves client/dist if built
make client-setup    # (once) containerized pnpm install — writes pnpm-lock.yaml
make client-build    # containerized vite build -> client/dist
make client-check    # containerized svelte-check (TS + Svelte type checking)
make client-dev      # containerized vite dev server (:5173) with hot reload
cd server && go test ./...   # unit + integration tests
```

Server config is env-based: `PORT`, `DATA_DIR`, `ACNH_INIT_USERS`
(`wife:pw,hippo:pw` on first run), `SECURE_COOKIES`, `ACNH_LOGIN_RATE_MAX`.
Admin password reset (no self-service change): `acnh-server -set-password <user> -password <new>`.

## Deploy

`server/deploy/` has a Dockerfile + compose. The server runs in docker on the
home box, reverse-proxied by SWAG (nginx) at `nookipedia.datahippo.top`
(HTTPS is required for iOS PWA install). Publish reference dbs by dropping
`reference.vN.db.gz` into the compose-mounted `ref/` dir; the manifest picks
them up automatically.

## Running & testing

Everything runs via `make` (see `Makefile`). Test login: `wife` / `devpass` (from `docker-compose.dev.yml`).

```bash
# 1. Build the client (containerized node; host stays clean)
make client-setup      # once: resolve deps, writes pnpm-lock.yaml
make client-build

# 2. Small reference db for dev (a few images per category; real one is ~750 MB)
make dev-ref

# 3. Full app in docker: http://localhost:8080
make app-up
make app-logs          # follow logs
make app-down          # stop (data persists in dev-data/)

# 4. Tests
cd server && go test ./...   # Go unit + integration tests
make smoke                  # curl E2E against a fresh server instance
make e2e                    # headless Chromium UI smoke (pulls ~1.5 GB image once)
```

`make server-run` runs the Go server natively instead (serves `client/dist`),
and `make client-dev` runs the Vite dev server in a container on :5173 with
hot reload, proxying `/api` + `/db` to the Go server on :8080.

## Source data

`res/Data Spreadsheet for Animal Crossing New Horizons.xlsx` — the community
spreadsheet (from `~/Downloads`, 2026-08-12; the source it derives from is
linked in its "Read Me" sheet). It contains **no images** — those are fetched
at build time from dodo.ac. To update: replace the xlsx, `make build-db`,
bump the version constant in `scripts/build_db.py`, publish the new `.db.gz`.

## Status

- ✅ Reference db builder (master 807 MB; `--thumb N` option for a slimmer build)
- ✅ Go server: auth + rate limiting, progress uploads with versioned backups,
  reference manifest/download, static serving, unit tests, docker + SWAG conf
- ✅ PWA client scaffolded & building (2026-08-13): Svelte 5 + TS + Vite 8 + Tailwind v4 + sql.js, built entirely in containers (`make client-*`); 8 deps exact-pinned; trust-policy exception for chokidar@4.0.3 (manually vetted); TS pinned 5.x (svelte-check incompatible with TS 7). Server serves the built client; svelte-check clean.
- ⏳ Deployment to the home server

See `plan.md` for the full plan and decisions log.
