# syntax=docker/dockerfile:1
# ── Stage 1: Go server ──────────────────────────────────────────────
FROM golang:1.25-alpine AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/acnh-server .

# ── Stage 2: Svelte client ─────────────────────────────────────────
FROM node:24-alpine AS client
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
WORKDIR /client
COPY client/package.json client/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY client/ .
ARG GIT_HASH=dev
RUN GIT_HASH=$GIT_HASH pnpm build

# ── Stage 3: Reference DB + images ─────────────────────────────────
FROM python:3.12-slim AS refdb
RUN apt-get update && apt-get install -y --no-install-recommends gzip imagemagick webp && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY scripts/ scripts/
COPY res/ res/
# Cache the image downloads across rebuilds (~1 GB of PNGs from Nookipedia)
RUN --mount=type=cache,target=/build/cache python3 scripts/build_db.py --out-dir /out/ref

# ── Stage 4: Final image ───────────────────────────────────────────
FROM alpine:3.20
RUN adduser -D -H -u 10001 acnh && apk add --no-cache python3 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -fsS http://127.0.0.1:8080/health >/dev/null || exit 1
COPY --from=server /out/acnh-server /usr/local/bin/acnh-server
COPY --from=client /client/dist /app/client/dist
COPY --from=refdb /out/ref /app/ref
RUN mkdir -p /data && chown -R acnh:acnh /app /data
USER acnh
ENV DATA_DIR=/data \
    REF_DIR=/app/ref \
    STATIC_DIR=/app/client/dist \
    PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/acnh-server"]
