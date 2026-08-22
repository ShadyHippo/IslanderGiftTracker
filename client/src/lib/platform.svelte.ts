/**
 * Best-effort platform detection for PWA install instructions.
 *
 * iOS Safari has no programmatic install prompt — users must use Share →
 * "Add to Home Screen". Android Chrome and desktop browsers expose an install
 * flow via a menu entry / address-bar icon. iPadOS 13+ reports itself as
 * "Macintosh", so touch capability disambiguates.
 */

export type Platform = 'ios' | 'android' | 'desktop';

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  const isIOSDevice = /iPad|iPhone|iPod/.test(ua);
  const isIPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (isIOSDevice || isIPadOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** True when the PWA is running installed (its own window), not in a tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    nav.standalone === true
  );
}

export function installHint(platform: Platform): string {
  switch (platform) {
    case 'ios':
      return 'In Safari: tap the Share button (□↑), then “Add to Home Screen”.';
    case 'android':
      return 'In Chrome: tap the ⋮ menu, then “Install app” or “Add to Home screen”.';
    default:
      return 'Look for the install icon in your browser’s address bar (Chrome/Edge), or use the browser menu → “Install”.';
  }
}
