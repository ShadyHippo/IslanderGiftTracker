/**
 * About-popup state. Shown automatically on a device's first visit (must be
 * dismissed before use) and re-openable from buttons on the login page and
 * at the bottom of the villager list.
 *
 * Dismissal persists per device in localStorage — NOT server state — so it
 * comes back only if site data is cleared (acceptable: once more, then gone).
 */
const KEY = 'aboutDismissed';

export function aboutSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

const about = $state({ open: false });

export function getAbout() {
  return about;
}

export function openAbout() {
  about.open = true;
}

export function dismissAbout() {
  about.open = false;
  try {
    localStorage.setItem(KEY, '1');
  } catch {}
}

/** Auto-open on first visit; call once from App.svelte on mount. */
export function maybeAutoOpenAbout() {
  if (!aboutSeen()) about.open = true;
}
