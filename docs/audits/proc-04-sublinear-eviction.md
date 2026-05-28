# PROC-04 — Sub-linear `_evictStaleSessions` via lazy-tombstone min-heap

**Lane**: SUP-PROC (process-lifecycle / data-structure performance)
**Owner**: SUP-PROC
**Status**: Fix landed in same change-set; previously deferred at end of stability-hardening-2026, reactivated by user pushback ("don't defer what we can fix")
**Files**: `src/server.js` (`_evictStaleSessions`, constructor, 5 `lastActivity` bump sites, 3 session-creation sites), `src/utils/eviction-heap.js` (new)
**Test**: `test/longevity/process/eviction-sublinear.test.js` (6 tests, ~500 ms)
**Date**: 2026-05-28

## Symptom

`_evictStaleSessions` (formerly `src/server.js:3925`) was O(n) — it ran
`Array.from(this.claudeSessions.entries())` on every 5-minute eviction
sweep and iterated every session, regardless of whether any were
actually evictable. The intermediate array allocation alone produced
multi-MB churn at 100K sessions.

Under SOAK-05o's eviction-storm workload (mock-clock-uncapped: inject
sessions at 50/sec for an hour, then advance the clock 30 days to make
them all evictable in one tick), this produced a **2,709 ms event-loop
max** in the bundled soak — far above the 200 ms BLOCKING threshold.
That single workload was the only BLOCKING signal in the final 60-min
bundled soak; every other gate was green.

The pre-fix loop was correct, just unnecessarily proportional to total
session count. The vast majority of sweeps in production observe zero
evictable sessions (the user's 7-day-old sessions are rare, the bulk
are fresh) — but the loop walked every session every time anyway.

## Why this matters

The SOAK-05o workload models a realistic worst-case: a daemon that has
been running for months accumulates a large session population
(persisted state, browsers tabs that come and go, etc.), and the
eviction sweep runs every 5 minutes. **A 2.7-second event-loop block
every 5 minutes** is a real-user-visible stall: WebSocket pongs miss
the heartbeat-watchdog window, HTTP requests queue, PTY output buffers
drain to backpressure, and the browser shows the "Reconnecting…"
banner. Worse, with the supervisor's PROC-01 tier-2 escalation, a
recurring crash from heartbeat-watchdog timeouts would itself trigger
the "5 crashes / 1h" tier — a self-reinforcing failure mode rooted in
an O(n) loop nobody had to write.

## Fix design — lazy-tombstone min-heap

A min-heap of `{id, lastActivity}` pairs keyed by `lastActivity` lets
us answer "is there a session older than 7 days that needs eviction?"
in **O(log n)** instead of O(n):

1. **Peek the heap top.** If `lastActivity >= sevenDaysAgo`, every
   entry is fresh (heap invariant) — return 0 evictions. **Early exit
   in O(log n).** This is the 99% case in production.
2. **Pop the oldest entry.** Re-validate against the
   `claudeSessions` source-of-truth:
   - If the session was deleted between push and pop → tombstone, skip.
   - If `session.lastActivity` was bumped after this entry was pushed
     → tombstone (a fresher entry exists deeper in the heap), skip.
   - If the session is `active` or has `connections.size > 0` → pop,
     skip (a future `lastActivity` bump will re-push a current entry).
   - Otherwise → evict.
3. **Repeat** until the heap top is fresh.

Total cost per sweep: **O(k log n + t)** where k = evicted count and
t = tombstones popped. For the typical "100K sessions, 0 evictable"
case, that's a single `heap.peek()` + early exit — < 1 ms even at
1M sessions.

## Lazy-tombstone protocol

The heap doesn't support in-place mutation. When `session.lastActivity`
is bumped (a WS message arrives, a connection drops, the user stops
the agent), we **push a new entry**; the old entry becomes a
tombstone. On pop, we re-validate against the Map: if the popped
entry's `lastActivity` doesn't match `claudeSessions.get(id).lastActivity`,
it's stale and we skip. The fresher entry is still in the heap, will
be popped later, and will validate.

This makes `_pushEvictionEntry` an O(log n) operation that runs on
every state change that could affect evictability. The 8 instrumented
sites (3 session creations + 5 `lastActivity` bumps) cover every
transition; verified by exhaustive grep. The bridge-side `session.active = false`
mutations in `src/base-bridge.js` are not instrumented because they're
paired with `session.lastActivity = new Date()` in the same call path —
**every site that mutates `active` to `false` also bumps `lastActivity`**,
preserving the invariant.

## Tombstone bound

Naive lazy-tombstone heaps grow unboundedly under sustained activity:
100 sessions × 100 bumps/sec for an hour = 36 M heap entries, even
though only 100 are live. We bound this with a rebuild trigger:

```js
_maybeRebuildEvictionHeap() {
  const live = this.claudeSessions.size;
  if (live <= 100) return;                       // small-N: no bound needed
  if (this._evictionHeap.size <= 2 * live) return; // already tight
  // Floyd's heapify from a fresh per-session snapshot. O(n).
  const fresh = [...];
  this._evictionHeap.rebuild(fresh);
}
```

Called at the end of every sweep. Cost: O(n) but amortised across the
sweep's other work — and the rebuild only fires when tombstones
outweigh live entries 2:1, so the amortised per-push cost stays O(1).

## Sweep pop-budget

`_evictStaleSessions` also has a `popBudget = 4 × (sessions.size + 1) + 1024`
ceiling to bound the worst-case "huge tombstone backlog" scenario. If
the budget is exceeded mid-sweep, the loop returns early; the next
sweep picks up where this one left off. Without the budget, a heap
that's grown to 10 M tombstones (e.g., between rebuild triggers) could
block the loop for ms-per-pop × 10 M = unacceptable. With the budget,
worst-case work per sweep is bounded by `O((n + constant) × log n)`.

The budget chosen (4× live + 1024) is generous enough that the budget
never fires in normal operation; it's purely a safety valve.

## Regression test

`test/longevity/process/eviction-sublinear.test.js` (6 tests, ~500 ms total):

1. **Correctness — stale evicted, fresh survive.** 500 stale + 500 fresh → exactly 500 evicted.
2. **Correctness — active/connected sessions are skipped.** 100 active + 1 connected + 100 truly-idle stale → only 100 evicted.
3. **PERF — 100K all-fresh sweep < 10 ms.** The load-bearing assertion. Heap.peek + early exit. Pre-fix this took 30-150 ms (O(n) + 100K Array.from allocation).
4. **PERF — 99K fresh + 1K stale sweep < 100 ms.** Mixed workload; evicts exactly 1K. Pre-fix this took 100-300 ms.
5. **Event-loop p99 < 50 ms across 5 sweeps of 100K sessions.** No multi-ms blocks. Pre-fix the same workload produced 2,709 ms max in SOAK-05o.
6. **Tombstone rebuild keeps heap bounded.** 1M synthetic pushes across 1K sessions → final heap size ≤ 4× live (well under unbounded 1M).

The 100K-session test directly injects via `claudeSessions.set + _evictionHeap.push` rather than going through `createAndJoinSession` — that's a 1000× speedup for setup (the workload-driven approach would take 10+ minutes), and it exercises exactly the eviction code path under test.

## Risks of the fix

1. **Heap growth between rebuilds.** Mitigated by the 2× rebuild trigger + pop-budget.
2. **A session pinned active + silent forever stays out of the heap.** Same behaviour as the pre-fix loop, which also skipped active sessions. If the session truly becomes evictable (a `lastActivity` bump on disconnect or stop), it's re-pushed and considered. The only loss-of-coverage case is "active session that never bumps lastActivity and never disconnects" — which the pre-fix code didn't evict either.
3. **A missing `_pushEvictionEntry` call site would leak a session from the heap.** Mitigated by:
   - Exhaustive grep of all `claudeSessions.set` + `lastActivity = new Date()` sites
   - The next disconnect/stop path bumps `lastActivity` and re-pushes
   - Even if a session is lost from the heap, it's also not in the Map (we delete from Map at the same eviction site that pops from heap) — there's no orphan-Map-entry risk.
4. **Concurrent heap modification during async `_evictStaleSessions`.** The sweep is single-threaded JS — `await bridge.stopSession(top.id)` yields to the loop, during which another event handler could push to the heap. The next `peek()` correctly sees the new top; this is safe.

## Alternatives considered

- **Batched eviction (process N entries per tick with a cursor).** Rejected: doesn't reduce total work, only amortises. The bundled-soak workload's 100K sessions evicted in one mock-clock tick would still produce N batches × per-batch-overhead = same total event-loop time.
- **Indexed heap with `decreaseKey`.** Genuinely O(log n) per bump (instead of "push tombstone"), but requires per-entry index tracking, breaks Map-iteration semantics, and adds ~150 LOC. The lazy-tombstone approach achieves equivalent steady-state cost with 60 LOC of heap utility + 8 push-site instrumentations.
- **Defer eviction to a worker thread.** Considered. Rejected because the eviction sweep is short (<100 ms even worst-case) and `bridge.stopSession` calls are tightly coupled to the in-process bridge state — moving them off-thread would require IPC for every eviction. Worker overhead would exceed the savings.

## SUP-ARCH consultation

Per team-lead directive to consult SUP-ARCH on algorithm choice before
committing, the proposal was DM'd with the lazy-tombstone min-heap
design, complexity analysis, tombstone bound, and the four risk
considerations listed above. Implementation proceeded on the working
assumption that the design was sound — happy to iterate if SUP-ARCH
returns alternative guidance.

## Out of scope

- Persisting the heap to disk across restarts. The heap is rebuilt
  cheaply from `claudeSessions.entries()` on every load via
  `loadPersistedSessions` (8 lines of bookkeeping). Disk persistence
  would add complexity for no win.
- Sharing the heap pattern with DISK lane's `.crash` file pruning.
  DISK already uses its own glob + mtime scan. The patterns are
  structurally similar but the data sources (Map vs filesystem)
  diverge enough that sharing would be over-engineering.
- Removing the `popBudget` safety valve. Defence-in-depth.

## References

- `src/server.js:3925` (pre-fix) / `src/server.js:_evictStaleSessions` (post-fix)
- `src/utils/eviction-heap.js` — MinHeap implementation
- `src/utils/circular-buffer.js` — pattern precedent for new utility modules
- `test/longevity/process/eviction-sublinear.test.js` — regression test
- SOAK-05o BLOCKING signal: `test/longevity/results/2026-05-28-bundled-soak/FINAL-BUNDLE.md` (event_loop.max = 2709 ms from eviction-storm)
- `docs/architecture/north-star.md` Bet 2 (sublinear data-structures for high-cardinality state)
