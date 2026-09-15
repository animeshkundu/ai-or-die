# Repaint assist + mouse-mode convergence (2026-09-15)

## Symptom

Two reports, one session each:

1. Brave tab switch-away (3–5 min) → switch-back left stale fragments,
   grey block artifacts, and detached row numbers (`41 705 / 4 / 1`
   adrift at wrong rows). Healed only on a browser-dimension change.
   Reproduced on Windows/ConPTY, macOS, and Linux, latest master.
2. The opencode TUI inside ai-or-die stopped scrolling with the mouse
   entirely. Before the alt-screen ghost fix it had been *partially*
   scrollable.

## Diagnosis

Shared root, verified line by line: the client RIS-clears (`\x1bc`,
`src/public/app.js` replay path) before replaying, which wipes xterm
modes, while the replay restores only tail bytes — never mode state —
and nothing afterwards asks the PTY app to repaint.

- Blur→focus is a deliberate no-op at unchanged geometry: no join, no
  `terminal.refresh/clearTextureAtlas`, no PTY resize
  (`src/public/app.js:408-444`, `src/public/fit-coordinator.js`
  dedup). `rAF` freezes while hidden, server BG coalescing drops spans,
  the WebGL atlas goes stale, and the incremental TUI (absolute cursor
  addressing) never repaints. Screenshot signatures matched all three
  layers (bytes behind + canvas stale + TUI diverged).
- Wheel path audit cleared everything new in `f84ac8d` (focus filter,
  pure-motion, truncation, bounded writeQueue, pointer-correction all
  provably preserve wheel 64/65). The killer is the older
  `src/public/terminal-wheel.js` `suppress` branch (alt + no-mouse +
  `dontHijack` default): post-alt-fix the client correctly lands in
  *alternate* but with `mouseTrackingMode === 'none'`, so every notch
  dies with zero WS bytes. Pre-alt-fix the same session sat in
  *normal* and the wheel scrolled scrollback — hence "partially" →
  "fully dead".

## Fix

- `TranscriptBuffer.getMouseTrackingMode()` + `_buildJoinReplay`
  mouse re-assert (class-minimal sets, ordered after the alt-enter;
  prose-proof markers; byte-identical when tracking is absent or
  present). Pure server/terminal layer — identical on ConPTY.
- Conditional repaint assist: client canvas invalidate after every
  replay drain + `request_repaint` on tab-switch and browser
  `visible`/`focus` (alt-only, 2.5s debounce); server same-size PTY
  resize inside the geometry hold (2s rate limit, fail-closed skips),
  acked as `repaint_assisted{ok, reason}`. Normal shells and idle
  sessions never pay a SIGWINCH.
- `window.app.__wheelDiag()` console diagnostic for future wheel
  reports; split panes invalidate + assist independently.

## Verification

- Unit: transcript mouse tracking (incl. disposed fail-closed),
  prepend matrix (evicted/present/non-tracking/drag/prose), helper
  mapping + reset detection, assist gating (ok/rate-limit/interval/
  all four skips/hold-release-on-throw). Fail pre-fix (12 failures),
  pass post-fix.
- E2E `86-repaint-assist` (mouse-interaction project): 700KB
  alt+mouse flood + quick switch asserts alternate + `vt200` +
  tail + `passthrough` verdict; live-alt `request_repaint` asserts
  `repaint_assisted{ok:true}` through a real node-pty resize.
- Suites: targeted 90 passing (replay/assist/transcript/input/
  wheel/fit/static incl. resize-ownership contract); full `test:core`
  2129 passing, 1 pre-existing environmental failure (msedge binary
  absent on this host, `test/e2e-geometry-iphone16.test.js` before-all
  hook — unrelated, fails identically without these changes).

## Deliberately not built

- DEC 1007 restore in the replay (headless xterm ignores 1007; rides
  the SIGWINCH instead), per-app wheel exceptions, and any injected
  keystroke (Ctrl-L) repaint — app-specific and intrusive.
