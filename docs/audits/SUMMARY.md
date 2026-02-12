# Mobile UX Audit: Synthesized Findings

**Date**: 2026-02-12
**Sources**: 8 Copilot agent audits (PRs #43-#50), 3 expert reviewer validations, 1 adversarial review
**Scope**: Mobile phone, tablet, and responsive UX for ai-or-die terminal web app

## Methodology

1. 8 Copilot agents ran parallel audits using Playwright MCP across phone/tablet/desktop viewports
2. 3 expert reviewers validated every finding against actual codebase
3. 1 adversarial reviewer challenged assumptions and identified gaps
4. Findings cross-referenced with implementation plan

**False positives identified and removed**: 6
- Mode switcher not created on mobile (timing issue in Playwright, code is correct)
- Tab text has no ellipsis (CSS `text-overflow: ellipsis` already present)
- Auth token in localStorage (already uses sessionStorage)
- No skipWaiting in service worker install (handled via message listener)
- Mobile menu not opening (code correctly wired, Playwright missed CSS transition)
- Voice button zero dimensions (intentionally hidden when STT unavailable)

---

## Final Prioritized Fix List

### P0 — Critical (Must Fix)

| # | Issue | Source | Files | Effort |
|---|-------|--------|-------|--------|
| **P0-1** | **Install button overlaps bottom nav on mobile** — z-index 300 (overlay) blocks z-index 200 (sticky) bottom nav. Settings/More buttons unreachable. | PR#45, PR#46, PR#49 (3 agents), Expert-1, Expert-2 | `buttons.css:248-263` | Low — CSS position fix |
| **P0-2** | **Viewport meta tag: add viewport-fit=cover + interactive-widget** — Safe area insets resolve to zero without viewport-fit. Keyboard behavior inconsistent without interactive-widget. Do NOT add `maximum-scale=1.0` (breaks WCAG 1.4.4 zoom). Use `maximum-scale=5` if needed. | Original plan + Expert-3 WCAG tension | `index.html:5` | Low |
| **P0-3** | **Add text-size-adjust: 100%** — iOS/Android auto-scale text on rotation causing layout shifts | Original plan | `base.css` body rule | Very low |
| **P0-4** | **Fix keyboard detection: replace hardcoded 150px threshold** — Fails for split/floating/landscape keyboards. Use proportional (25% screen height or 100px min). Add thrashing guard, Safari fallback, debounced hide/show. | PR#44, Original plan | `app.js:616-643` | Medium |
| **P0-5** | **Verify and fix context menu on mobile** — Do NOT add custom long-press timer. Verify native `contextmenu` works. Render as bottom sheet on mobile. | Original plan + Expert-2 | `app.js:2326-2368`, `menus.css` | Low-Medium |
| **P0-6** | **Fix fitTerminal hardcoded -2 rows / -6 cols** — Mobile loses 15% width. Use `isMobile ? 1 : 2` rows, `isMobile ? 0 : 6` cols. Add recursion guard. | PR#46, Original plan | `app.js:2155-2186` | Low |
| **P0-7** | **Add network change + background tab handling** — No online/offline listeners. WebSocket dies silently on network switch. Increase reconnect attempts to 10, cap backoff at 30s. | PR#47, Original plan | `app.js` | Low |
| **P0-8** | **Fix clipboard permission handling** — Uncaught throws on mobile permission denial | Original plan | `app.js:2393-2400` | Low |
| **P0-9** | **New session button touch targets critically undersized** — 20x22px main, 14x22px dropdown. No `pointer: coarse` override (unlike tab-close which has one). | PR#50, Expert-3 | `tabs.css:506-517` | Low |

### P1 — High Impact

| # | Issue | Source | Files | Effort |
|---|-------|--------|-------|--------|
| **P1-1** | **Auto-hide bottom nav + tab bar + mode switcher when keyboard opens** — 88px wasted. Use `body.keyboard-open` class with CSS transitions (not display:none). 300ms JS debounce to prevent flicker. | Original plan | `mobile.css`, `tabs.css`, `bottom-nav.css` | Medium |
| **P1-2** | **Keyboard dismiss button in extra keys bar** — No way to dismiss on iOS | Original plan | `extra-keys.js` | Low |
| **P1-3** | **Expand extra keys: multi-row, more keys, 44px targets** — Missing Home/End/PgUp/PgDn/Alt. Current 40x36px below HIG. Row 2 conditional (only if terminal height > 400px). | PR#50, Original plan | `extra-keys.js`, `extra-keys.css` | Medium |
| **P1-4** | **Orientation change handler** — No explicit handler. 300ms debounced refit. Landscape CSS: compact tab bar, icon-only nav. | Original plan | `app.js`, `mobile.css` | Low |
| **P1-5** | **Dynamic font sizing** — 12px for <=360px, 13px for <=414px, 14px for larger | Original plan | `app.js:432` | Very low |
| **P1-6** | **Fix modal overflow when keyboard open** — max-height doesn't account for keyboard. Use CSS custom property from visualViewport.height. | Original plan + Expert-2 | `modals.css`, `mobile.css` | Low |
| **P1-7** | **Fix overlay blocking tab overflow on mobile** — "Choose Your Assistant" overlay covers tab bar on new session. Users can't switch tabs until selecting a tool. | PR#48, Expert-2 | `app.js:1443-1452`, `terminal.css:179-191` | Medium |
| **P1-8** | **768px breakpoint too low for iPad Mini** — iPad Mini portrait (768px) gets cramped desktop UI. Consider moving to 820px or adding tablet range. | PR#43, Expert-1 | `mobile.css`, `tabs.css`, `bottom-nav.css` | Medium |
| **P1-9** | **File browser icon buttons missing aria-label** — 3 buttons have title only, unreliable for screen readers | PR#50, Expert-3 | `index.html:559-570` | Very low |

### P2 — Polish

| # | Issue | Source | Files |
|---|-------|--------|-------|
| **P2-1** | Swipe between sessions | Original plan | `app.js`, `session-manager.js` |
| **P2-2** | Pinch-to-zoom font size (or font slider in settings instead) | Original plan | `app.js` |
| **P2-3** | Haptic feedback on extra keys (with disable setting) | Original plan | `extra-keys.js` |
| **P2-4** | Mobile settings modal stacked layout | Original plan, PR#43, PR#45 | `modals.css` |
| **P2-5** | Improve pull-to-refresh prevention | Original plan | `app.js:294-320` |
| **P2-6** | OS dark mode listener (prefers-color-scheme) | PR#50, Original plan | `app.js` or `index.html` |
| **P2-7** | Tab close button CSS specificity cleanup | PR#45, Expert-1, Expert-3 | `tabs.css:494-498` |
| **P2-8** | Overflow button visual prominence | PR#48, Expert-2 | `tabs.css:353-367` |
| **P2-9** | Ctrl modifier timeout in extra keys | PR#44, Expert-2 | `extra-keys.js:69-70` |
| **P2-10** | Comprehensive mobile E2E tests | Original plan | `e2e/tests/` |

### P3 — Deferred

| Item | Description |
|------|-------------|
| VirtualKeyboard API | Chrome Android only — precise keyboard geometry |
| iOS text selection overlay | Transparent div for native selection on canvas |
| Android composition fix | GBoard duplication — needs xterm.js upstream |
| Customizable extra keys | Settings UI with presets |
| Edge-swipe drawer | Left edge swipe to open mobile menu |
| Reduced scrollback on low-RAM | Dynamic default based on device memory |
| Screen reader terminal output | Populate srAnnounce with terminal text |
| Service worker dynamic versioning | Requires build tooling |

---

## Expert Review Consensus

### Agreement across all 3 reviewers:
1. Install button overlap is the highest-priority new finding (Critical)
2. Playwright emulation misses `pointer: coarse` — tab close IS 44px on real touch devices
3. New session button has NO coarse override — genuinely undersized
4. PR#48 (session mgmt) was severely hampered by overlay blocker — 7 of 10 "findings" were just testing gaps
5. Plan P0-1 must NOT include `maximum-scale=1.0` (WCAG conflict) — use `maximum-scale=5`

### Key corrections to original plan:
- P0-4 (context menu): Do NOT add custom 500ms timer. Verify native contextmenu first.
- P0-2 (viewport meta): Changed from `maximum-scale=1.0` to `maximum-scale=5` per WCAG
- P1-1 (auto-hide): Use CSS transitions, not display:none. 300ms debounce.
- P1-3 (extra keys): Row 2 conditional on terminal height > 400px
- NEW P0-1: Install button z-index is the #1 priority (wasn't in original plan at all)
- NEW P0-9: New session button touch targets (wasn't in original plan)
- NEW P1-7: Overlay blocking tab overflow (wasn't in original plan)
- NEW P1-8: 768px breakpoint for iPad Mini (wasn't in original plan)

---

## Audit Report Index

| PR | Agent Focus | Report |
|----|------------|--------|
| #43 | Tablet UX | `docs/audits/tablet-ux-audit.md` |
| #44 | Input/keyboard | `docs/audits/mobile-input-audit.md` |
| #45 | Phone UX | `docs/audits/mobile-phone-ux-audit.md` |
| #46 | Responsive stress | `docs/audits/responsive-stress-test.md` |
| #47 | PWA resilience | `docs/audits/pwa-resilience-audit.md` |
| #48 | Session management | `docs/audits/session-management-mobile-audit.md` |
| #49 | Visual polish | `docs/audits/visual-polish-audit.md` |
| #50 | Accessibility | `docs/audits/accessibility-audit.md` |
