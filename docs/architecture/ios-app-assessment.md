# iOS App Architecture Assessment

**Author:** Principal Architect | **Date:** 2025-07-18 | **Status:** ~~Proposal~~ **SUPERSEDED by `docs/specs/universal-pwa.md`**

> **NOTE:** This document was an early exploration that recommended a separate `ios-app/` folder. After further analysis (iOS cookie isolation, cross-platform PWA viability, code duplication concerns), the team chose to enhance the existing `src/public/` instead. See `docs/specs/universal-pwa.md` for the accepted plan and ADR-0015 (pending) for the formal decision record.

## Original Recommendation (Superseded): iOS-Optimized PWA Client in `ios-app/`

**Approach:** A standalone, iOS-first web client — not a fork of `src/public/`, not a Capacitor wrapper. A purpose-built PWA that speaks the existing WebSocket protocol to any ai-or-die server.

### Why Not the Alternatives

| Option | Verdict | Reason |
|--------|---------|--------|
| Enhance `src/public/` | Rejected | Multi-server requires a fundamentally different auth/connection model. Grafting it onto the current single-server app creates a Frankenstein. |
| Capacitor wrapper | Rejected for now | Adds Xcode dependency, CocoaPods, native build pipeline — all for capabilities PWA already provides. Revisit only if we need Keychain or push notifications. |
| Fork `src/public/` | Rejected | Forks rot. Two copies of xterm setup, two WebSocket handlers, two session managers — all drifting apart. |

### Architecture: Thin Client, Shared Protocol

```
ios-app/
├── index.html              # iOS-optimized shell (viewport, meta, manifest)
├── manifest.json           # Standalone PWA, iOS display overrides
├── service-worker.js       # Offline: cache app shell, not server data
├── css/
│   └── ios.css             # iOS-only: safe areas, keyboard, haptics
├── js/
│   ├── server-manager.js   # Multi-server: add/remove/switch servers
│   ├── terminal-ios.js     # xterm.js wrapper: iOS keyboard, gestures
│   ├── auth-manager.js     # Per-server token storage (localStorage keyed by URL)
│   └── protocol.js         # WebSocket message types (importable by src/ too)
└── icons/                  # iOS-specific icon sizes
```

**Key design decisions:**

1. **`protocol.js` is the shared contract.** Extract WebSocket message types from `src/public/app.js` into a module both clients import. This is the *only* shared code. Everything else is independent.

2. **Multi-server is first-class.** `server-manager.js` maintains a list of `{url, name, token, lastConnected}` in localStorage. The app opens with a server picker, not a terminal. This is the fundamental UX difference from `src/public/`.

3. **Per-server auth.** Tokens stored in localStorage keyed by server URL. No sessionStorage (it dies with the tab — hostile to PWA lifecycle on iOS where Safari aggressively evicts).

4. **iOS keyboard handling.** Replace the hardcoded 150px threshold with `visualViewport` API resize events. Detect keyboard show/hide from viewport height delta. Resize xterm on every viewport change.

5. **Touch targets.** Enforce 44pt minimum globally via CSS custom property. The 18px close buttons from `src/public/` don't exist here — design from scratch.

6. **Terminal gestures.** Two-finger scroll for terminal history. Long-press for paste. Pinch-to-zoom for font size. Swipe-right from edge for server switcher.

### Relationship to `src/public/`

**Independent.** `ios-app/` is a separate web application served from a different path or hosted statically. It connects *to* ai-or-die servers; it is not served *by* them. This means:

- The server needs zero changes (WebSocket protocol is the API)
- `ios-app/` can be hosted on GitHub Pages, Netlify, or any static host
- Users install the PWA from the hosted URL, then add their server URLs

### ADR-0004 Compatibility

ADR-0004 covers Windows/Linux server-side. iOS is purely client-side. No conflict. A new ADR-0015 should formalize the "thin client, protocol contract" pattern for multi-platform clients.

### Phase 1 Deliverables (Terminal Usability)

1. Server connection manager (add/switch/remove)
2. Single-terminal view with iOS-optimized xterm.js
3. `visualViewport`-based keyboard handling
4. PWA manifest with Add to Home Screen
5. Per-server Bearer token auth

Full parity (file browser, voice, image upload, session tabs) deferred to Phase 2+.
