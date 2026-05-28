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

## 1. PROC-04 — Sub-linear `_evictStaleSessions` ✅ SHIPPED IN CAMPAIGN

**Status (2026-05-28):** Activated by user pushback ("don't defer what we
can fix"). Shipped as `sup-proc/proc-04-sublinear-eviction` —
lazy-tombstone min-heap, O(log n) sweep when no work is needed,
O(k log n + t) when k sessions need eviction. Memo:
[`docs/audits/proc-04-sublinear-eviction.md`](../audits/proc-04-sublinear-eviction.md).
Regression test: `test/longevity/process/eviction-sublinear.test.js`
(6 tests, ~500 ms). Bundled into `stability-hardening-2026` via SUP-REL.

The original deferral context (below) is retained for posterity — the
fix is now landed but the architectural notes about Bet 2 ("sub-linear
eviction across all evictable Maps") remain valid for future evictable
Maps the daemon may grow (file-watcher cache, restartManager history,
etc.). PROC-04's min-heap pattern + lazy-tombstone protocol +
`_maybeRebuild` trigger are reusable templates.

---

**Original deferral context (pre-2026-05-28, retained as historical record):**

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

**Symptom:** the bundled soak's `client.plan_detector.bytes` gate
PASSED at peak **0 MB** — not because CLIENT-01's 8 MB cap held, but
because the `pty-flood` workload drives `terminalBridge._handleOsc7Chunk`
internally and **never broadcasts to the attached browser tab via the
WS layer**. The browser's plan-detector buffer received zero bytes
under a workload literally named "pty-flood." The cap was never
exercised end-to-end by the soak.

**Architectural question:** when a synthetic workload bypasses the
production observation path, is the resulting "PASS" honest enough to
gate a merge on? More generally — what is the contract between
**workload generators** and **observation gates**? Today the
gate-evaluator treats absent activity as PASS-by-default. The
discipline that exposes this gap (the "meaningfulness check") is a
harness-level invariant, not a fix-lane concern.

**Why it matters for the north star:** Bet 3 ("diagnostics endpoint
as the operator's primary observation surface") only works if the
gates measure what they claim to measure. A vacuous PASS is worse
than a FAIL because it advertises a guarantee that the soak did not
verify. The harness invariant — "any cap-on-observed-activity gate
fails on zero observed activity unless explicitly marked
ceiling-only" — generalizes across every future cap-style gate, not
just plan-detector.

**Priority:** **MEDIUM-HIGH.** Two related deliverables:
1. **WS-broadcast variant of pty-flood** (so the cap is actually
   exercised end-to-end by a future 4-h or 12-h soak — the only time
   horizon at which CLIENT-01's value is observable).
2. **Vacuous-PASS guard** in `gate-evaluator.js` so future
   cap-on-observed-activity gates don't quietly succeed at zero.

**Trigger condition for implementation:** ship before the next
campaign that introduces a new cap-style gate (CLIENT-04, DISK-05,
anything that puts a ceiling on a sampled metric). Or ride along with
the next 4-h soak attempt that the team-lead requests for
post-bundle validation — the WS-broadcast pty-flood is what makes
that 4-h soak's CLIENT-01 verdict meaningful.

Until then, CLIENT-01's enforcement is verified by the deterministic
unit test (`test/plan-detector.test.js`) and the Playwright spec —
both honest but neither at production-scale durations.

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
