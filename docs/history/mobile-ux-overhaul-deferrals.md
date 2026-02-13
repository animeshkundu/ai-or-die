# Mobile UX Overhaul: Deliberate Deferrals (2026-02-12)

Items flagged during adversarial review of the mobile UX audit and deliberately deferred. Each was evaluated against implementation cost, user impact, and risk of unintended side effects.

---

## 1. P2-2: Pinch-to-zoom for terminal font size

**Finding**: Pinch-to-zoom conflicts with the browser's native page zoom. On mobile, intercepting the pinch gesture via `touchstart`/`touchmove` with `e.preventDefault()` on two-finger touch breaks the browser's accessibility zoom (WCAG 1.4.4). Users with hand tremor may accidentally trigger font changes.

**Decision**: Deferred. Dynamic font sizing (P1-5) provides viewport-appropriate defaults (12px for <=360px, 13px for <=414px, 14px for larger). Users can already adjust font size in Settings. A dedicated font slider in the settings modal would be a better UX than pinch — but this is a P3 enhancement, not a P2 fix.

**Revisit when**: A settings UI redesign is planned, or users request fine-grained font control on mobile.

---

## 2. fitTerminal ResizeObserver re-entry loop

**Finding**: The `_fitting` boolean guard in `app.js` prevents synchronous re-entry into `fitTerminal()`, but the ResizeObserver callback fires via a 50ms debounced `setTimeout`, at which point `_fitting` is already false. This creates a potential infinite loop:

```
fitTerminal() -> fitAddon.fit() -> container resizes -> ResizeObserver -> 50ms -> fitTerminal()
```

**Decision**: Deferred. In practice, `fitAddon.fit()` stabilizes within 1-2 cycles because the terminal dimensions converge to a fixed row/col count. The loop only oscillates on sub-pixel boundary conditions where the container size and the computed terminal size disagree by less than 1px (rare). A proper fix would extend the `_fitting` guard to cover the debounce period, but this risks suppressing legitimate resize events triggered by orientation change, keyboard open/close, or split pane adjustments.

**Revisit when**: Users report flickering, layout jitter, or excessive CPU on certain viewport sizes. A targeted fix would be a cycle counter (bail after 3 fits within 200ms) rather than extending the guard duration.

---

## 3. VirtualKeyboard API

**Finding**: Chrome Android exposes `navigator.virtualKeyboard` for precise keyboard geometry (exact height, overlap rect), avoiding the heuristic-based keyboard detection in P0-4.

**Decision**: Deferred. The API is Chrome Android only (no Firefox, no Safari, no iOS). The proportional threshold fix (P0-4: 25% screen height or 100px min) handles the common cases. Adding VirtualKeyboard as a progressive enhancement is reasonable but low priority — the heuristic works well enough on the devices where the API is unavailable, so the benefit is marginal.

**Revisit when**: Safari or Firefox ship VirtualKeyboard API support, or the heuristic proves inadequate on a specific device class.

---

## 4. iOS text selection overlay

**Finding**: xterm.js renders to a canvas element. Native iOS text selection (long-press to select, drag handles) does not work on canvas content. A transparent overlay div could intercept touch events and provide a selection UI.

**Decision**: Deferred. The overlay approach is complex and fragile. It must mirror the terminal's character grid exactly, handle scrolling, track cursor position, and update on every render. It also breaks on xterm.js version updates that change the internal layout. The clipboard permission fix (P0-8) and existing copy/paste buttons provide a workable alternative.

**Revisit when**: xterm.js adds native selection support for touch devices, or a well-tested community solution emerges.

---

## 5. Android composition fix (GBoard)

**Finding**: GBoard (Google Keyboard) on Android sends composition events (`compositionstart`/`compositionupdate`/`compositionend`) that xterm.js handles inconsistently, causing duplicate characters on certain input sequences.

**Decision**: Deferred. The root cause is in xterm.js's IME handling, not in our code. Workarounds (intercepting composition events, stripping duplicates) are brittle and break legitimate IME input for CJK languages. The correct fix is upstream in xterm.js.

**Revisit when**: xterm.js ships a fix for Android composition handling, or the issue is severe enough to justify a targeted workaround for Latin-script input only.

---

## 6. Customizable extra keys

**Finding**: The extra keys bar (P1-3) provides a fixed set of keys. Power users want to customize which keys appear and in what order.

**Decision**: Deferred. A settings UI for key customization (drag-to-reorder, add/remove keys, presets per workflow) adds significant complexity to the settings modal. The current fixed set covers the most common terminal shortcuts. User demand is speculative.

**Revisit when**: Users request specific keys that are not in the default set, or a settings UI redesign is planned.

---

## 7. Edge-swipe drawer

**Finding**: A left-edge swipe gesture could open a mobile navigation drawer, matching native app conventions.

**Decision**: Deferred. The bottom navigation bar already provides equivalent navigation. Edge-swipe conflicts with the browser's back gesture on both iOS and Android. Implementing it requires careful gesture disambiguation that adds complexity without clear user benefit.

**Revisit when**: The bottom nav proves insufficient for navigation, or a major mobile UX redesign is planned.

---

## 8. Reduced scrollback on low-RAM devices

**Finding**: The default scrollback buffer (1000 lines) consumes memory proportional to terminal width. On low-RAM devices, this can cause the browser tab to be killed by the OS memory manager.

**Decision**: Deferred. The Device Memory API (`navigator.deviceMemory`) that would enable dynamic scrollback defaults has limited browser support (Chrome/Edge only, not Safari or Firefox). The current 1000-line default is conservative enough for most devices. Users experiencing memory pressure can reduce scrollback in settings.

**Revisit when**: Device Memory API gains broader support, or users report tab crashes on specific low-end devices.

---

## 9. Screen reader terminal output

**Finding**: Terminal output is rendered to a canvas and is invisible to screen readers. An `aria-live` region populated with terminal text would make the application usable with assistive technology.

**Decision**: Deferred. This is a major accessibility effort. xterm.js has an internal accessibility layer (`xterm-accessibility` class) that provides basic screen reader support, but it does not announce streaming output in real time. A proper implementation requires buffering terminal output, deduplicating repeated lines, throttling announcements to avoid overwhelming the screen reader, and handling ANSI escape sequences. File browser icon aria-labels (P1-9) are the immediate accessibility priority.

**Revisit when**: Accessibility compliance becomes a project requirement, or xterm.js improves its built-in screen reader support.

---

## 10. Service worker dynamic versioning

**Finding**: The service worker cache version (`CACHE_VERSION` in `service-worker.js`) is a hardcoded string. Cache invalidation on deploy requires manually bumping this value.

**Decision**: Deferred. Dynamic versioning (content hash in cache key, auto-generated version from git SHA or build timestamp) requires build tooling (a bundler or build script that rewrites the service worker). The project currently has no build step for client-side assets. Adding one solely for service worker versioning is disproportionate. Manual version bumps work for the current release cadence.

**Revisit when**: A client-side build step is introduced for other reasons (bundling, minification, tree-shaking), at which point service worker versioning can be added for free.
