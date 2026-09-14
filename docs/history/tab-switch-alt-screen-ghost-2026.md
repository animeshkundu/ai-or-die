# Tab-switch ghost box in fullscreen TUIs (opencode over devtunnel, 2026)

## Symptom
Switching tabs away from a long-running opencode session and back left a
stale "ghost" region (old normal-buffer rows, e.g. a previous `git commit`
output block) behind the live fullscreen TUI, plus detached status-line
fragments at wrong rows. Reproduced on quick switches, on current master,
over devtunnel, with sessions routinely exceeding 1000 lines. Self-healed
on any resize.

## Diagnosis
The self-heal-on-resize is the tell: SIGWINCH forces the TUI to repaint
from intact internal state, so no bytes were ever lost — only the
xterm-side render diverged after the join replay.

Root cause: opencode runs in the alternate screen (DECSET 1049h, emitted
once at startup), but the join replay replays only the newest 1000 chunks
/ 512KB. Long sessions evict the alt-enter from the ring head while the
app is still in alt-screen, so the replay (`\x1bc` exits alt, then raw
tail with no re-enter) draws alt frames into the NORMAL buffer. Every
switch ghosts, quick ones included; live-output hold during repaint was
verified intact and is not involved.

## Fix
`TranscriptBuffer.isAltScreenActive()` (headless xterm
`buffer.active === buffer.alternate`, fail-closed) + alt-aware
`_buildJoinReplay`: when the transcript reports alt-active but the tail
contains no alt-enter after the last alt-exit, prepend `\x1b[?1049h`.
Eviction drops the oldest, so the tail always holds everything after the
evicted enter — prepending restores the exact final state. Non-alt
sessions and tails already containing the enter are byte-identical to
before. Markers require the `ESC[` prefix so prose mentioning "?1049h"
(a coding assistant's normal output) can never suppress a needed
prepend; chunk-split markers reunite via the join. Pure browser/terminal
layer — identical on Windows/ConPTY, no PTY interaction.

## Verification
- Unit: replay-builder alt cases (evicted/pre-existing/normal/no-
  transcript/split-marker/prose) + transcript alt-state incl. disposed
  fail-closed.
- E2E `86-alt-screen-replay`: ~700KB alt flood (deterministic ring
  eviction by bytes) + quick A->B->A switch asserts alternate buffer,
  tail content, and clean normal buffer. Pre-fix fails with
  `Expected "alternate", Received "normal"` — the exact production
  mechanism. Short-alt session guards the no-prepend path.
- Existing replay/geometry/switch suites green.

## Deliberately not built
A synthetic repaint assist (forced SIGWINCH per switch). Same-size
TIOCSWINSZ delivery is untested on ConPTY, and the reliable form (+1/-1
round-trip) would tax every healthy switch with double reflows plus
geometry-hold churn to mask a now-fixed root cause. Held as contingency:
only for a detected-lossy replay, only on residual evidence — none found.
