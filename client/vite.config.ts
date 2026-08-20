// @ts-nocheck — uses node:child_process without @types/node
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

function shortHash(): string {
  for (const cwd of [undefined, '..']) {
    try {
      return execSync('git rev-parse --short HEAD', {
        cwd: cwd as string | undefined,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {}
  }
  return (process.env.GIT_HASH ?? '').slice(0, 7) || 'dev';
}

const BUILD_HASH = shortHash();
const BUILD_TIME =
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(',', '')
    .replace(/\//g, '-') + ' ET';

// SW_VERSION must differ on EVERY deploy so the browser re-checks sw.js and
// applies updates. .git is excluded from the Docker build context, so the hash
// falls back to 'dev' there — append the build timestamp so it always changes.
// When GIT_HASH reaches the build (e.g. `make docker` or GIT_HASH=...), the
// real commit shows up front for at-a-glance verification.
const SW_VERSION = `${BUILD_HASH} · ${BUILD_TIME}`;

export default defineConfig({
  define: {
    __BUILD_HASH__: JSON.stringify(BUILD_HASH),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [
    svelte(),
    tailwindcss(),
    {
      name: 'sw-version',
      closeBundle() {
        try {
          const { readFileSync, writeFileSync } = require('node:fs');
          const { join } = require('node:path');
          const swPath = join(__dirname, 'dist', 'sw.js');
          let sw = readFileSync(swPath, 'utf8');
          sw = sw.replace('__SW_VERSION__', SW_VERSION);
          writeFileSync(swPath, sw);
        } catch {}
      },
    },
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // Dev: client in container, Go API on the host.
      '/api': 'http://localhost:8080',
      '/db': 'http://localhost:8080',
    },
  },
});
