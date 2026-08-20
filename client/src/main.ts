import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

// Register service worker for offline support — with explicit update check
// so iOS standalone PWAs actually pull new code on launch (ChatGPT was right).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', {
        updateViaCache: 'none',
      });
      // Check for a newer sw.js every launch, not just on browser's schedule
      reg.update().catch(() => {});
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    } catch {
      // SW registration failed — app still works, just no offline
    }
  });
  // New SW took over — reload once to run the new code (critical for iOS)
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

const app = mount(App, { target: document.getElementById('app')! });

export default app;
