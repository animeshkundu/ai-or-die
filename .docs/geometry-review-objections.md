# Terminal geometry: plan-review objections (recovered)

Recovered directly from `.recovered-logs/plan-review.log` (2.3 MB) of factory run `30982402342`.
Companion to `.docs/geometry-implementation-plan.md`, which already records the seven risks the
review raised about oscillation, the sticky-note regression, swallowed resize failures, the vacuous
idle bound, the AC-2 tautology, file-browser reparenting, and `position: fixed` in the dock track.

**This document records only what is NOT already in that file.** Quoted fragments are from the log.

## Overall verdict

> "The plan isn't fundamentally wrong — it's sound but needs those two additions."

The reviewer independently ran the baseline suite:

> "I ran the baseline test suite and got 2020 passing with 4 pending and 0 failing over 6 minutes,
> which confirms the plan's foundation."

Three prior "Corrections" were reaffirmed as settled:

> "All three Corrections are CORRECT and must not be relitigated"

including the font-size feedback loop, confirmed by inspecting the vendored bundle:
`src/public/vendor/xterm/addon-fit.*` performs a `fontSize` mutation, "so the font-size feedback loop
is real (Correction 1's diagnosis)".

## New objection 1 — pointer/tap coordinates break under scaling

The most substantive addition. The review inspected xterm's pointer mapping in
`src/public/vendor/xterm/xterm.*`: it uses `getBoundingClientRect()` (which **is** transform-aware)
and `getCoords`, which then divides by `dimensions.*`.

> "With CSS `zoom`, `getBoundingClientRect` returns zoomed values and client coordinates."

Consequence: a non-owner view presenting the applied geometry through a scale regime can render
correctly and still map clicks/taps to the **wrong cell**.

> "The plan's AC-2 assertion strengthening is solid but doesn't fully address this defect, so adding
> a pointer-to-cell test is necessary."

Recommended resolution — note the reviewer deliberately specified an invariant rather than an
implementation:

> "I'll recommend pan as the mechanism and coordinate correctness as the invariant, letting the
> implementer choose how to satisfy it."

Required test: a **Phone16 WebKit** project asserting that a tap at a known cell in a **non-owner**
view resolves to that cell.

This matters for the current recovered state, where Layer 3 is incomplete: whatever presentation
regime is finally implemented must satisfy coordinate correctness, not just visual correctness.

## New objection 2 — a briefing assumption was wrong

> "the plan claims one socket hosts multiple split panes, but splits[.js uses a] WebSocket per pane,
> which contradicts that assumption — though the composite key approach still holds, so it's not
> blocking."

The `(sessionId, connectionId, viewId)` composite key survives, so this is **not blocking** — but the
stated rationale for it ("one socket hosts multiple split panes") is incorrect. Anyone reasoning from
that premise later should know it is false.

## New objection 3 — the wire protocol was never decided

The plan describes the semantics but

> "never decides whether the `type:'resize'` string is preserved, extended or renamed, and what a
> withdrawal looks like on the wire."

**Unresolved.** Since withdrawal is required (a viewer below the 20x5 floor must withdraw rather than
leave a stale advertisement that can become authoritative), the wire representation has to be settled
before Layer 2/3 can be called complete.

## New objection 4 — incomplete `touchedPaths`

> "Four files depend on it and three are absent from touchedPaths: (a) `e2e/tests/74-client-shell-contract[.spec.js]` ..."

The log truncates the remaining names. Implication: the plan's own file list under-counted its blast
radius, so changes may be needed in files the plan never listed.

## New objection 5 — orientation must not claim

> "[phone orientation] IS the AC-7 orientation case and must become an advertisement that never claims."

Orientation change is explicitly one of the incidental layout events that must advertise capacity
**without** acquiring the ownership lease. This is a concrete instance of the general rule and is
directly testable.

## Incidental technical facts recovered

- `addon-fit` applies a **ruler allowance of 14** when `scrollback != 0`, and subtracts padding
  internally — relevant to the AC-1 110x35 seam, where the fix is to move padding and ruler
  subtraction to the outer element calculation *before* applying reserve.
- xterm's `getCoords` divides by `dimensions.*`, which is why any regime that alters the cell metric
  perturbs pointer mapping as well as fit.

## Not determinable from this log

- The full list of files missing from `touchedPaths` (truncated).
- Whether the pointer-to-cell test was ever written (see `.docs/geometry-implementation-status.md`).
- Whether the wire-protocol question was resolved later in implementation.
