# PWA safe-area: expanding the Dynamic Island fix to all fixed overlays

## Problem
The initial Dynamic Island fix padded only **3 in-flow surfaces** (`.session-tabs-bar`,
`.file-browser-header`, `.mobile-menu`). Every **out-of-flow** overlay
(`position:fixed`/`absolute`) was anchored to physical screen edges with no
safe-area offset, so in an installed iOS PWA they collided with the Dynamic
Island (top) and home indicator (bottom). Reported surfaces: the **settings
popup** (title + close button under the island), toasts, banners, the extra-keys
bar, and other full-screen modals. Pixel-geometry measurement on iPhone 16
(393×852) confirmed 5 colliding surfaces.

Note: this app is **vanilla JS, not React** — and it wouldn't matter if it were.
PWA safe-area handling is pure CSS/viewport behavior (`env(safe-area-inset-*)`),
not framework magic. Layout only reclaims the island/home-indicator space where
the CSS consumes the insets; only 3 selectors did, so everything else ignored the
taller standalone viewport.

## Fix
Systemic, in one place — `src/public/components/safe-area.css` (loaded last),
all rules gated behind `html.pwa-standalone`:
- **Modal overlays** (settings/session/plan/folder-browser/shortcuts/image-preview):
  pad the overlay so the flex-centered `.modal-content` insets out of both zones;
  clamp `.modal-content` `max-height` to `calc(100dvh - sa-top - sa-bottom - 40px)`.
- **Top-anchored** toast/banner/notif-prompt/find-panel: offset by `+var(--sa-top)`.
- **Bottom-anchored** extra-keys bar / input overlay: lift by `var(--sa-bottom)`.
- Tokens `--sa-top`/`--sa-bottom` added to `tokens.css` (var → env → 0 fallback);
  six pre-existing `env(safe-area-inset-bottom)` bottom-bar sites converted to the
  token (behavior-preserving since the token falls back to `env()`).
- `app.js` polyfill extended to populate `--safe-area-inset-bottom` too, and
  hardened (from review): **self-gates to standalone** (so the `orientationchange`
  path can't push fake insets into a non-PWA iOS tab) and only applies the
  fallback on **tall notch-class** devices (aspect > 2), so iPhone SE / iPad don't
  gain a phantom inset.

## Self-test harness
`scripts/pwa-safearea-validate.js` — a Playwright harness that drives a real dev
server at **iPhone 16 (393×852)** and **desktop PWA (1280×800)**, forces
`html.pwa-standalone` + the `--safe-area-inset-*` variables, reveals every fixed
surface (modals, toast, banner, extra-keys bar), draws island/home-indicator
guides, and asserts each surface's *effective content edges* (rect ± padding)
clear the safe zones — exit non-zero on any collision. Before: 5 collisions on
iPhone 16. After: 18/18 surfaces clear on both viewports.

Run: `node scripts/pwa-safearea-validate.js` (self-starts a server on :11611).

## Caveat
Headless Chromium reports `env(safe-area-inset-*) === 0`, so the harness forces
the CSS *variables* directly (which is exactly what the app's polyfill sets on
device). It validates CSS consumption, not the polyfill's own device detection —
that logic is covered by review only.

## Lesson
A safe-area fix must reach every out-of-flow surface, not just the visible main
chrome. Centralize the inset rules + tokens so new overlays inherit the behavior,
and gate everything behind the standalone class so non-PWA layouts never move.
