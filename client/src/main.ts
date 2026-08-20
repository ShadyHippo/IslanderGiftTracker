import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

// Register service worker for offline support. Update check is via byte
// change of sw.js (SW_VERSION bump at build) + browser's normal update on
// navigation. No forced reload here — that was boot-looping on iOS.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
      // SW registration failed — app still works, just no offline
    });
  });
}

const app = mount(App, { target: document.getElementById('app')! });

export default app;
