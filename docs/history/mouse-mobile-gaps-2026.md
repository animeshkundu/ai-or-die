# Mouse interaction: mobile gaps and device-pass probes (2026)

Desktop mouse is fully addressed (see history entry `mouse-perf-reliability-2026.md`
and `e2e/tests/86-mouse-reporting.spec.js`). This note records what was
deliberately left mobile-specific, why, and exactly how to probe each item
on a real device.

## What works on mobile unchanged

- Tap-to-click and drag go through the same xterm SGR path as desktop; the
  input coalescing, motion compression, claim-light motion, and writeQueue
  bound all apply (they are pointer-type agnostic).
- The pointer-correction listener applies in any non-`exact` regime,
  including a phone panning a desktop-owned grid. It keys off xterm mouse
  tracking state, not pointer type.

## Deferred mobile items (documented, not silent)

### 1. Touch-drag into mouse-mode apps
Synthetic testing covers mouse-event drags only. Real touch drags produce
pointer events with touch `pointerType`; xterm translates them to mouse
reports, but the translation path (touch-action, `touchmove` suppression in
`disablePullToRefresh`, `#terminal touchmove stopPropagation`) was not
re-verified under an active mouse-mode app.
**Probe:** on the phone, open a mouse-mode app (e.g. `vim :set mouse=a`
or an Opencode picker), drag across text. Expect: selection/drag follows
the finger; no tab-switch fires mid-drag.
**Known conflict:** `_setupSwipeGestures` switches session tabs on a
single-touch horizontal swipe (`|dx|>80 && |dx|>2|dy|`, <300ms) and does
not check mouse mode. A fast horizontal flick inside a mouse-mode app may
change tabs instead of dragging. If observed, the fix is to suppress the
swipe when `mouseTrackingMode !== 'none'` or the regime is `pan`.

### 2. Tap precision under pinch-zoom
`computePresentation`/`pointerToCell` do not model `visualViewport` scale
or `offsetTop` (pinch-zoom, keyboard-open chrome). Taps while zoomed use
CSS-px outer rects against a composited-scaled viewport and may resolve to
neighboring cells.
**Probe:** pinch-zoom 150-200% on a mouse-mode grid, tap known cells.
Expect: may be off by one cell near edges. Mitigation if needed: feed
`visualViewport.scale/offsetTop` (already tracked by `viewport-regime.js`)
into the correction state.

### 3. Keyboard-open chrome shifting the grid mid-gesture
Soft-keyboard open collapses the visual viewport; the grid refits while a
touch drag is in flight. The 500ms rect cache in the correction wiring can
serve one stale frame during the transition.
**Probe:** focus the terminal (keyboard opens) then immediately drag in a
mouse-mode app. Expect: first ~500ms of the drag may map against the
pre-keyboard layout. Self-corrects after the cache refreshes.

### 4. Touch `touchend` + emulated-click double activation
`extra-keys.js` guards its own buttons (700ms window), but a tap that both
reports through mouse mode AND lands on an overlapping DOM control (link
provider hit area, context menu) can double-deliver. No change from before;
noted for the device pass to watch.

### 5. Wheel-position approximation under pan/scale
Scroll direction and tick count are exact (wheel flows through
`terminal-wheel.js` untouched); only the reported wheel *position* is
approximate for non-owner transformed views. TUIs that scroll the pane
under the cursor are unaffected; TUIs that act on the exact wheel cell
(e.g. hover-then-scroll menus) may target a neighboring cell on phones.
Desktop exact-regime wheel is byte-identical to before.

## What to report back from the device pass
For each probe: device, browser, viewport, regime (check Fit Screen button
visibility = non-owner), and whether behavior matched. Any systematic
off-by-one under pinch-zoom points at item 2; any tab-switch during fast
flicks points at item 1.
