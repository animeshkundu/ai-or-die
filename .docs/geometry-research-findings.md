# Terminal geometry: finalized research findings (recovered)

Recovered from `research.log` of factory run `30982402342` (aborted mid-flight). Companion to
`.docs/geometry-implementation-plan.md` and `.docs/geometry-review-objections.md`.

## Measured facts

- Windows: desktop `163x45`, phone/PTY `38x39`. Disconnect did **not** recover the desktop.
- A `350px` dock hid **~40 of 163 columns**.
- Baseline suite at the time: **2020 passing, 4 pending, 0 failing** (~6 min).
- **Windows and Linux font metrics differ: `38` vs `41` columns at 393 px.** Any test asserting an
  absolute column count is not portable across platforms.

## What the research established about existing code

- `FitCoordinator` deduplicates against a local `target.last`. Because an unchanged desktop capacity
  keeps producing the same measurement, staleness is a **fixed point, not a race** — it can never
  self-correct.
- `src/server.js:3847-3871` (baseline) accepted **any** attached client's resize with no ownership,
  revision, serialization, validation, or broadcast.
- `src/base-bridge.js:603-613` swallowed `process.resize()` failures; the server swallowed them a
  second time.
- Raw advertisements also resized the **sticky-note transcript**, so summaries could rewrap
  independently of the actual PTY.
- The file browser was **fixed-positioned outside layout**; `_adjustTerminal()` was a no-op and
  `_refitAllTerminals()` was dead code.

## Load-bearing constraints (research conclusions)

1. A **real docked layout** — not pixel subtraction.
2. Advertisements **never** claim ownership.
3. **Distinct outer-capacity and inner-grid elements**.
4. **Four separate client geometry states** (capacity / last-advertised / authoritative-applied / rendered).
5. **Explicit withdrawal** below `20x5`.
6. **Ordered authoritative geometry before resize-triggered output.**

## Investigated and RULED OUT (with reasons)

As valuable as what was confirmed — these are dead ends not to revisit:

- `target.last = applied` reclamation — reintroduces oscillation.
- Incidental-layout / most-recently-used ownership.
- Dock-width **pixel subtraction**.
- `wsId`-only identity.
- **Letterboxing when capacity is smaller than applied** — impossible in that direction; needs
  scale or pan.

## Windows-specific hazards

- The probe command was **PowerShell-only**.
- **UNKNOWN/FAIL results still exited zero** — a check that cannot fail proves nothing.
- The known **ConPTY teardown crash** (`AttachConsole failed`).
- Font-metric divergence between Windows and Linux (above).

## Explicitly unresolved in the finalized review

These were never decided and remain open:

- Initial ownership semantics (who owns a session at creation).
- Exact claim/input ordering.
- Continuous drawer-drag behaviour.
- Concrete pan/scale UX thresholds.
- Ownership UI (how a user sees or takes control).
- The exhaustive redesign state matrix.

## Provenance note

The first extraction attempt produced no output; these findings come from a retry. The extracting
agent was read-only, so this file was written by the lead from its reported findings rather than
directly by the agent.
