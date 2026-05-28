# Deferred from stability-hardening-2026 — Open Architectural Questions

**Owner:** SUP-ARCH
**Date:** 2026-05-28
**Companion to:** [`north-star.md`](north-star.md), the campaign post-mortems in
`docs/history/`, and the in-flight task list (SOAK-05n, PROC-04, SOAK-05o
cap).

The stability-hardening-2026 campaign closed every named gap from the
audit phase. Three items surfaced during the run but **did not ship**.
Each is framed here as an architectural question — not a TODO — so the
next campaign or whoever picks them up understands what is *actually*
unresolved and not just what was on the punch list.

The trio shares a cross-cutting pattern, called out at the bottom.

---

## 1. PROC-04 — Sub-linear `_evictStaleSessions`

**Symptom:** `_evictStaleSessions` is O(n) per sweep. Invisible at
realistic single-user session counts (≤ 500). At 178 k synthetic
sessions (SOAK-05m via runaway mock-clock), the sweep dominates the
event-loop and the heap working set, pushing `event_loop.max_ms` to
2 709 ms and RSS to 2.4 GB — the headline FAIL of the final soak.

**Architectural question:** is "evict in O(n) and trust that n stays
small" an acceptable shape for a Map whose growth path is governed by
external workload, or is it a latent contract that the daemon's
months-uptime promise has already silently violated for any user
running an unusual pattern?

**Why it matters for the north star:** Bet 2 ("sub-linear eviction
across all evictable Maps") is the load-bearing direction. PROC-04 is
the first reified case. The right long-term shape is a time-indexed
expiry heap (or LRU-on-touch) whose sweep cost scales with **eviction
count**, not Map size — but committing to that shape touches every
evictable Map in the daemon, not just one.

**Priority:** **HIGH for north-star alignment, LOW for production
urgency.** It is the cleanest demonstration of Bet 2 in the codebase.
The fix itself is bounded engineering once the architectural decision
is made.

**Trigger condition for implementation:** ship PROC-04 when ANY of
these hold:
1. Real-user session count is observed crossing **10 K** in
   `_collectDiagnostics().sessions.count` on any operator's
   diagnostics tick.
2. The next bounded-structure campaign generalizes the eviction
   shape across at least one other Map (file-watcher cache,
   restartManager history, etc.) — PROC-04 rides along.
3. SOAK-05o's mock-clock cap is loosened back to original rates AND
   the harness wants to stress-test 60-min × 100 k synthetic sessions
   as a directional regression.

Until then, the workaround (SOAK-05o capping mock-clock injection at
50 sess/sec × 3 000 total) preserves the soak methodology without
pressuring the production code path.

---

## 2. SOAK-05n — WS-broadcast pty-flood variant + vacuous-PASS guard

**Status: ✅ SHIPPED IN CAMPAIGN** (commits on `sup-soak/soak-05ln`).
Activated by team-lead's "Don't defer what we can fix" pushback after
this doc's initial draft routed it to deferred. Both parts shipped:

1. **`pty-flood-ws` workload** at `test/longevity/harness/workloads/pty-flood-ws-workload.js`.
   Drives `server._throttledOutputBroadcast(sessionId, chunk)` directly,
   so output flows through the production coalescer → binary WS frame →
   browser `app.terminal.write` → `PlanDetector.processOutput`. Default
   1 MB/s smoke; plan-spec 5 MB/s stress via `--workload-opts=pty-flood-ws.targetBytesPerSecond=5242880`.
2. **Vacuous-PASS guard** in `harness/gate-evaluator.js`. A gate's
   `evaluate()` may return `{pass: 'vacuous', summary: '...'}`; the
   evaluator surfaces `vacuous_count` in the result and forces
   `overall: false` when any gate is vacuous. CLI prints `[VAC ]` for
   the per-gate verdict. Applied to `client.plan_detector` (peak == 0
   → vacuous). Unit test at `test/longevity/gate-evaluator-vacuous.test.js`
   verifies the contract (5 specs).

**Why activated now**: team-lead's deferral bar is "high risk / breakage /
can't confidently carry out and validate." Neither met that bar — the
workload is harness-additive, the guard is a one-shot enum-state addition,
and both have unit coverage. Activating them now means the next 4-h or
12-h soak can produce a non-vacuous CLIENT-01 verdict.

**Original architectural framing preserved** (the "vacuous PASS is worse
than a FAIL" insight stays valid as future-campaign guidance):

> The harness invariant — "any cap-on-observed-activity gate fails on
> zero observed activity unless explicitly marked ceiling-only" —
> generalizes across every future cap-style gate, not just plan-detector.
> Future cap gates should opt in by returning `'vacuous'` when their
> metric is at the empty/baseline value.

---

## 2b. (historical — original deferred framing for archaeologists)

The original deferred-list entry for SOAK-05n is preserved below for
context. The team-lead's "don't defer what we can fix" decision-rule
that activated it is the load-bearing lesson; this entry shows what the
deferral case looked like.

> **Symptom:** the bundled soak's `client.plan_detector.bytes` gate
> PASSED at peak **0 MB** — not because CLIENT-01's 8 MB cap held, but
> because the `pty-flood` workload drives `terminalBridge._handleOsc7Chunk`
> internally and **never broadcasts to the attached browser tab via the
> WS layer**. The browser's plan-detector buffer received zero bytes
> under a workload literally named "pty-flood." The cap was never
> exercised end-to-end by the soak.

(Rest of original entry omitted — see git history at parent commit for
the full "why it matters for the north star" discussion.)

---

## 3. The mock-clock-cap workaround as a question about real session-injection headroom

**Symptom:** SOAK-05o caps the mock-clock workload at 50 sess/sec ×
3 000 total to keep the soak methodology coherent for 60-min runs.
This is the right move for the harness — without it, every long
soak's verdict becomes a referendum on PROC-04 rather than on the
bundle under test.

**Architectural question that the cap masks:** **what is the actual
session-injection headroom of the production daemon?** The user's
real session-create rate is in the dozens-per-day range, not 50/sec.
But the daemon also processes session-create on burst patterns we
don't currently measure — e.g., browser tab reload after an extended
outage may attempt many `join_session` (and occasionally fresh
`create_session`) calls in a short window; a future feature may
spawn N sessions for parallel tool use; the test fixtures themselves
sometimes burst. The cap is "what the harness can drive without
artifacting." We have no current measurement of "what the daemon
should be able to absorb before degrading."

**Why it matters for the north star:** Bet 1 ("typed `BoundedX<T>`
family") and Bet 2 ("sub-linear eviction") together imply a
**throughput contract** that the daemon should publish and stand
behind. Capping the harness to dodge the question is correct for
methodology purity but defers the architectural answer indefinitely.

**Priority:** **LOW for production urgency, MEDIUM for understanding
the daemon's envelope.** Likely the right shape is a small targeted
microbenchmark (not a soak workload) that measures
session-create-per-second at increasing concurrency, against a
production-shaped fixture (`sessions.json` populated with realistic
count + size), reported alongside the diagnostics tick once per
release.

**Trigger condition for implementation:** measure session-injection
headroom when ANY of these hold:
1. A new feature is proposed that creates sessions in bursts
   (parallel tool use, multi-pane spawning, scripted automation).
2. PROC-04 ships — at that point the headroom is no longer governed
   by Map eviction cost and the real bottleneck (atomic-save mutex?
   ws.broadcast?) becomes the visible constraint.
3. The next quarterly horizon-stress exercise. A 5-minute
   microbenchmark, reported once, beats indefinite uncertainty.

---

## The cross-cutting pattern

All three deferred items are **gaps between what the harness
measures and what production experiences**.

- **PROC-04** — harness drove a Map to a size production will never
  see, exposing a linear-cost shape that's invisible at production
  scale today but binds the codebase's long-term scaling story.
- **SOAK-05n** — harness drives a path production doesn't use,
  producing a verdict that doesn't apply to production at all.
- **The mock-clock cap** — harness has to be artificially constrained
  to stay relevant, masking an unmeasured production envelope.

The next architectural step beyond patching each of these one-by-one
is to **make the harness explicitly model the production envelope**,
not just an arbitrary stress shape:

- Workloads tagged with the production path they exercise (server WS
  broadcast vs internal bridge seam).
- Gates tagged with the production scale they are valid at (low / med
  / high session count).
- Headroom measurements published per release as ranges, not points.

This is not a fourth deferred item — it is the **direction** all
three deferred items point in. Worth surfacing in the next campaign's
plan as the framing for the SOAK lane.

---

## References

- [`north-star.md`](north-star.md) §10 (bets 1, 2, 3) for the
  directions these items support.
- `.claude/worktrees/sup-soak/test/longevity/results/` — raw soak
  data backing the symptom descriptions.
- `docs/history/stability-hardening-2026-sup-client.md` — CLIENT-01
  vacuous-PASS context.
- `docs/history/disk-hygiene-2026.md` — the cross-lane integration
  pattern that should govern any follow-up wiring.
- Task list: PROC-04 (#44), SOAK-05n (#45), SOAK-05o (#42), SOAK-05p
  (#43).
