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
tools/build_db.py          # xlsx -> reference.db -> reference.v{N}.db.gz (+ images)
server/                    # Go: auth, progress/ref endpoints, static serving
server/deploy/             # Dockerfile, docker-compose, SWAG site conf
client/                    # (next) Svelte 5 + TS + Vite + Tailwind v4 + sql.js
plan.md                    # full plan, schemas, decisions log
agent.md                   # agent quick-start: stack, conventions, avoids
Makefile                   # build/run shortcuts
```

## Quickstart (dev)

Prereqs: Python 3.12 (stdlib only), Go 1.23+, Node 24 + pnpm (for the client).

```bash
make build-db        # parse res/xlsx, fetch images from dodo.ac, write reference.db + .gz
make server-run      # go run ./server — API on :8080, serves client/dist if built
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

## Source data

`res/Data Spreadsheet for Animal Crossing New Horizons.xlsx` — the community
spreadsheet (from `~/Downloads`, 2026-08-12; the source it derives from is
linked in its "Read Me" sheet). It contains **no images** — those are fetched
at build time from dodo.ac. To update: replace the xlsx, `make build-db`,
bump the version constant in `tools/build_db.py`, publish the new `.db.gz`.

## Status

- ✅ Reference db builder (master 807 MB; `--thumb N` option for a slimmer build)
- ✅ Go server: auth + rate limiting, progress uploads with versioned backups,
  reference manifest/download, static serving, unit tests, docker + SWAG conf
- ⏳ PWA client (next)
- ⏳ Deployment to the home server

See `plan.md` for the full plan and decisions log.
