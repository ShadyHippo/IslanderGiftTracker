import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

// Register service worker for offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration failed — app still works, just no offline
    });
  });
}

const app = mount(App, { target: document.getElementById('app')! });

export default app;
