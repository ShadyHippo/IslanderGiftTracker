/**
 * App theme state. Follows the OS theme (prefers-color-scheme) by default;
 * the header sun/moon switch sets an explicit per-device override, stored in
 * localStorage — NOT server state, mirroring how the About-popup dismissal
 * works.
 *
 * index.html carries a tiny inline copy of the first-paint logic so the right
 * theme is applied before the bundle boots (no flash of light for dark-mode
 * users); this module owns it afterwards, including live OS theme changes
 * while no override is set.
 */
const KEY = '@theme';
const LIGHT_THEME_COLOR = '#166534';
const DARK_THEME_COLOR = '#000000';

function readOverride(): 'light' | 'dark' | null {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {}
  return null;
}

const mql = window.matchMedia('(prefers-color-scheme: dark)');

/**
 * Live state object (returned by reference, like net.svelte.ts): `override`
 * is what the user explicitly chose or null to keep following the OS;
 * `systemDark` tracks prefers-color-scheme while no override is set.
 * Components compute their own derived from these.
 */
const theme = $state<{ override: 'light' | 'dark' | null; systemDark: boolean }>({
  override: readOverride(),
  systemDark: mql.matches,
});

export function getTheme() {
  return theme;
}

function sync() {
  const dark = theme.override === 'dark' || (theme.override === null && theme.systemDark);
  document.documentElement.classList.toggle('dark', dark);
  // Native controls (scrollbars, form fields) should follow the override too,
  // not just the OS.
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  // Flip both theme-color metas so PWA chrome matches regardless of which
  // media query currently wins.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }
}

sync();

mql.addEventListener('change', (e) => {
  theme.systemDark = e.matches;
  sync();
});

/** Flip light/dark; the explicit choice is remembered on this device. */
export function toggleTheme() {
  const dark = theme.override === 'dark' || (theme.override === null && theme.systemDark);
  theme.override = dark ? 'light' : 'dark';
  try {
    localStorage.setItem(KEY, theme.override);
  } catch {}
  sync();
}