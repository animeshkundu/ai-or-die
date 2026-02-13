# Universal PWA Enhancement Plan

> **Decision status:** The proposal context in this document is superseded by **ADR-0014: Universal PWA Enhancement Architecture** (`docs/adrs/0014-universal-pwa-enhancement-architecture.md`).
> This spec remains implementation guidance and historical context.

## Problem Statement

ai-or-die works well in desktop browsers but needs to feel like a **native app on every platform** — iOS, Android, Windows, macOS, Linux, and web. When a user installs it (via the existing "Install App" button), it should be indistinguishable from a native app: no title bar on desktop, full-screen on mobile, platform-appropriate gestures and behaviors.

## Key Insight: The App Already Has Strong PWA Foundations

Validated existing infrastructure:
- ✅ `manifest.json` with `window-controls-overlay` + `standalone` + `minimal-ui` display modes
- ✅ `beforeinstallprompt` handler with "Install App" button (`index.html:714-750`)
- ✅ Service worker with network-first caching, offline fallback (`service-worker.js`)
- ✅ Apple iOS meta tags (`apple-mobile-web-app-capable`, `black-translucent` status bar)
- ✅ Extra keys row for mobile — Esc, Tab, Ctrl, arrows, pipe, etc. (`extra-keys.js`)
- ✅ Mobile CSS with safe area insets, bottom nav, hamburger menu (`mobile.css`)
- ✅ Window Controls Overlay CSS for desktop PWA (`base.css:85-96`)
- ✅ `visualViewport` keyboard detection (`app.js:617-623`)
- ✅ Voice input handler (`voice-handler.js`)
- ✅ Image paste handler (`image-handler.js`)

**This is NOT building a new app.** It's enhancing `src/public/` to be a top-tier universal PWA. One codebase, one URL, platform-adaptive behavior.

## Approach: Enhance, Don't Rebuild

**No `ios-app/` folder. No separate codebase. No forks.**

The existing `src/public/` app gets surgical enhancements:
1. Fix known mobile UX issues (touch targets, keyboard detection, z-index)
2. Polish the PWA install experience across all platforms
3. Add iOS-specific install guidance (iOS doesn't fire `beforeinstallprompt`)
4. Improve the installed (standalone) mode experience on every platform
5. Add mobile-first interaction patterns (swipe gestures, haptics, clips)

**Core principle: Desktop PWA = full functionality. Mobile PWA = stripped only where impractical.**
Desktop users get everything: split panes, VS Code tunnel, file editor, command palette, full keyboard shortcuts. Mobile strips only what genuinely doesn't work on a small touch screen (VS Code, file editing, split panes).

**Auth:** Handled by dev tunnels (validated — `bin/ai-or-die.js:67` disables auth in tunnel mode). No custom auth needed. Cookie stays in the PWA's own jar because it's served from the same origin.

## Validated Constraint: iOS = WebKit = Safari (No Escape)

**All browsers on iOS use WebKit.** Chrome, Edge, Firefox on iOS are just skins over Safari's engine. When a user installs a PWA from ANY iOS browser, the resulting app runs on WebKit. This means:

- There is no way to bypass Safari/WebKit limitations on iOS
- Every optimization we make for Safari automatically works for Chrome/Edge/Firefox on iOS
- The installed PWA is identical regardless of which browser the user installed it from
- **Our entire plan already targets WebKit/Safari as the iOS engine** — this is not a gap

What this means for our implementation:
- xterm.js WebGL renderer: tested against WebKit (Safari's engine) ✅
- `visualViewport` API: tested on WebKit ✅
- `ios-haptics` checkbox hack: targets Safari 17.4+ (= all iOS browsers 17.4+) ✅
- Cookie isolation: WebKit behavior, same for all iOS browsers ✅
- No `beforeinstallprompt`: WebKit limitation, affects all iOS browsers equally ✅
- Install guidance banner: browser-specific Share button location, but same end result ✅

**Bottom line:** Supporting Safari IS supporting iOS. There is no other engine to support.

## Platform Behavior Matrix

| Behavior | Desktop PWA (Win/Mac/Linux) | Mobile PWA (iOS/Android) | Web (not installed) |
|----------|------------------------|---------------------|-------------------|
| **Functionality** | **Full — everything works** | Stripped where impractical | Full |
| Title bar | Hidden (WCO) — tabs in title bar area | Hidden (standalone fullscreen) | Normal browser chrome |
| Navigation | Tab bar at top, keyboard shortcuts | Bottom nav + swipe gestures | Tab bar at top |
| Split panes | ✅ Full support | ❌ Screen too small | ✅ Full support |
| VS Code tunnel | ✅ Full support | ❌ No sense on mobile | ✅ Full support |
| File browser | ✅ Full (browse + edit) | ⚠️ Browse + preview only (no edit) | ✅ Full (browse + edit) |
| File editor | ✅ Full Ace editor | ❌ Too clumsy on phone | ✅ Full Ace editor |
| Extra keys | Hidden (physical keyboard) | Visible above virtual keyboard | Hidden |
| Touch targets | Standard | 44×44pt minimum | Standard |
| Install prompt | `beforeinstallprompt` button | iOS: custom banner + Share guide / Android: `beforeinstallprompt` | N/A (already in browser) |
| Haptics | None | Vibrate on key events (`ios-haptics`) | None |
| Font size | 14px default | 16px minimum (prevents iOS zoom) | 14px default |
| Keyboard | Physical — full shortcuts | Virtual — visualViewport resize + extra keys | Physical |
| Voice input | Optional (toolbar) | Prominent mic button (bottom nav) | Optional (toolbar) |
| Image paste | Ctrl+V / drag-drop | Camera button + photo library | Ctrl+V / drag-drop |
| Command palette | ✅ Ctrl+K | ⚠️ Simplified (no keyboard shortcuts) | ✅ Ctrl+K |

### Feature Availability by Platform

| Feature | Desktop PWA | Mobile PWA | Rationale for mobile exclusion |
|---------|:-----------:|:----------:|-------------------------------|
| Terminal (core) | ✅ | ✅ | — |
| Multi-session tabs | ✅ | ✅ (swipe) | — |
| Split panes / tiling | ✅ | ❌ | Screen too small for side-by-side |
| VS Code tunnel | ✅ | ❌ | VS Code requires desktop-class screen |
| File browser | ✅ | ✅ (read-only) | Editing is too clumsy on phone touch |
| File editor (Ace) | ✅ | ❌ | Phone keyboard + small screen = unusable |
| Command palette | ✅ | ⚠️ (simplified) | No keyboard shortcuts on mobile |
| Voice input | ✅ | ✅ (prominent) | — |
| Image paste | ✅ | ✅ (camera) | — |
| Keyboard shortcuts | ✅ | ❌ | No physical keyboard |
| Extra keys row | ❌ | ✅ | Only needed for virtual keyboard |
| Swipe gestures | ❌ | ✅ | Only needed for touch |
| Haptic feedback | ❌ | ✅ | Only on touch devices |
| Clips / snippets | ✅ | ✅ | Useful everywhere |
| Settings | ✅ | ✅ | — |
| Plan approval UI | ✅ | ✅ | — |

## What Needs Fixing (Known Issues from Audits)

| Issue | Source | Fix |
|-------|--------|-----|
| Tab close buttons 18×18px | `tabs.css:494-498` | Enforce 44×44pt on mobile |
| Extra keys 40×36px | `extra-keys.css:31-32` | Bump to 44×44pt |
| Keyboard detection 150px hardcoded | `app.js:626` | Already uses `visualViewport` — verify threshold is percentage-based |
| Install button overlaps bottom nav | `buttons.css:248` z-index | Reposition on mobile, integrate into bottom nav |
| z-index: overlay blocks tab overflow | Known from audit | Fix layering in mobile context |
| iOS font size < 16px causes zoom | `app.js:432` (14px) | Set 16px on mobile platforms |
| No iOS install guidance | Missing | Detect iOS + non-standalone → show "Add to Home Screen" banner |
| Manifest missing narrow screenshots | `manifest.json` | Add `form_factor: "narrow"` screenshot for mobile install UI |

## Implementation Phases

### Phase 1: PWA Install Excellence
**Goal:** The "Install App" button works beautifully on every platform. Installed app looks native.

1. **iOS install guidance banner (all browsers)** — Detect iOS + not standalone. Works for Safari, Chrome, AND Edge on iOS (all use WebKit under the hood since iOS 17). Detect which browser is in use and show the correct instructions:
   - **Safari:** "Tap Share (bottom bar) → Add to Home Screen"
   - **Chrome:** "Tap Share (top-right ⋯) → Add to Home Screen"
   - **Edge:** "Tap Share (bottom bar) → Add to Phone"
   Show as dismissible bottom-sheet card with animated icon. Remembers dismissal in localStorage for 7 days. Detection: `!navigator.standalone && !matchMedia('(display-mode: standalone)').matches && /iPhone|iPad/.test(navigator.userAgent)`.

2. **Manifest + icon polish** — Add `form_factor: "narrow"` screenshot for mobile install UI. Add `launch_handler: { "client_mode": "navigate-existing" }`. Verify `display_override` order on all platforms. For iOS: add `<link rel="apple-touch-icon">` tags in `index.html` for sizes 120, 152, 167, 180 (iOS uses these, NOT manifest icons). Keep manifest icons (192, 512) for Android/desktop.

3. **Install button UX** — Reposition install button on mobile to not overlap bottom nav. Show it contextually in bottom nav on mobile or as a slide-up card. Remove after install.

4. **Standalone mode detection** — Create `isPWA()` utility: `matchMedia('(display-mode: standalone)').matches || navigator.standalone`. Use it to adapt UI throughout the app.

5. **Desktop WCO polish** — Verify window-controls-overlay CSS works on Windows (Chrome/Edge), macOS (Chrome/Safari), Linux (Chrome). Tab bar must integrate seamlessly into title bar area. Test drag regions.

### Phase 2: Mobile-First Terminal Experience
**Goal:** Using the terminal on a phone feels natural, not like fighting a desktop UI.

6. **Touch target compliance** — Enforce 44×44pt minimum on all interactive elements at ≤768px. Audit and fix: tab close buttons, extra keys, bottom nav items, modal buttons.

7. **Font size 16px on mobile** — Set terminal font to 16px on mobile to prevent iOS auto-zoom. Use `detectMobile()` result already in `app.js`.

8. **Extra keys improvements** — Increase key size to 44×44pt on mobile. Add haptic feedback on tap. Consider swipeable extra key rows (more keys, swipe to reveal).

9. **Swipe gestures** — Session switching via swipe. **iOS constraint:** left-edge swipe is system-reserved (back gesture, cannot override). Use **two-finger horizontal swipe** on terminal OR **swipe on bottom tab bar dots** for session switching. Right-edge swipe is safe. Pinch to adjust font size. Implement in `gestures.js` with `touch-action: none` on terminal container.

10. **Keyboard avoidance refinement** — Verify `visualViewport` resize handler properly repositions extra keys bar and resizes terminal. Test across iPhone SE, iPhone 14, iPhone 15 Pro Max, iPad, Pixel 7.

11. **Bottom nav integration** — When installed as PWA on mobile, bottom nav should feel native. Add subtle animations, active state indicators, safe-area padding.

### Phase 3: Voice & Image (Mobile-Critical Features)
**Goal:** Mobile users can talk to AI and show it images without typing.

12. **Voice input prominence on mobile** — Move mic button to prominent position in mobile UI (bottom nav or floating). Keep existing voice handler but make it more discoverable on mobile.

13. **Camera / image capture** — Add camera button visible on mobile. Tap to open camera or photo library. Leverage existing `image-handler.js` which already handles image upload via WebSocket.

14. **Command clips/snippets** — Slide-up panel of saved commands. One-tap to paste into terminal. localStorage persistence. Inspired by Prompt 3 "Clips" / Termius "Snippets".

### Phase 4: Platform-Specific Polish
**Goal:** Each platform gets its native feel. Desktop PWA = full functionality.

15. **iOS-specific** — Spring curve animations, haptic feedback via `ios-haptics`, `overscroll-behavior: none`, rubber-band scroll prevention, Dynamic Island / notch safe area testing.

16. **Android-specific** — Material You-style ripple effects on touch, proper back gesture handling, status bar color adaptation per theme.

17. **Desktop PWA-specific (FULL FUNCTIONALITY)** — Everything the browser version can do, plus:
    - Window Controls Overlay: tabs in title bar, drag regions, `launch_handler: navigate-existing`
    - Keyboard shortcut overlay (Ctrl+?)
    - Window resize optimization
    - All features enabled: split panes, file editor, VS Code tunnel, command palette, full file browser
    - Taskbar badge for background session notifications
    - The desktop PWA should be indistinguishable from a native Electron app

18. **iPad / tablet layout** — Detect tablets via `min-width: 768px + pointer: coarse`. Top tab bar, wider terminal, keyboard shortcut support. Enable file editor and split panes (screen is large enough). VS Code tunnel available.

### Phase 5: Reconnection & Offline
**Goal:** The installed app handles real-world mobile conditions.

19. **Aggressive reconnection** — On `visibilitychange` → `visible`, immediately attempt WebSocket reconnect. Show visual "Reconnecting..." state. Replay output buffer on rejoin (server already buffers last 200 lines).

20. **Offline shell** — When offline, show cached app shell with "Waiting for connection" state instead of blank screen. Show last-known session list from localStorage cache.

21. **Storage hardening** — iOS can evict localStorage/IndexedDB under pressure. Migrate critical user data (settings, clips/snippets, session list cache) to IndexedDB with `navigator.storage.persist()` on first launch. All features must gracefully handle empty/missing stored data and recover by re-fetching from server.

22. **Push notifications (iOS 16.4+ / Android)** — Background task completion alerts when app is installed as PWA. Phase 5 because it requires server-side changes.

## Patterns from Prior Art

| Pattern | Source | Implementation |
|---------|--------|---------------|
| Extra key row above keyboard | Blink Shell "Smart Keys" | Already exists in `extra-keys.js` — enhance size/haptics |
| Swipe between sessions | Blink Shell | New `gestures.js` — horizontal swipe on terminal |
| Command clips | Prompt 3 / Termius | New feature — slide-up panel |
| Bottom tab bar on phone | Termius | Already exists in `bottom-nav.css` — polish |
| Install guidance for iOS | PWA best practice | New iOS-specific banner |
| Foreground-only resilience | Blink Shell (Mosh) | Enhance existing reconnect logic |
| No title bar on desktop | Every modern desktop app | Already in manifest + CSS — verify/polish |

## Test Strategy

### Existing Tests (Leverage)
- Mobile E2E: Playwright iPhone 14 (390×844) and Pixel 7 (412×915) projects already exist
- Visual regression: `09-visual-*` tests
- Mobile flows: `37-39` tests

### New Tests Needed
- **PWA install flow** — Playwright test verifying `beforeinstallprompt` handling and install button behavior
- **Standalone mode UI** — Mock standalone mode via `page.addInitScript()` (override `navigator.standalone` and `matchMedia`). Verify PWA-specific CSS and UI adaptations. Note: Playwright cannot launch in true installed-app mode; mocking is the validated CI approach.
- **Touch target audit** — Automated test asserting all interactive elements ≥ 44×44pt at mobile viewport
- **iOS install banner** — WebKit test verifying banner shows/dismisses/remembers correctly
- **Swipe gesture** — Touch event simulation for session switching
- **WCO layout** — Desktop test verifying tab bar in title bar area

### CI
- Leverage existing 16 parallel CI jobs (8 types × ubuntu + windows)
- Add WebKit browser tests for iOS Safari approximation
- Visual regression for installed PWA appearance

## ADR Required

**ADR-0015: Universal PWA Enhancement**
- Documents the "one codebase, platform-adaptive" approach
- Records why a separate `ios-app/` was rejected (unnecessary complexity, fork rot)
- Documents iOS cookie isolation constraint (PWA must be same-origin)
- Records the decision to use PWA over Capacitor (revisit for App Store only)
- Documents the platform behavior matrix

## Files to Modify (Minimal Changes)

| File | Change |
|------|--------|
| `src/public/manifest.json` | Add narrow screenshots, more icon sizes, `launch_handler`, verify display_override |
| `src/public/index.html` | iOS install banner, standalone detection |
| `src/public/app.js` | `isPWA()` utility, mobile font size 16px, gesture initialization |
| `src/public/mobile.css` | Install button repositioning, touch target fixes |
| `src/public/components/tabs.css` | Close button 44×44pt on mobile |
| `src/public/components/extra-keys.css` | 44×44pt keys, haptic styles |
| `src/public/components/buttons.css` | Install button mobile position fix |
| `src/public/base.css` | WCO polish, standalone mode tweaks |
| `src/public/style.css` | Minimal — standalone-specific overrides |
| **New:** `src/public/gestures.js` | Swipe session switching, pinch zoom |
| **New:** `src/public/install-prompt.js` | iOS install guidance banner logic |
| **New:** `src/public/haptics.js` | Cross-platform haptic feedback (vibrate on Android, checkbox hack on iOS) |
| **New:** `src/public/clips.js` | Command snippets (Phase 3) |

## Research Findings — Expert Swarm (5 Agents)

### 🏗️ Architect Assessment

**Manifest `display_override`:** Current order `["window-controls-overlay", "standalone", "minimal-ui"]` is correct. Browsers try each in order and fall back. WCO only applies to installed desktop PWAs.

**WCO support status (validated):**
| Browser | WCO Support | Notes |
|---------|-------------|-------|
| Chrome 105+ (desktop) | ✅ Yes | Stable, some macOS drag-region bugs |
| Edge 105+ (desktop) | ✅ Yes | Same as Chrome |
| Opera 91+ (desktop) | ✅ Yes | Chromium-based |
| Safari (any) | ❌ No | No plans to support |
| Firefox | ❌ No | — |
| All mobile | ❌ No | WCO is desktop-only |

**Risk:** Safari users on macOS will never get WCO. Falls back to `standalone` which is fine. No action needed — our CSS already handles this gracefully.

**`launch_handler` recommendation:** Add to manifest:
```json
"launch_handler": { "client_mode": "navigate-existing" }
```
This reuses existing windows instead of opening new ones — better desktop PWA behavior.

### 🔧 Principal Engineer Assessment

**xterm.js renderer (CORRECTION to plan):**
- Plan said "DOM renderer by default" — **WRONG** for 2025
- Canvas renderer is being **deprecated** (removed in xterm.js v6)
- Modern iOS Safari supports **WebGL2** — WebGL renderer is now fastest on iOS 15+
- **Recommendation:** Try WebGL first, fall back to DOM on failure:
```js
try {
  terminal.loadAddon(new WebglAddon());
} catch (e) {
  // DOM renderer is already the default fallback
}
```
- Handle `webglcontextlost` event to recover gracefully
- Avoid `position: fixed` on terminal canvas on iOS (causes compositing glitches)

**`beforeinstallprompt` support (validated):**
| Platform | Fires Event? | Install Method |
|----------|-------------|---------------|
| Chrome (Android) | ✅ Yes | Native prompt |
| Chrome (Desktop) | ✅ Yes | Native prompt |
| Edge (Desktop) | ✅ Yes | Native prompt |
| Samsung Internet | ✅ Yes | Native prompt |
| Safari (iOS) | ❌ No | Share → Add to Home Screen (manual guidance) |
| Chrome (iOS) | ❌ No | Share → Add to Home Screen (manual — uses WebKit) |
| Edge (iOS) | ❌ No | Share → Add to Phone (manual — uses WebKit) |
| Safari (macOS) | ❌ No | Not installable as PWA |
| Firefox | ❌ No | No PWA install support |

**Haptic feedback (CORRECTION to plan):**
- `navigator.vibrate()` does NOT work on iOS Safari — confirmed
- **Workaround discovered:** `ios-haptics` npm library uses a hidden `<input type="checkbox" switch>` toggle trick (Safari 17.4+) to trigger a light haptic tick
- **Integration note:** The app uses vanilla JS with no bundler. `ios-haptics` must be vendored as a UMD/IIFE script in `src/public/` or its technique must be inlined directly (the checkbox hack is ~15 lines). Do NOT introduce a bundler just for this.
- **Recommendation:** Inline the checkbox switch hack directly in a `haptics.js` module:
```js
// src/public/haptics.js — cross-platform haptic feedback
function haptic() {
  if (navigator.vibrate) { navigator.vibrate(10); return; }
  // iOS Safari 17.4+ checkbox switch hack
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.style.display = 'none';
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 500);
}
```

**Swipe gesture conflict (RESOLVED):**
- xterm.js has known poor touch support (GitHub issues #5377, #4780)
- **Pattern:** Use `touch-action: none` ONLY on terminal container, handle all touch in JS
- **Edge swipe zones:** Reserve 20px from screen edges for session switching. Interior touches go to terminal.
- Two-finger swipe = terminal scroll. One-finger edge swipe = session switch.

### 🎨 UX Designer Assessment

**Install prompt UX (best practices from top PWAs):**
- Twitter Lite: Inline banner at top, dismissible, appears after 2nd visit
- Starbucks: Bottom sheet with app icon preview and "Install" CTA
- **For iOS:** Show a "slide-up card" with animated Share icon + "Add to Home Screen" steps. Detect `navigator.standalone === undefined && /iPhone|iPad/.test(navigator.userAgent)`. Dismiss remembers in localStorage for 7 days.

**Bottom nav design (Apple HIG + Material 3):**
- 5 items maximum (we have 5 — good)
- Icon + label always visible (not icon-only)
- Active state: tinted icon + label, not just color
- Min height: 49pt (iOS) / 80dp (Material). Our 52px is borderline — bump to 56px.

### 🧪 Lead QA Assessment

**Playwright PWA testing (validated):**
- ❌ Cannot trigger `beforeinstallprompt` natively — mock it in tests
- ✅ Can mock standalone mode via `addInitScript`:
```js
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'standalone', { value: true });
  window.matchMedia = (q) => ({
    matches: q === '(display-mode: standalone)', media: q,
    onchange: null, addListener: () => {}, removeListener: () => {},
  });
});
```
- ✅ Touch gestures via `page.touchscreen.tap(x, y)` and manual touch event dispatch
- ✅ WebKit engine in Playwright approximates iOS Safari (imperfect but best available in CI)
- Touch target size testable via `element.getBoundingClientRect()` assertions

### 🔬 Researcher Assessment

**Competitive gap — what would make ai-or-die unique:**
- No terminal emulator ships as a PWA today (ttyd, Wetty, Gotty — all server-rendered, no PWA)
- Blink Shell is native iOS only; Termius is native on all platforms
- A high-quality PWA terminal that installs everywhere from one URL would be **first of its kind**

**Steal-these patterns (validated):**
1. Edge-swipe zones (20px margin) for navigation — avoids xterm.js touch conflicts
2. `ios-haptics` library for cross-platform haptic feedback
3. Starbucks-style install card (bottom sheet, not floating button)
4. Twitter Lite reconnection: service worker pre-caches shell, shows skeleton UI, reconnects transparently

## Open Questions

1. **Manifest screenshots:** Generate via Playwright in CI (capture at mobile + desktop viewports during E2E run)
2. **Icon generation:** Server already generates PNGs at `/icon-{size}.png` — these work for iOS. Just add `<link>` tags for all needed sizes.
3. ~~**Swipe gesture conflict:**~~ **RESOLVED** — Edge-swipe zones (20px margin), `touch-action: none` on terminal, custom JS touch handling
4. ~~**Haptic API:**~~ **RESOLVED** — Use `ios-haptics` library (checkbox switch hack for iOS, navigator.vibrate for Android)
5. **xterm.js upgrade:** Current v5.3.0 still has canvas renderer. Should we upgrade to v5.5+ or wait for v6? Canvas is being deprecated.

## iOS Hardening — Validated Constraints (Swarm Round 2)

Critical iOS-specific behaviors validated through research. These MUST be accounted for in implementation:

### ⚠️ iOS Kills WebSocket When Backgrounded
When the user switches away from the PWA or locks the screen, iOS immediately suspends the process and kills all WebSocket connections. There is **no workaround** — this is an OS-level constraint.

**Mitigation (already in plan as task #19):**
- Listen for `visibilitychange` → `'visible'`
- Immediately reconnect WebSocket
- Request output buffer replay (server already buffers last 200 lines)
- Show visual "Reconnecting..." skeleton state during reconnect
- This is the #1 most important iOS task — without it the app feels broken every time you switch apps

### ⚠️ localStorage Can Be Evicted
iOS can evict localStorage/IndexedDB under storage pressure or after extended inactivity. Data is "best-effort", not guaranteed.

**Mitigation:**
- Call `navigator.storage.persist()` on first launch to request persistent storage
- Use IndexedDB for critical data (settings, clips/snippets) — more robust than localStorage
- Design all features to gracefully handle missing stored data (re-fetch from server)
- Keep stored data small (settings, session list cache — not terminal output)

### ⚠️ Left-Edge Swipe = iOS Back Gesture (CANNOT Be Overridden)
iOS reserves the left-edge swipe as a system "back" gesture in standalone PWA mode. **There is no API to prevent or override this.** This directly conflicts with our planned edge-swipe for session switching.

**Mitigation (CORRECTION to swipe gesture design):**
- ❌ Do NOT use left-edge swipe for session switching on iOS
- ✅ Use **bottom tab indicator dots + swipe on the tab bar area** for session switching
- ✅ Or use **two-finger horizontal swipe** anywhere on terminal (doesn't conflict)
- ✅ Right-edge swipe is safe (iOS doesn't reserve it)
- Detect iOS and disable left-edge gesture zone; use alternative interaction

### ⚠️ Service Worker Doesn't Survive Background
iOS aggressively terminates service workers when the PWA is backgrounded. Push events and background sync are unreliable.

**Mitigation:**
- Don't rely on service worker for background tasks
- Service worker is for caching only (app shell, fonts, CSS/JS)
- All real-time features go through WebSocket (which reconnects on foreground)

### ✅ iOS PWA Install Works from All Browsers
Validated: Chrome, Edge, and Safari on iOS all support "Add to Home Screen" since iOS 17. The resulting PWA is identical (all WebKit). Install guidance banner should detect the browser and show the correct Share button instructions.

## Expert Sources

- **Architect:** WCO stable on Chrome/Edge, not Safari. `launch_handler: navigate-existing` recommended.
- **Engineer:** WebGL renderer now preferred over DOM on iOS. `ios-haptics` library for cross-platform haptics. Edge-swipe zones resolve gesture conflicts — EXCEPT left edge on iOS (system reserved).
- **Designer:** Bottom sheet install card > floating button. 56px bottom nav. iOS install guidance with animated Share icon.
- **QA:** Mock standalone mode in Playwright. Touch target testing via getBoundingClientRect. Can't test native install prompt.
- **Researcher:** No terminal emulator ships as a PWA — first-mover opportunity.
- **iOS Swarm (Round 2):** WebSocket killed on background (reconnect immediately on foreground). localStorage eviction risk (use `navigator.storage.persist()`). Left-edge swipe is system-reserved (cannot override — use tab bar swipe or two-finger gesture instead).
