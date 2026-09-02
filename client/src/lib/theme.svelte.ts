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
const DARK_THEME_COLOR = '#052e16';

function readOverride(): 'light' | 'dark' | null {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {}
  return null;
}

const mql = window.matchMedia('(prefers-color-scheme: dark)');

/** What the user has explicitly chosen, or null to keep following the OS. */
const override = $state<{ value: 'light' | 'dark' | null }>({ value: readOverride() });
let systemDark = $state(mql.matches);

const effective = $derived(override.value ?? (systemDark ? 'dark' : 'light'));

function sync() {
  const dark = effective === 'dark';
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
  systemDark = e.matches;
  sync();
});

export function getTheme() {
  return { override: override.value, effective };
}

/** Flip light/dark; the explicit choice is remembered on this device. */
export function toggleTheme() {
  override.value = effective === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(KEY, override.value);
  } catch {}
  sync();
}