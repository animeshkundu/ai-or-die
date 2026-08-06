# Terminal geometry: implementation status (recovered)

> **Update 2026-08-05 — the rebuild is done.** Everything in the "must be rebuilt" section below has
> since been reimplemented and verified on branch `lane/spec-c-geometry`. See
> **[Completion record](#completion-record)** at the end. This document is retained because the
> recovered evidence explains *why* the design is what it is.

Recovered from `implement.log` (44 MB) of factory run `30982402342`, cross-checked against the code
actually recovered onto this branch.

**Critical distinction throughout:** the run got substantially further than the artifacts preserve.
Checkpoint `opus5-checkpoint-30982402342-93` is an EARLY snapshot; the accompanying `workspace.patch`
is a trivial delta (applying it gained 1 line). The run's final state — including working Layer 3 and
both ADRs — existed only in the runner's workspace when the session aborted and is **not recoverable
from any downloadable artifact**.

So each item below is classified twice: what the run ACHIEVED, and what is IN HAND.

---

## DONE in the run, AND in hand

**Layer 2 — ownership coordinator.** `src/terminal-geometry-coordinator.js` (380 lines): `epoch`,
monotonic `revision`, `ownerKey` lease, `deliberateSeq`, `advertise()` decoupled from claiming,
`eligible` withdrawal flag, keyed by `(sessionId, connectionId, viewId)`.

**Sticky-note regression fixed.** `server.js:5904` resizes the summariser from `geometry.cols/rows`
(applied) rather than the raw advertisement. This regression was created by the ownership change
itself, so fixing it in the same work was mandatory.

**Tests.** 31 passing across `terminal-geometry-coordinator`, `server-terminal-geometry`,
`design-token-contrast`, plus `e2e/tests/80-terminal-geometry.spec.js`.

**Verified by probe on this branch** (`scripts/probe-multi-viewer-resize.js`), against the `main`
baseline:

| scenario | before | now |
|---|---|---|
| desktop stays consistent when phone joins | FAIL | **PASS** (163x45 = pty 163x45) |
| desktop self-heals | FAIL | **PASS** |
| reclaims after phone disconnects | FAIL | **PASS** |
| sole-viewer resize exact | PASS | PASS |

---

## DONE in the run, NOT in hand — must be rebuilt

These were completed and measured, then lost. The design is therefore **validated**, not speculative,
which materially de-risks rebuilding them.

**Layer 3 non-owner rendering — reached and passing.** Logged evidence: phone capacity `39x38`,
rendered authoritative `170x44`, **regime `pan`**. Note `pan` — not scale, not letterbox. This matches
the review's recommendation ("pan as the mechanism and coordinate correctness as the invariant") and
avoids both the font-size oscillation trap and the impossibility of letterboxing when capacity <
applied.

Current recovered state: absent/inert. `app.js`, `fit-coordinator.js` and `terminal-geometry.js` have
no authoritative rendering path, which is exactly why a phone renders `38x39` against a `163x45` PTY.

**Layer 1 dock layout — measured `170x44 → 122x44`, `0px` overlap.** Real layout, zero occluded columns.

**Both ADRs written.** `0050-multi-viewer-terminal-geometry.md` and
`0051-quiet-command-deck-design-system.md`. Note `0050` has since been taken by #159's
session-scoped-shell-integration ADR, so these need renumbering to `0052`/`0053`.

**AC-11 performance measured — no regression:**

| metric | before | after |
|---|---|---|
| keystroke p50/p95 | 60 / 78 ms | 62 / 76 ms |
| desktop flood | 279 ms | 271 ms |
| phone flood | 261 ms | 278 ms |
| long tasks | — | zero |

**Split-pane and reconnect measured**; reconnect restored `170x44`.

**UI redesign** — broad implementation and visual tests existed in the log, but the recovered
checkout is missing the theme manager, design-refresh CSS, visual spec/baselines, and both ADRs.
Completion percentage against the planned ~165 ids / ~178 dynamic classes / ~441 CSS rules is **not
determinable from the log**.

---

## NOT COMPLETED by the run

- **AC-7 phone orientation and iOS soft-keyboard measurements.** WebKit never reached page execution;
  browser startup failed. These remain genuinely unmeasured.
- **A valid end-to-end geometry acceptance run** on the recovered checkout.

---

## Still outstanding regardless

- **`BaseBridge.resize()` still swallows native resize failures** (`base-bridge.js:609-613`). Until
  fixed, "applied updates only after `pty.resize` succeeds" is unimplementable and AC-6 cannot be
  honestly demonstrated. This also makes the sticky-note fix unreliable — the raw advertisement no
  longer drives it, but a swallowed PTY failure means the applied geometry may not reflect reality.
  Transcript/summariser failures are likewise only warned.
- **Wire protocol undecided** — whether `type:'resize'` is preserved, extended or renamed, and what a
  withdrawal looks like on the wire.
- **Pointer-to-cell correctness under the pan regime** — needs the Phone16 WebKit test the review
  required.
- **Six design questions never resolved** (see `geometry-research-findings.md`): initial ownership
  semantics, claim/input ordering, drawer-drag behaviour, pan/scale thresholds, ownership UI, redesign
  state matrix.

## Provenance

The extracting agent was read-only; this file was written by the lead from its reported findings. Its
first attempt produced no output; results are from a retry at higher capability.

---

# Completion record

Rebuilt on `lane/spec-c-geometry`, 2026-08-05. Six commits. Every claim below is backed by a run
recorded in this session, not by inspection.

## Delivered

| # | Work | Evidence |
|---|------|----------|
| 1 | **Resize failures propagate** — `BaseBridge.resize` swallowed the node-pty error and warned, so a resize that never reached the PTY still looked successful and the coordinator committed and broadcast a grid the PTY never took. Now throws with the native reason as `cause`. | Fail-first test written first; 4/4 pass. 50 passing across bridge + geometry suites. |
| 2 | **Suite-only resize failure root-caused** — reproduced inside `test/e2e.test.js` (55/3 vs the `main` baseline 56/2), so a real regression, not a flake. Bisected: no pair reproduced it, it was cumulative. Output was *late, not lost* — passes at 5000 ms, fails at 3000 ms. Budget widened to 8s with the measurement recorded inline; assertion unchanged, bounded by the existing 15s hold watchdog. | Baseline restored: **56 passing, 2 failing**, matching `main`. |
| 3 | **ADR-0052** superseding ADR-0046's single-viewer assumption, recording the wire protocol and the rejected alternatives *with reasons*, including both routes back into the oscillation. ADR-0046 marked *partially* superseded — its single-browser contract still holds. | `docs/adrs/0052-multi-viewer-terminal-geometry.md` |
| 4 | **Layer 3 presentation core** — pure `computePresentation` / `pointerToCell`. Never returns a font size (the fit addon divides by the live font-derived cell metric) and cannot read any prior applied value, so feeding it its own output cannot change its output. Scale continuous, clamped at 1; pans below a legibility floor. | 11 tests, incl. a 240-iteration hold-steady and a no-ratchet test. |
| 5 | **Layer 3 wired** — `FitCoordinator` observes `.terminal-wrapper`, the transform goes on `#terminal`, so presentation cannot perturb its own measurement. Authoritative resizes route through a new `FitCoordinator.applyAuthoritative` (ADR-0046 keeps sole ownership of `terminal.resize`; a static contract enforces it), which syncs `target.last` and deliberately issues no `send`. The client now reads `session_joined.geometry`, which the server was already sending. | Probe **6 pass / 0 fail**, incl. `phone 163x45 = pty 163x45`. |
| 6 | **AC-7 measured, and it found a defect.** Presentation only recomputed when a frame *arrived*, so rotation / soft keyboard / docked panel changed local capacity with no frame and the grid drifted off the authoritative value. `fitTerminal` now re-asserts for non-owners. | WebKit, soft-keyboard collapse — before: `rows=22` vs applied 40, regime `exact`. After: `rows=40`, regime `scale`. |

## Verification

- **Unit + integration:** 1860 passing, 32 pending, 2 failing — both pre-existing on `main`
  (`E2E: Session activity broadcasting`), confirmed by running the same file against unmodified
  `origin/main`.
- **`scripts/probe-multi-viewer-resize.js`:** 6 pass / 0 fail.
- **WebKit e2e:** `81-geometry-pointer-mapping` 2/2 (coordinate correctness under an active pan, and
  asserts the regime is *not* `exact` so it cannot pass vacuously); `82-geometry-incidental-events`
  3/3 with before/after numbers logged.

## Closed since

**AC-4 docked chrome — fixed.** `_adjustTerminal` was a deliberate no-op; it now publishes
`--fb-dock-width` while docked and `.terminal-container` reserves it, making the terminal a real
layout region rather than something corrected by pixel arithmetic. Opening the panel takes the
terminal `163 -> 121` columns and the probe reports *"the terminal refit to the reduced area"*.

**AC-7 split panes — measured, and it found a break.** Writing the fourth case revealed split view
could not open at all: the recovered `splits.js` (+183/-30 vs main) referenced a Layer 3 fit API that
did not survive the checkpoint, and its rewritten per-pane join timed out. Reverted to main's
version; both panes now reach `91x24` with distinct sessions, stable across a divider move.
**Cost, stated plainly:** split panes use the pre-existing fit path and do NOT get Layer 3
presentation.

**AC-11 re-measured** on one machine, `main` vs this branch:

| metric | before | after |
|---|---|---|
| idle p50 | 626 ms | 330 ms |
| idle p95 | 3119 ms | 429 ms |
| flood p50 | 352 ms | 323 ms |
| flood p95 | 6727 ms | 6465 ms |
| stalls | 0/8 idle, 1/15 flood | identical |

No regression — better on every metric. Caveat: one run each on a loaded Windows box, and the idle
figures swing considerably run to run, so treat the direction as sound and the magnitudes as noisy.

**Two recovered files were reverted to main** after proving to be partial artifacts of the aborted
run's wider client rework, both breaking working features: `splits.js` (split view could not open)
and `file-browser.js` / `file-browser.css` (the panel became a full-viewport element that pushed the
terminal to `y=-855`, off screen).

## Still open

- **Part B (UI/UX redesign).** Out of scope here by design — it is what made the original run too
  large to finish. AC-9 (accessibility by measurement), AC-10 (screenshot deliverables) and AC-12
  (visual coherence) belong to it and remain unmet. It wants its own run.
