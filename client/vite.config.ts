import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
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
