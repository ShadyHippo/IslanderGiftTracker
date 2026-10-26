# Islander Gift Tracker

[![Live app](https://img.shields.io/badge/live-acnh.datahippo.top-2ea44f)](https://acnh.datahippo.top/)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-timvandyke-FFDD00)](https://buymeacoffee.com/timvandyke)

A self-hosted **gift tracker** for Animal Crossing: New Horizons. For each of
the 417 villagers it works out which **furniture and clothing** they'll love —
matched against their favorite colors and styles — and gives you a per-villager
checklist of what you've already given them.

It is deliberately *not* a wiki or a catalog browser: there's no encyclopedia,
no turnip prices, no critter trackers. Just "what should I gift Ace?" and "what
have I already given Ace?".

- **Gift matching** — every furniture & clothing item scored against the
  villager's favorite colors and styles; only ★ perfect matches are surfaced.
- **Gift log** — tap to mark an item gifted; syncs across your devices.
- **Villager tags** — favorites and who's currently on your island.
- **Offline-first PWA** — installable on your phone; after a one-time data
  download everything (including all images) works with no internet.
- **Multi-user** — each account gets its own private gift log on the server.

## Quick deploy

```bash
git clone https://github.com/ShadyHippo/IslanderGiftTracker.git
cd IslanderGiftTracker
docker compose up -d --build
```

The first build downloads ~1 GB of source images from Nookipedia and converts
them to WebP, then everything is baked into the image — no external services or
files needed at runtime. The container serves HTTP on port 8080, published to
`127.0.0.1:2109` by the default `docker-compose.yml` — loopback only, so the
origin is not reachable from the LAN or the internet behind your proxy's back.
There are no default accounts: create one explicitly (see below).

## Hosting & authentication

One container does everything: Go API + static PWA + reference data. All state
lives in a single directory mounted at `/data` (bind-mounted to `./data` on the
host by default):

```
data/
├── users.db      # accounts (< 1 MB)
├── progress/     # one SQLite gift log per user (no other copies)
└── ...           # (reference data ships inside the image, not in /data)
```

Which login door the app exposes is chosen by **`AUTH_MODE`**:

| `AUTH_MODE` | Who signs in | Best for |
|---|---|---|
| `password` *(default)* | Username + password accounts you create | Family/friends on a home server or LAN |
| `google` | Google sign-in only; anyone with a verified Google email gets an account automatically on first sign-in | Public deployments |

### Password mode (default)

```bash
# Create or update a user
docker compose run --rm acnh -set-password alice -password mypassword
```

Or seed initial accounts on first start only (empty users table):

```yaml
environment:
  ACNH_INIT_USERS: "alice:pass1,bob:pass2"
```

Works over plain HTTP, so it's fine behind a LAN IP with no TLS setup. Failed
logins are rate-limited per IP (the client address is taken from the header your
edge proxy *overwrites* — `CF-Connecting-IP` or `X-Real-IP` — never from
`X-Forwarded-For`, which clients can pad).

### Security notes

- Every response carries `Content-Security-Policy` (same-origin scripts, styles,
  images; `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` and a `Referrer-Policy`; HSTS is added when
  `SECURE_COOKIES=true`. If you edit the inline theme script in
  `client/index.html`, regenerate the hash constant in `server/main.go`
  (the command is in the comment above it) or that script will be blocked.
- Credentials and gift logs are per-user and sent with `Cache-Control: no-store`.
- The image bundle and reference DB are public on purpose (the PWA installs
  before sign-in); everything account-scoped requires a session.
- Run `govulncheck ./...` from `server/` after dependency bumps, and keep the
  `golang:`/`alpine:` base images on a supported release.

### Caching on a small uplink

Almost all bytes are static, so the goal is to serve them from the edge and
never from the origin twice. What the app already does:

| Path | Policy | Why |
|---|---|---|
| `/assets/*` | `immutable`, 1 year | Vite content-hashed filenames |
| `/img/<cat>/<file>` | `immutable`, 1 year | image files never change |
| `/img/images.zip?h=<hash>` | 7 days + 30 days stale-while-revalidate | ~120 MB bundle, hash-pinned URL |
| `/db/reference.vN.db.gz?h=<sha256>` | `immutable`, 1 year | URL pins the exact bytes |
| `/db/manifest.json` | 60 s + ETag + SWR | freshness oracle, tiny |
| `/img/manifest.json` | 5 min + ETag + SWR | ~900 KB, read on every boot |
| `/api/*` | `no-store` | per-user data |
| `index.html`, `sw.js` | `no-cache` (revalidate) | must pick up deploys |

Two things that only the Cloudflare dashboard can do, because Cloudflare does
not cache **JSON or `.wasm`** by default regardless of headers:

1. **Caching → Cache Rules**, in this order:
   - *Bypass cache* when `http.request.uri.path` starts with `/api/`
   - *Eligible for cache* when the path starts with `/img/`, `/db/` or
     `/assets/` — leave Edge TTL at "respect origin headers"
2. **Caching → Configuration → Browser Cache TTL** → *Respect Existing Headers*
   (the default rewrites `Cache-Control` to ~4 h, which caps the immutable
   assets).

Optional: *Tiered Cache* keeps the bundle at more edges; *Cache Reserve* (paid)
keeps it on disk for months. Both matter mostly for the one 120 MB file.

### Google mode

Set these instead of `ACNH_INIT_USERS`:

```yaml
environment:
  AUTH_MODE: "google"
  GOOGLE_CLIENT_ID: "xxxx.apps.googleusercontent.com"
  GOOGLE_CLIENT_SECRET: "GOCSPX-..."
  SECURE_COOKIES: "true"
```

Setup: in [Google Cloud Console](https://console.cloud.google.com/) create an
OAuth consent screen (type *External*, publish to **Production** — only basic
scopes are used, so no verification queue applies) and a **Web application**
OAuth client whose authorized redirect URI is exactly
`https://YOUR-DOMAIN/api/auth/google/callback`.

Behavior in this mode:

- No passwords exist anywhere; password login routes aren't even registered.
- Signup is open: first sign-in *is* account creation (an existing account
  with the same verified email gets linked instead).
- Users can delete themselves — About → *Delete my account* removes their
  identity and gift log immediately.
- Google rejects non-HTTPS origins, so this mode needs real TLS in front
  (any reverse proxy or tunnel works).

### Other environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port the server listens on inside the container |
| `DATA_DIR` | `/data` | Accounts + gift logs |
| `REF_DIR` | `$DATA_DIR/ref` | Reference DB + image tree (baked into the image) |
| `STATIC_DIR` | `../client/dist` | Built PWA assets |
| `SECURE_COOKIES` | `false` | Marks session cookies `Secure` (+ sends HSTS); set `true` behind HTTPS |
| `GOOGLE_REDIRECT_URL` | derived from request | Override only if the server can't see its own public host |

## Where the data comes from

Two kinds of SQLite, mirrored between server and client:

- **`reference.db`** (read-only catalog) — built at image-build time from a
  community spreadsheet (40 sheets, ~28k item rows) cross-referenced with
  Nookipedia for villager profiles, house photos, and per-item images. The
  server serves it gzipped; the client loads it into sql.js (SQLite compiled
  to WASM) and answers every query locally — that's what makes search instant
  and full offline mode possible. Alongside it sits an image tree of ~21k
  WebP files (~900 MB).
- **`progress.db`** (one writable db per user) — just the gift log and villager
  tags, a few KB. Auto-saves to the server and IndexedDB; one copy per user,
  no extra server-side backup copies.

## Dev setup

Prereqs: Python 3.12 (stdlib only), Go 1.23+, Docker.

```bash
make build-db        # parse xlsx, fetch images, write reference.db
make dev-ref         # small trimmed reference db for fast local dev
make server-run      # Go server on :8080
make client-setup    # (once) containerized pnpm install
make client-build    # vite build -> client/dist
make client-check    # svelte-check in a container
make client-dev      # vite dev server on :5173 with hot reload
make app-up          # full app in docker (dev compose)
make app-down        # stop
make smoke           # curl-level end-to-end checks
make e2e             # Playwright browser smoke test (needs app running)
make createuser USER=alice PASS=secret123   # convenience wrapper
```

## Repo layout

```
res/                          source data (xlsx)
scripts/build_db.py           xlsx -> reference.db + webp image tree
server/                       Go: auth (both modes), progress sync, static serving
server/deploy/                Dockerfile, docker-compose examples
client/                       Svelte 5 + TS + Vite + Tailwind + sql.js
tests/e2e/                    Playwright UI smoke test
Makefile                      build/run/test shortcuts
```

## Fan project

This is a non-commercial fan project. Animal Crossing: New Horizons and all
related assets are © Nintendo. This app is not affiliated with or endorsed by
Nintendo. Game data and images are fetched from community sources (Nookipedia)
at build time; nothing is redistributed in this repository.

## License

[MIT](LICENSE) © 2026 ShadyHippo
