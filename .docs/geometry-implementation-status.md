# Terminal geometry: implementation status (recovered)

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
