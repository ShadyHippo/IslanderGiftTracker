.PHONY: build-db server server-run server-build client-install client-dev client-build docker

# Rebuild the reference database from the xlsx (+ dodo.ac images)
build-db:
	python3 tools/build_db.py

# Run the Go server directly (dev)
server-run:
	cd server && go run .

# Build the Go server binary
server-build:
	cd server && CGO_ENABLED=0 go build -trimpath -o bin/acnh-server .

# Client (pnpm) — see client/ for the security config
client-install:
	cd client && pnpm install --frozen-lockfile

client-dev:
	cd client && pnpm dev

client-build:
	cd client && pnpm build

# Docker image for deployment
docker:
	docker build -t acnh-server server/deploy
