# Islander Gift Tracker

[![Live app](https://img.shields.io/badge/live-acnh.datahippo.top-2ea44f)](https://acnh.datahippo.top/)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-timvandyke-FFDD00)](https://buymeacoffee.com/timvandyke)

A self-hosted gift tracker for Animal Crossing: New Horizons. A mobile-first
PWA (installable on iPhone) where you can look up what each villager likes —
colors, styles, favorite song — and keep a per-person gift log, fully offline,
synced to a home server.

## Quick deploy

```bash
git clone https://github.com/ShadyHippo/IslanderGiftTracker.git
cd IslanderGiftTracker
docker compose up -d --build
```

First build takes a while (downloads ~1 GB of item images from Nookipedia).
Everything is baked into the Docker image — no external files needed.

### Data directory

By default, data is stored in a Docker-managed volume (~700 MB). To use a
specific host directory instead (e.g. for backups or NAS storage):

1. Create the directory:

```bash
mkdir -p data
```

2. Start the service (data directory is `./data` by default):

```bash
docker compose up -d --build
```

The data directory contains:
- `ref/` — reference DB + images (~690 MB, read-only catalog)
- `progress/` — per-user gift logs + backups (<1 MB)
- `users.db` — user accounts (<1 MB)

### Add users

```bash
# Create or update a user
docker compose run --rm acnh -set-password alice -password mypassword
```

Or set initial users via environment variable in `docker-compose.yml`:

```yaml
environment:
  ACNH_INIT_USERS: "alice:pass1,bob:pass2"
```

`ACNH_INIT_USERS` only applies on first start (empty users table).
Use `-set-password` for subsequent user management.

### How it works

Two SQLite databases, mirrored server ↔ client:

- **`reference.db`** — readonly catalog: 39 sheets of game data (~28k rows)
  plus every available image. The server serves it, the client runs all queries
  locally via sql.js (SQLite compiled to WASM).
- **`progress.db`** — one writable db per user (gift log). Auto-saves to the
  server + IndexedDB. Server keeps timestamped backups.

## Dev setup

Prereqs: Python 3.12 (stdlib only), Go 1.23+, Docker.

```bash
make build-db        # parse xlsx, fetch images, write reference.db
make server-run      # Go server on :8080
make client-setup    # (once) containerized pnpm install
make client-build    # vite build -> client/dist
make client-dev      # vite dev server on :5173 with hot reload
make app-up          # full app in docker
make app-down        # stop
```

## Repo layout

```
res/                          source data (xlsx)
scripts/build_db.py           xlsx -> reference.db + images
server/                       Go: auth, progress, reference, static serving
server/deploy/                Dockerfile, docker-compose
client/                       Svelte 5 + TS + Vite + Tailwind + sql.js
Makefile                      build/run shortcuts
```
