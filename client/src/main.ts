import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

// Build marker injected by Vite (matches the SW_VERSION baked into sw.js).
declare const __SW_VERSION__: string;
const APP_VERSION: string =
  typeof __SW_VERSION__ !== 'undefined' ? __SW_VERSION__ : 'dev';

// Register service worker for offline support. Update detection is via byte
// change of sw.js (SW_VERSION bump at build) + the browser's normal update
// check on navigation (updateViaCache: none bypasses the HTTP cache).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
      // SW registration failed — app still works, just no offline
    });
  });

// Self-heal: when a NEWER SW takes control, reload ONCE so the device
// actually runs the new code instead of the stale app it was already using.
// Guarded by a per-version sessionStorage flag: at most one reload per
// deployed version, so this can never loop (the old aggressive update+reload
// looped on iOS — this keyed guard is the fix). Skipped when there was no
// previous controller (first-ever install) — nothing stale to replace, and it
// would just add a pointless extra load on first visit.
const hadController = !!navigator.serviceWorker.controller;
let reloadedFallback = false;
navigator.serviceWorker.addEventListener('controllerchange', () => {
  if (!hadController) return;
  try {
    const key = `acnh_reload_${APP_VERSION}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch {
    // sessionStorage unavailable — reload at most once per session
    if (reloadedFallback) return;
    reloadedFallback = true;
  }
  window.location.reload();
});
}

const app = mount(App, { target: document.getElementById('app')! });

export default app;