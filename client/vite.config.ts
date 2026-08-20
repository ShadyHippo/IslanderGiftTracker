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
const BUILD_TIME = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  define: {
    __BUILD_HASH__: JSON.stringify(BUILD_HASH),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [svelte(), tailwindcss()],
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
