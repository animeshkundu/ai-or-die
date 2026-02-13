# iOS Terminal App Prior Art — Research Summary

**Date:** 2025-07-18  
**Author:** Researcher Agent  
**Status:** Complete

## Steal-These-Patterns

### 1. Extra Key Row Is Non-Negotiable
Every successful iOS terminal (Blink, Termius, Prompt 3) ships a custom row above the software keyboard with Esc, Tab, Ctrl, arrows, and pipe. Blink calls them "Smart Keys." For our PWA: render a fixed HTML bar that appears with the keyboard using `visualViewport` API resize events. Minimum 44×44pt touch targets.

### 2. Swipe-to-Switch Sessions (Blink)
Blink's horizontal swipe between shells is the gold standard. Two-finger tap = new shell. Our PWA should implement `touch-action: pan-y` on the terminal and use horizontal swipe gestures for session tabs — feels native, zero chrome overhead.

### 3. Clips/Snippets (Prompt 3 + Termius)
One-tap reusable command snippets drastically improve mobile terminal usability. Store in localStorage, surface via a slide-up panel. Prompt 3's "Clips" and Termius's "Snippets" both validate this pattern.

### 4. GPU-Accelerated Rendering (Prompt 3)
Prompt 3 uses GPU-accelerated terminal rendering for 10× speed. xterm.js already has a WebGL renderer — **enable it by default** on iOS. Test that it doesn't drain battery excessively.

### 5. Font Size ≥ 16px (WKWebView Mandate)
iOS Safari/WKWebView auto-zooms inputs below 16px. Set terminal font-size to 16px minimum to prevent viewport shifting when focusing the input element. This is the #1 WKWebView pitfall.

### 6. PWA Install Guidance
iOS has no install prompt. Add a dismissible banner detecting `navigator.standalone === false` on Safari that walks users through "Share → Add to Home Screen" with a screenshot/animation.

### 7. Foreground-Only Architecture
iOS PWAs get no background execution. Design for reconnection resilience: WebSocket auto-reconnect, output buffer replay on rejoin (we already buffer 1000 lines), and visual "reconnecting…" state. Mosh-style resilience is why Blink thrives on mobile — our WebSocket layer needs the same robustness.

## Key Pitfalls to Avoid

| Pitfall | Mitigation |
|---------|-----------|
| Tiny touch targets | 44×44pt minimum on all interactive elements |
| Custom gestures without fallbacks | Always provide visible button alternatives |
| Ignoring safe areas | Respect `env(safe-area-inset-*)` CSS for notch/home indicator |
| No offline state handling | Service worker caches shell; clear "offline" indicator |
| Desktop-first output density | Collapse verbose output, use readable line spacing |

## PWA Reality Check (iOS 2025)

- ✅ Push notifications work (iOS 16.4+, home screen only)
- ✅ Service worker caching works
- ❌ No background sync/fetch
- ❌ No silent push
- ❌ Storage can be evicted under pressure
- ⚠️ Must use WebKit engine (no Chromium)

## Architecture Inspiration

- **Blink Shell**: Uses Chromium's hterm for rendering inside a Swift app. Open source (GPL-3). Proves that a web-based terminal renderer inside a native shell is the winning formula.
- **a-Shell**: Uses `ios_system` framework for local command execution with per-window context/history. Relevant pattern: each terminal window owns its own state independently.
- **Termius**: Bottom tab bar on iPhone, top tabs on iPad. Adapts layout to form factor — we should detect iPad via `min-width` media query and shift navigation accordingly.
