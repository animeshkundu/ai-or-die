# PROC-01 — Supervisor circuit-breaker & slow-crash behaviour

**Lane**: SUP-PROC (process-lifecycle / external dependencies)
**Owner**: SUP-PROC
**Status**: Investigation + fix landed in same change-set
**Files**: `bin/supervisor.js` (122 LOC, fully rewritten in scope of fix)
**Test**: `test/longevity/process/supervisor-slow-crash.test.js`
**Date**: 2026-05-27

## Symptom

`bin/supervisor.js` runs the daemon under a parent supervisor with a
single circuit-breaker: **3 crashes within 30 s → `process.exit(1)`**
(permanent shutdown, lines 11-13, 61-65 on `main` HEAD before this fix).

This catches the *tight* crash loop — a server that crashes immediately
on boot (port-bind error, missing dependency, syntax error in a
hot-reloaded module) — but the asymmetry of the design produces two bad
outcomes for a single-user, months-long daemon:

1. **Tight-loop case → permanent halt is too aggressive.** A flaky
   network or transient EADDRINUSE can trip 3-in-30s during the user's
   reboot of their network adapter. The supervisor then exits 1 and the
   user has no daemon until they SSH in and `npm start` again. For a
   browser-resident user who just wants the app back, this is the worst
   possible failure mode.
2. **Slow-crash case → infinite respawn masks the bug.** A server that
   crashes once every 31 s (or worse, once every 5 min) never trips the
   30 s window. The supervisor merrily restarts forever, burning CPU,
   producing log noise, and concealing the underlying defect from any
   operator who happens to check on it. After a week of 5-min crashes
   that's 2 016 respawns; after a month, ~8 600. None of them visible in
   `[diagnostics]` heartbeat output because each spawned server gets a
   fresh start time and clean state.

Neither extreme is right. The fix introduces a tiered escalation:

| Window | Threshold | Response |
|---|---|---|
| 30 s | 3 crashes | **Tier 1**: log loud, restart delay = 60 s |
| 1 h  | 5 crashes | **Tier 2**: log louder, restart delay = 5 min, IPC-broadcast a warning |

The supervisor **never permanently exits** on a crash sequence. The
charter is explicit on this: a single-user daemon must always come back
so the user can recover via the browser — having to SSH in to relaunch
defeats the deployment model.

## Why "never exit" is the right call

The current `process.exit(1)` was inherited from server-fleet thinking
where systemd / an orchestrator notices the exit and either restarts
externally or pages an operator. **There is no such orchestrator here.**
The supervisor IS the orchestrator. If the supervisor exits, the daemon
is gone until the user notices and re-launches it manually. For a 100%
uptime expectation across months, that bound is loose.

If the server is genuinely unrecoverable (e.g. corrupted state file,
missing native dep), the tier-2 5-minute respawn cadence is the
mitigation: 288 respawns/day instead of 28 800/day. The error itself
will be evident in the loud tier-2 logs.

## Repro

`test/longevity/process/supervisor-slow-crash.test.js` exercises four
crash cadences against an always-crashing mock child:

1. **Tight loop**: 3 crashes in <200 ms → expect tier-1 escalation log,
   restart delay extended to the tier-1 value, supervisor still alive.
2. **Just-below-tier-1**: 2 crashes in 200 ms then quiet → no
   escalation, normal restart delay used, supervisor still alive.
3. **Sustained slow churn**: 5 crashes across a 2 s window with each
   crash 400 ms apart → tier-2 escalation log fires, restart delay
   extended to the tier-2 value, supervisor still alive.
4. **Never-give-up invariant**: after tier-2 fires, drive 3 more crashes
   and assert the supervisor is still spawning, did NOT call
   `process.exit(1)`, and the IPC warning was emitted.

Test uses env-var overrides for the windows and delays so it completes
in seconds instead of hours:

```
CIRCUIT_BREAKER_WINDOW_MS=200
CIRCUIT_BREAKER_MAX_CRASHES=3
SUSTAINED_CRASH_WINDOW_MS=2000
SUSTAINED_CRASH_MAX=5
TIER1_RESTART_DELAY_MS=120
TIER2_RESTART_DELAY_MS=240
CRASH_RESTART_DELAY_MS=20
```

Defaults in production code remain the human-scale values (30 s, 3, 1 h,
5, 60 s, 5 min, 3 s).

## Fix design

### Algorithm

On every unexpected child exit:

1. Record the current timestamp in `crashTimestamps`.
2. Trim timestamps older than `SUSTAINED_CRASH_WINDOW_MS` (1 h default).
3. Count timestamps within `SUSTAINED_CRASH_WINDOW_MS` → if ≥
   `SUSTAINED_CRASH_MAX` (5), **enter tier 2**:
   - Log a multi-line WARN to stderr ("supervisor: 5+ crashes in last 1h").
   - Emit IPC `{ type: 'supervisor_warning', tier: 2, crashes, windowMs }`
     to the next spawned child (queued via `_pendingWarning` and flushed
     once the next child connects IPC).
   - Set next restart delay = `TIER2_RESTART_DELAY_MS` (5 min).
4. Else count timestamps within `CIRCUIT_BREAKER_WINDOW_MS` (30 s) → if
   ≥ `CIRCUIT_BREAKER_MAX_CRASHES` (3), **enter tier 1**:
   - Log a WARN ("supervisor: 3+ crashes in last 30s").
   - Set next restart delay = `TIER1_RESTART_DELAY_MS` (60 s).
5. Else use the normal `CRASH_RESTART_DELAY_MS` (3 s).
6. **Never** call `process.exit(1)` from this path.

The two windows are evaluated independently and the higher tier wins
(tier 2 takes precedence). This naturally handles the case where a
tight loop fires inside an already-elevated tier-2 window.

### IPC warning to the next child

When the supervisor decides to escalate to tier 2, the next spawned
server needs to know — so it can render a "your supervisor is escalating
restart cadence" banner in the browser UI. We can't tell the
already-exited child anything, so we queue the warning in
`_pendingWarning` and send it once the IPC channel of the next child
opens (`child.on('spawn', () => { if (_pendingWarning) child.send(_pendingWarning); ... })`).
The child's IPC listener (`setupIpcListener`, `src/server.js:219`) will
need a follow-up to handle `supervisor_warning` and forward it to the
client — that's tracked separately as a future CLIENT-04 task (memo
mentions it; not in scope for this PR because the server-side IPC
handler doesn't exist yet).

### Why tier 1 = 60 s and tier 2 = 5 min

- Tier 1 (60 s) buys the operator a minute to see the problem and
  intervene without permanently halting the daemon. 60 s is short
  enough that an inadvertent flap (network hiccup) costs the user one
  minute of downtime, long enough to break the tight respawn loop on a
  port-bind contention with another process.
- Tier 2 (5 min) is the "this is real" cadence: 288 respawns/day puts
  enough log entries in front of the operator that a real bug will be
  noticed within hours, while the cadence is slow enough that the
  per-respawn cost (node startup, fs I/O, log volume) is bounded.

### Env-var override discipline

All five constants are read from `process.env.*` with `parseInt(...,
10)` and the literal defaults above. This lets the regression test
shrink the windows to subseconds AND lets a Windows or macOS operator
tweak the cadence without editing source. Validation: `parseInt`
returns `NaN` on invalid input → the `|| DEFAULT` fallback handles it
gracefully.

## Risks of the fix

1. **An unrecoverable startup error (e.g. corrupted state file) now
   loops at tier-2 cadence forever instead of halting.** This is
   intentional per charter. Mitigation: the tier-2 log is loud and
   includes the crash count + time window so any operator who looks at
   `server.log` will see the loop within a few entries.
2. **A pathological respawn rate could fill `crashTimestamps` if the
   window grows unboundedly.** Mitigation: the array is trimmed to the
   longest window (1 h) on every crash, so its size is bounded by
   "crashes in last 1 h" — even at 1-per-second worst case, that's
   3 600 entries × ~8 bytes = 28 KB. Negligible.
3. **IPC `supervisor_warning` is sent to a server that doesn't yet
   handle it.** No-op on the receiver side; will be wired up in
   CLIENT-04. Until then the warning is just in the supervisor log.
4. **Tier escalation persists for the lifetime of the window.** A user
   who fixes the underlying bug must wait up to 1 h (the longest
   window) for the next crash-detection to be "fresh". This is acceptable
   — after the bug is fixed there shouldn't be a next crash, so the
   window content stays at zero.

## What this does NOT change

- The 0-exit-code clean shutdown path (no restart).
- The `RESTART_EXIT_CODE` (75) handling — still a quick respawn, never
  counted as a crash.
- The IPC `shutdown` graceful path.
- The `SIGINT` / `SIGTERM` handling.
- The 10 s hard-kill timeout on shutdown.

## References

- `bin/supervisor.js` — entire file (rewritten)
- `src/restart-manager.js` — the in-process RestartManager (NOT the
  supervisor; do not conflate). Owns RSS-based GC trigger and 5-min
  restart rate-limit on the in-process path.
- `test/supervisor-integration.test.js` — pattern for testing the
  supervisor via IPC. Tier escalation tests inherit the mock child
  shape from `test/fixtures/mock-supervised-server.js`.
- `test/longevity/process/supervisor-slow-crash.test.js` — regression
  test for this fix.
