# ADR-0052: Multi-viewer terminal geometry

## Status

Accepted (2026-08-05). **Supersedes the single-viewer assumption in
[ADR-0046](0046-terminal-geometry-contract.md).** ADR-0046 remains accurate for everything it
describes about a single browser measuring itself; it simply never contemplated two viewers sharing
one PTY.

## Context

A PTY has exactly one size. The client may not.

ADR-0046 made `FitCoordinator` the sole owner of browser resize calls and outbound resize messages.
That is correct and stays. But it reasons about one browser, and the server matched it: the `resize`
handler applied whatever geometry any member connection sent, with no arbitration and no notification
to the others.

Measured on Windows against that behaviour:

| scenario | result |
|---|---|
| desktop alone | xterm 163x45, PTY 163x45 — correct |
| phone joins the same session | PTY becomes 38x39; **desktop still renders 163x45** |
| 4s later | no change — no self-heal |
| **phone disconnects** | **still 163x45 vs 38x39 — permanent** |
| docked file browser opened | 350px panel hides ~40 of 163 columns; terminal cols unchanged |

The desktop kept rendering 163 columns while the program wrapped at 38. It never recovered, because
`FitCoordinator` dedupes against its own last measurement: the desktop's container never changed, so
`unchanged` stayed true forever and it never re-sent. The stale state was a fixed point, not a race.

## Decision

Geometry is owned, not raced.

1. **Advertising capacity never claims the PTY.** An attachment reports what it can display. That
   updates fallback state only.
2. **Exactly one attachment holds an owner lease.** Only the owner's capacity drives `pty.resize`.
3. **The lease transfers only on a deliberate act** — real user input from that device — never on an
   incidental layout event. Orientation change, soft keyboard, panel drag, a bounded retry and a
   reconnect are all advertisements that must not claim.
4. **The server assigns a monotonic revision** and serializes application per session. Clients ignore
   stale revisions.
5. **A session epoch covers restart.** The PTY survives; the attachment map does not. Reconnecting
   clients re-advertise without claiming.
6. **State is keyed by `(sessionId, connectionId, viewId)`.**
7. **Resize is a transaction.** Output is held from the moment application begins until the applied
   frame has been broadcast, so resize-caused redraw can never render against the old dimensions. The
   hold carries a 15s watchdog that releases buffered output and reports
   `geometry_transaction_timeout`.
8. **Applied geometry is committed only after `pty.resize` succeeds.** This requires the resize to
   propagate its failure; `BaseBridge.resize` previously swallowed it.
9. **Below the usable floor a viewer withdraws explicitly**, rather than leaving a stale sub-floor
   advertisement that could later become authoritative.

### Wire protocol

`type: 'resize'` is **preserved**, extended with an optional `viewId`. Withdrawal is a new
`type: 'geometry_withdraw'`. Keeping the existing message shape means older clients continue to
advertise correctly; they simply never claim.

## Consequences

- A non-owner must present the authoritative applied geometry rather than its own capacity. That is
  Layer 3 and is **not yet implemented** — see `.docs/geometry-implementation-status.md`. The
  validated target is regime `pan`.
- Presentation must not perturb measurement, so outer-capacity and inner-grid must be distinct
  elements and the regime must be a pure function of (outer rect, applied, cell metric).
- The sticky-note summariser must follow the *applied* geometry, not the raw advertisement.
  Otherwise decoupling advertisement from the PTY silently makes a phone's 38-column advertisement
  the wrapping width for every viewer's transcript and auto title.
- Resize latency increases: the output hold lasts as long as the PTY resize. On Windows under load
  this is measurable (3-5s with several PTYs alive, versus under 3s idle).

## Alternatives rejected

**Most-recent-writer-wins.** Every incidental layout event becomes an ownership claim, so two
attached viewers ping-pong: desktop measures 163 != last 38 and sends 163; phone then measures 38 !=
last 163 and sends 38; repeat. A phone emits `visualViewport` events constantly, so this thrashes in
practice, and each flip resizes the PTY and forces a full TUI redraw. Explicit ownership removes the
feedback path rather than damping it.

**`target.last = applied` reclamation.** The same loop in a subtler disguise; it was proposed as an
elegant way for a letterboxed viewer to reclaim automatically, and traced to the same oscillation.

**Font-size scaling for non-owner presentation.** The vendored fit addon divides by the live
font-derived cell metric, so scaling the font perturbs the very input the measurement depends on —
reproducing the refuted oscillation through a different door. Presentation must use a transform on an
inner stage.

**Letterboxing when capacity < applied.** Impossible in that direction. A 390px phone cannot letterbox
163 columns; it must scale or pan.

**Dock-width pixel subtraction** for docked chrome. `floor(a/c) - floor(b/c) != floor((a-b)/c)`, and
panel width is not the visible overlap mid-transition. The terminal's usable area must be a real
layout region that `ResizeObserver` reports.

**`wsId`-only identity.** Splits use a socket per pane, so socket identity is not view identity.
(The original rationale for the composite key claimed one socket hosts multiple panes; that premise
was wrong, but the conclusion holds for the opposite reason.)

**Smallest-wins (tmux's model).** Never renders wrapped garbage, but a phone left attached in a pocket
pins a desktop to 38 columns.
