# Mouse performance + reliability (2026)

## Problem
Mouse interaction (Claude flicker-free TUI, Copilot CLI, Opencode pickers)
worked by transparent pass-through but had three problem classes:

1. **Event-rate cost.** Split panes sent one WS message per mouse event
   (no coalescing); every batch (even pure pointer-move) paid a geometry
   deliberate-action transaction and could flap ownership / HOL-block keys;
   motion had no rate limit beyond 60Hz rAF; the PTY `writeQueue` was
   unbounded with failures only console-warned.
2. **Pointer accuracy.** Under non-owner pan/scale presentation, xterm
   hit-tests the transformed element with unscaled cell metrics. Measured
   live: drawn col 26 reported as col 11 at scale 0.415 — mouse-mode apps
   on phones/second viewers were unusable, not just imprecise.
3. **Protocol races.** Claude trust auto-accept raw-wrote `1\r` past the
   queue (could interleave inside an SGR report); focus-byte filtering
   existed only on the main path; the 256KB input cut could split a mouse
   escape mid-sequence.

## Fix
- `src/public/input-sender.js` (new, unit-tested): focus filter,
  pure-motion detection, endpoint-exact motion compression (edges/keys/
  wheel always preserved in order), escape-boundary truncation.
- Main + split `onData` buffer per rAF and flush through the shared policy:
  motion-only batches go `claim:false` (same bytes, no owner flap) at most
  every 33ms (~30Hz, tail always delivered); action batches keep
  `claim:true` + viewId (owner semantics identical).
- Server 256KB cut moved to escape/char boundaries
  (`truncateInputAtBoundary`, exported for tests).
- `writeQueue` bounded at 128: over-threshold pure motion collapses to its
  tail (keys/edges/wheel never dropped); tails prepend to the next write
  or flush on full drain, preserving PTY byte order exactly; surfaced
  `_motionCoalesced` / `_inputWriteErrors` counters.
- Trust answer routed through `sendInput` (ordered behind floods).
- `src/public/pointer-correction.js` (new, unit-tested): capture-phase
  remap of mousedown/mousemove/mouseup so xterm reports the drawn cell,
  active only in non-`exact` regimes with mouse tracking on (exact path
  untouched). Includes the screen-element layout inset (8px; found by
  calibration sweep — without it the remap is ~2 cells off at phone
  scales). Wheel untouched by design (direction/count exact; wheel
  position approximate under pan/scale — documented).

## Verification
- Unit: input-sender 12, truncation 5, pointer-correction 5, chunked-write
  15 (incl. flood/order/error-counter), claude-bridge 15 (incl. queued
  order proof) — all passing.
- E2E `86-mouse-reporting` (new `mouse-interaction` project): exact-regime
  click accuracy, pan-regime click accuracy with correction-engaged guard,
  main drag ≤45/s, split 300-burst ≤20 msgs (fails pre-fix with 39).
- Rate gates discriminate: split burst fails pre-fix, passes post-fix.
- Regression: client-redesign 28 pass; functional-core + power-user-flows
  each have 1 failure also failing on pre-change code (proven via stash —
  pre-existing environment flakes, not regressions).
- Two pre-existing failures recorded, not introduced:
  `03-clipboard Ctrl+V` and `30-multisession` fail identically pre/post.

## Follow-ups
- Mobile specifics in `mouse-mobile-gaps-2026.md` (touch-drag vs swipe
  conflict, pinch-zoom mapping, keyboard-chrome transitions).
- Split Layer-3 presentation, `measureCapacity` for main, dblclick-select
  under transform: untouched, documented in plan research.
- X10-only apps on very wide grids: pass-through unchanged (all three
  CLIs request SGR).
