.PHONY: build-db server-run server-build client-install client-dev client-build docker createuser

# Rebuild the reference database from the xlsx (+ dodo.ac images)
build-db:
	python3 scripts/build_db.py

# Run the Go server directly (dev)
server-run:
	cd server && go run .

# Build the Go server binary
server-build:
	cd server && CGO_ENABLED=0 go build -trimpath -o bin/acnh-server .

# Client — node/pnpm run ONLY inside containers (host stays clean).
# $$(...) = expanded by the shell at runtime; $(...) would be eaten by make.
CLIENT_MOUNTS = -u "$$(id -u):$$(id -g)" -e HOME=/tmp -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e GIT_HASH="$$(git rev-parse --short HEAD 2>/dev/null || echo dev)" \
	-v "$$PWD/client/.pnpm-store:/tmp/.local/share/pnpm" -v "$$PWD/client:/client" -w /client
CLIENT = docker run --rm $(CLIENT_MOUNTS) node:24-alpine sh -c "mkdir -p /tmp/pnpm && npm install -g --prefix /tmp/pnpm --no-fund --no-audit pnpm@11.21.0 >/dev/null 2>&1; export PATH=/tmp/pnpm/bin:$$PATH; pnpm --version;

# Docker auto-creates missing host bind dirs as root; force our ownership.
client-dirs:
	rm -rf client/.pnpm-store && mkdir -p client/.pnpm-store

# First-time: resolve dependencies + write pnpm-lock.yaml (exact pins via .npmrc)
client-setup: client-dirs
	$(CLIENT) pnpm add svelte sql.js && pnpm add -D vite @sveltejs/vite-plugin-svelte tailwindcss @tailwindcss/vite typescript svelte-check"

# Re-install from the committed lockfile (nothing moves without review)
client-install: client-dirs
	$(CLIENT) pnpm install --frozen-lockfile"

# Production build -> client/dist (served by the Go server)
client-build: client-dirs
	$(CLIENT) pnpm install --frozen-lockfile && pnpm build"

# Type-check Svelte/TS sources
client-check: client-dirs
	$(CLIENT) pnpm install --frozen-lockfile && pnpm check"

# Dev server with hot reload (--network host: /api + /db proxy to the Go server on :8080)
client-dev: client-dirs
	docker run --rm --network host $(CLIENT_MOUNTS) node:24-alpine sh -c "mkdir -p /tmp/pnpm && npm install -g --prefix /tmp/pnpm --no-fund --no-audit pnpm@11.21.0 >/dev/null 2>&1; export PATH=/tmp/pnpm/bin:$$PATH; pnpm --version; pnpm install --frozen-lockfile && pnpm dev"

# Docker image for deployment
docker:
	docker build --build-arg GIT_HASH=$$(git rev-parse --short HEAD 2>/dev/null || echo dev) -t acnh-server server/deploy

# Create/update a user (server must be built first)
# Usage: make createuser USER=alice PASS=secret123
createuser:
	@test -n "$(USER)" -a -n "$(PASS)" || (echo "Usage: make createuser USER=name PASS=pass" && exit 1)
	docker compose -f server/deploy/docker-compose.yml run --rm acnh -set-password "$(USER)" -password "$(PASS)"

# Categories that need images: everything the gift matcher shows + villager
# icons. Pass explicitly — the default (all sheets) balloons the db significantly.
REF_CATEGORIES = Accessories,Artwork,Bags,Bottoms,Ceiling Decor,Clothing Other,Dress-Up,Fencing,Fish,Floors,Fossils,Gyroids,Headwear,Housewares,Insects,Interior Structures,Miscellaneous,Music,Other,Rugs,Sea Creatures,Shoes,Socks,ToolsGoods,Tops,Umbrellas,Villagers,Wall-mounted,Wallpaper

# --- Local full-stack app (docker-compose.dev.yml) ---
dev-ref:
	mkdir -p dev-data/ref && python3 scripts/build_db.py --thumb 128 --categories "$(REF_CATEGORIES)" --out-dir dev-data/ref

# Production reference db — drop reference.vN.db.gz into server/deploy/ref and
# docker compose bind-mounts it read-only (see server/deploy/docker-compose.yml).
deploy-ref:
	mkdir -p server/deploy/ref && python3 scripts/build_db.py --thumb 128 --categories "$(REF_CATEGORIES)" --out-dir server/deploy/ref

app-up:
	docker compose -f docker-compose.dev.yml up -d --build

app-down:
	docker compose -f docker-compose.dev.yml down

app-logs:
	docker compose -f docker-compose.dev.yml logs -f

# --- Testing ---
smoke:
	./scripts/smoke.sh

# Browser test: pulls the Playwright image (~1.5 GB) on first run.
# Requires the app running: make app-up  (or make server-run)
e2e:
	docker run --rm --network host -u "$$(id -u):$$(id -g)" -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
		-v "$$PWD/tests/e2e:/e2e" -w /e2e mcr.microsoft.com/playwright:v1.62.1-noble \
		sh -c "[ -d node_modules ] || npm install --no-fund --no-audit --ignore-scripts >/dev/null 2>&1; node ui-smoke.js"
