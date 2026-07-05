# ADR-0037: Mobile input — two-mode model, native composer, mode-aware encoding, flicker-free keyboard

## Status
Accepted (2026-07-05).

## Context
The primary deployment target includes an iPhone 16 running the app as an installed PWA under **Microsoft Edge on iOS**. A user must be able to fully drive the Claude Code TUI by touch without falling back to a desktop, and the screen must not flicker when the soft keyboard shows/hides.

Investigation and adversarial review surfaced:
- **Edge on iOS is WebKit** (WKWebView), not Chromium — Apple still mandates WebKit outside the EU/Japan (verified 2026). Chromium CI does not represent the target.
- On-screen arrows/F-keys were **hardcoded** (`\x1b[A`, `\x1b[11~`) and sent raw over the WebSocket, **bypassing xterm's mode-aware encoder**. Under application-cursor mode (DECCKM) arrows must be `\x1bOA`; this silently breaks navigation inside Claude's menus.
- The soft keyboard covers ~half an iPhone screen, so reading requires dismissing it. Fighting keyboard dismissal is the wrong goal.
- Keyboard show/hide fired three uncoordinated terminal fits plus animated chrome collapse — the flicker.
- Sticky-modifier + soft-keyboard-letter is too fragile to be the primary path for critical keys on iOS (autocorrect/IME/focus can consume the sticky state).

## Decision
1. **Two deliberate modes.** *Compose* (keyboard up, native composer) and *Control* (keyboard down, keys panel). Panel taps send bytes over the WebSocket without requiring terminal focus, so a keyboard-down control surface has no focus-loss flicker.
2. **Mode-aware encoding.** A pure `key-encoder.js` produces bytes from a semantic key id + modifier state + `terminal.modes` (`applicationCursorKeysMode`, `bracketedPasteMode`). No hardcoded raw sequences in key definitions. Critical keys emit complete sequences directly; sticky modifiers are convenience only.
3. **Native composer** for prompt text (autocorrect/IME off, real multi-line editing, submit-sends), integrated with the existing STT/voice pipeline (voice dictates into the composer).
4. **Flicker-free transition.** A single rAF-coalesced keyboard controller shifts the terminal with `transform: translateY` locked to the `visualViewport` offset during the ~300ms iOS keyboard slide, then performs one measured `fitAddon.fit` on settle. Do not suppress fits mid-slide (that clips the terminal). Decouple the visual transform from the pty resize.
5. **Verification on Playwright WebKit** (closest engine to iOS Edge) for iPhone 16 + iPad (gen 11), plus a manual real-device Edge gate with objective criteria. Chromium CI is a smoke tier only.

## Consequences
- New modules: `key-encoder.js` (pure, mode-aware encoder — the source of truth), `keys-panel.js` (Control-mode grid), `terminal-copy.js` (visible-buffer copy). `extra-keys.js` refactored onto the encoder and given `destroy()`; a Shift sticky modifier, one-tap Ctrl+C, and Shift+Tab added.
- The native composer is the EXISTING `InputOverlay` (`input-overlay.js`), reused — its textarea gained `autocorrect/autocapitalize/autocomplete/spellcheck` off, and STT already routes into it via `app._voiceTarget = 'overlay'`. No duplicate composer was built.
- CI must `npx playwright install webkit` on ubuntu + windows (`test-browser-ios-webkit` job); e2e specs 77-79 run under the WebKit engine on iPhone 16 + iPad (gen 11) projects.
- `interactive-widget=resizes-content` is iOS 17.4+; the flex/safe-area fallback for older iOS must be tested.
- `pointer:fine` is not a reliable external-keyboard detector; an explicit persisted user toggle backs it.
- Copy-of-terminal-output uses `terminal-copy.js` (visible-buffer read) because the mobile Canvas renderer has no long-press selection.
- Real-device sign-off follows `docs/specs/mobile-input-verification.md` (required manual gate on Edge-on-iPhone).
- Supersedes nothing; complements ADR-0026 (voice) and the existing extra-keys bar.
