# Manual Test Plan — Offline Installer & First-Visit Boot

**Build under test:** `2d10abd` (streaming zip installer + service-worker shell pre-cache)
**Plan created:** 2026-08-21
**Status:** IN PROGRESS

This file is the record of manual QA. Every box starts unchecked; each gets
checked only after the step passes on real hardware. Failed steps are noted in
the Results Log at the bottom instead of being skipped.

## Why this matters

Data loss or a broken first-run experience is an instant kill for the primary
user. Two failure modes are catastrophic and everything else is recoverable
annoyance:

1. **Two devices signed into the same account at the same time** — saves are
   whole-file, last-write-wins. One device per account, always.
2. **iOS: using the app as a Safari tab instead of via Add to Home Screen** —
   Safari evicts all website storage (including the gift log) after 7 days of
   non-use for regular tabs. Home-screen web apps are exempt.

## Environment

- [ ] Server deployed at build `2d10abd`, reachable over HTTPS/LAN
- [ ] Android device + browser identified: ____________
- [ ] iPhone device + iOS version identified: ____________

---

## Android

### A. Fresh install path

- [ ] **A1** Sign out → tap Clear cache → close all tabs of the app → reopen URL → sign in. App loads from network, no stale UI.
- [ ] **A2** Tap Install offline data (~200 MB) → reaches 100% → ready state shown. Progress bar moves steadily, no errors.
- [ ] **A3** Mid-download network drop: start install after clearing cache, at ~30% toggle Wi-Fi off 10s → back on. It resumes (progress jumps forward) or shows a retryable error that succeeds on retry. Never silently restarts from zero.
- [ ] **A4** Airplane mode ON → reload page. App shell loads, images render, no blank page.

### B. Data integrity (critical)

- [ ] **B5** Mark a gift as given → badge turns green → save pill shows "Saved".
- [ ] **B6** Airplane mode ON → fully kill app from recents → reopen from home screen. Edit still there.
- [ ] **B7** Airplane mode OFF → interact once → queued save lands within seconds (verify green badge from a second browser/device on same account).
- [ ] **B8** Offline editing spree: 5+ edits across villagers while offline → kill app mid-spree without waiting for "Saved" → reopen offline. Every edit survived.
- [ ] **B9** Toggle favorite + on-island flags offline → kill → reopen → flags intact.

### C. Update flow

- [ ] **C10** Deploy any new build → open app online → auto-reload happens once → new version runs.
- [ ] **C11** Same as C10 but with an unsaved offline edit pending first → local edit survives the reload.
- [ ] **C12** OS storage settings show roughly bundle size (~200 MB+) of site data.

### D. Account rules

- [ ] **D13** Sign out on device A → sign in on device B → data appears (server copy wins).
- [ ] **D14** Confirmed understanding: never two devices on one account simultaneously.

---

## iPhone (primary user's device)

### E. Install & the home-screen rule

- [ ] **E1** Safari → open site → sign in works.
- [ ] **E2** Share sheet → Add to Home Screen → launch from icon. Standalone (no Safari chrome), session persists.
- [ ] **E3** Install offline data (~200 MB) completes end-to-end with no error.
- [ ] **E4** Understood and confirmed: app is ONLY used via the home-screen icon, never as a Safari tab (7-day storage eviction otherwise).

### F. Data integrity (critical)

- [ ] **F5** Mark gift as given → badge green → "Saved".
- [ ] **F6** Airplane mode ON → kill app from app switcher → reopen from icon → edit still there.
- [ ] **F7** Airplane mode OFF → interact → sync verified from second device/browser.
- [ ] **F8** Offline editing spree (5+ edits) → kill mid-spree → reopen offline → all edits survived.
- [ ] **F9** Background app 10 min → return → signed in, state intact.
- [ ] **F10** Background overnight → return → intact.
- [ ] **F11** Settings → General → iPhone Storage shows ~200 MB+ for the site/PWA.

### G. Update flow

- [ ] **G12** Deploy new build → open app online → updates cleanly.
- [ ] **G13** Update with unsaved offline edit pending → edit survives.

---

## About popup

- [ ] **H1** First-ever visit (after clearing site data): About popup appears automatically and blocks use until dismissed.
- [ ] **H2** Popup shows the ONE DEVICE PER ACCOUNT warning (yellow box, red border) and a ☕ Buy me a coffee button.
- [ ] **H3** After dismissal, reloading does NOT show the popup again.
- [ ] **H4** Sign-in page has an About button below the Install offline data button → opens the same popup.
- [ ] **H5** Villager list: scrolling to the very bottom reveals an About button → opens the popup.

---

## Results Log

| # | Device | Date | Result | Notes |
|---|--------|------|--------|-------|
|   |        |      |        |       |

## Sign-off

- [ ] All boxes above checked
- [ ] Ready for primary user's first session

Tester signature/date: ____________
