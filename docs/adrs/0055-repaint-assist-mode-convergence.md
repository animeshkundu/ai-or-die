# ADR-0055: Join-Replay Mode Convergence + Conditional Repaint Assist

## Status

Accepted

## Date

2026-09-15

## Context

Two production symptoms shared one root: the client RIS-clears (`\x1bc`)
before replaying a join, which wipes xterm modes, while the replay
restores only tail *bytes* — never terminal *mode state* — and nothing
afterwards asks the PTY app to repaint.

1. **Wheel-dead in opencode.** A long mouse-TUI session evicts both the
   alt-enter (DECSET 1049h) and the mouse-enable DECSET (1000h/1002h/
   1006h) from the 1000-chunk / 512KB ring. The ADR-0048-era alt prepend
   lands the client in the alternate screen, but with
   `mouseTrackingMode === 'none'` the `terminal-wheel.js` policy
   (`dontHijack` default) suppresses every wheel notch — zero PTY bytes —
   until the TUI repaints. Before the alt fix the same session sat in the
   *normal* buffer and the wheel scrolled scrollback natively, which is
   why the report read "partially scrollable, now not scrollable at all".
2. **Blur/focus garble.** Switching away from the Brave tab for 3–5 min
   and back shows stale fragments, block artifacts, and detached
   row numbers, healing only on a browser-dimension change. The
   blur→focus path is a deliberate no-op when geometry is unchanged
   (no join, no `terminal.refresh`, no PTY resize): `rAF` freezes while
   hidden, output is coalesced/dropped, the WebGL atlas goes stale, and
   the incremental TUI never repaints its absolute-addressed frame.

This supersedes the "deliberately not built" clause in
`docs/history/tab-switch-alt-screen-ghost-2026.md` (synthetic repaint
assist held as contingency): the contingency's trigger condition —
residual evidence of a lossy/diverged replay with no other fix — is now
met on all three stacks (Windows/ConPTY, macOS, Linux).

## Decision

1. **Replay restores mode state, not just bytes.**
   `TranscriptBuffer.getMouseTrackingMode()` (headless `modes`,
   fail-closed to `'none'`) feeds `_buildJoinReplay`, which re-asserts
   the minimal enable set for the settled class (`vt200 → 1000h+1006h`,
   `drag → +1002h`, `any → +1003h`, `x10 → 9h`) when the tail lost it,
   ordered after the alt-enter. Sessions without tracking and tails that
   already enable it are byte-identical to before. DEC 1007 (alternate
   scroll) stays client-tracked only — headless xterm ignores it, and it
   is rare enough to ride the SIGWINCH repaint instead.
2. **One gated repaint assist.** After a replay drain (second
   `terminal.write('', cb)` barrier, main and split panes) and on
   browser `visible`/`focus` with a surviving socket, the client
   invalidates the canvas (`clearTextureAtlas` + `refresh`, the same
   pair the font path uses) and sends `request_repaint`. The server
   (`_requestRepaintAssist`) runs a +1 bump round-trip through the PTY
   inside the geometry output hold — a same-size resize was measured
   to deliver zero SIGWINCH (node-pty probe: same-size → 0, any
   change → exactly 1), so the transient cols+1 (rows+1 at the cap)
   and back is what actually signals; the committed grid never
   changes. Gated on live + drained-transcript alt + grid + 2s rate
   limit + no in-flight hold, acked as
   `repaint_assisted{ok, reason, roundTrip}`; client-side rejections
   are console-warned with their gate reason.
3. **No behavior change for normal shells or idle sessions.**
   Client gates on `buffer.active.type === 'alternate'`; the server
   re-gates on the transcript. `dontHijack` remains the wheel default.

## Consequences

- Wheel/click reporting survives tab switches and refocuses for
  mouse-tracking TUIs; `window.app.__wheelDiag()` exposes the gate
  (`{alt, mouseTrackingMode, wheelScrollMode, verdict}`) for future
  "wheel does nothing" reports.
- A quick A→B→A burst plus a focus bounce collapses to at most one
  assist per 2s per session; the hold + watchdog semantics are reused,
  so no new output-interleaving or strand paths are introduced.
- E2E `86-repaint-assist` pins both halves (evicted-enables restore +
  live SGR wheel bytes + assist ack + a SIGWINCH-trap marker proving
  signal delivery through the full stack); unit suites pin the
  bump round-trip, helper mapping, drain ordering, and every skip
  reason plus static wiring pins for all client triggers. Verified
  failing pre-fix (19 unit failures; e2e `Expected "vt200", Received
  "none"`), green post-fix, with `test:core` otherwise clean (2137
  passing; the single failure is the pre-existing msedge-binary
  environment gap).
