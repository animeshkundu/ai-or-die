# DISK-03 — ENOSPC handling + `~/.ai-or-die/` size cap

**Lane**: SUP-DISK (persistence / disk hygiene)
**Owner**: SUP-DISK
**Status**: Implementation landing in this PR (after DISK-02).
**Files**:
- `src/server.js` (`_collectDiagnostics`, `_sampleDiskUsage`,
  `_diskCompactionSweep`, ENOSPC catch sites)
- `src/utils/session-store.js` (already returns false on write failure;
  no further change needed for ENOSPC — error is surfaced via
  `saveSessionsToDisk` failure log + `disk_full` broadcast)
- `test/longevity/disk/enospc-handling.test.js` (regression test;
  Linux-only with manual repro documented for macOS/Windows)
**Date**: 2026-05-27

## Symptom

The daemon today has **no concept of disk pressure**. Three failure
modes that bite a months-long-uptime single-user box:

1. **Silent ENOSPC kills saves.** `session-store.js#saveSessions`
   wraps the temp+rename in `try/catch` and returns `false` on any
   error including `ENOSPC` — but the caller (`saveSessionsToDisk`
   in `server.js:240–245`) only logs and moves on. The user sees
   one bad save, then 29 s later the autosave tries again, fails
   again, and so on indefinitely. No structured signal to the client.
   No degraded-mode behavior.
2. **No size ceiling on `~/.ai-or-die/`.** The 512 KB output-buffer
   cap × N sessions bounds per-save size, but there is no policy on
   total dir bytes. If the user moves `AI_OR_DIE_SESSION_DIR` onto a
   small partition (e.g., a USB stick), there is no enforcement.
   DISK-02 prunes `.crash` files but does not enforce a quota.
3. **`/api/diagnostics` does not report disk usage.** An operator
   running `grep '[diagnostics]' server.log | tail` can see RSS,
   handles, FD count, session count — but cannot see whether disk
   pressure is building before ENOSPC hits.

## Repro

The synthetic repro at `test/longevity/disk/enospc-handling.test.js`
exercises:

1. **Linux only**: create a 1 MB tmpfs, point `AI_OR_DIE_SESSION_DIR`
   at it, instantiate `SessionStore`, fill the partition to ~80%
   with a sentinel file, then attempt a save that would exceed the
   remaining space. Assert: `saveSessions` returns `false`, no
   exception propagates, and the existing (pre-failure) sessions.json
   remains intact (the failed write does NOT corrupt the previous
   good state — DISK-01's temp+rename guarantee carries through).
2. **All platforms (using fs mocks)**: mock `fs.promises.open` to
   reject with `{code: 'ENOSPC'}` and assert the same
   no-corruption / no-crash behavior. This catches the cross-platform
   case where we don't have a real disk-cap to work with.
3. **Diagnostics**: instantiate the server class with a small mock
   sessionsDir + projectsDir; call `_sampleDiskUsage()`; assert the
   returned object includes the expected fields
   (`ai_or_die_dir_bytes`, `claude_projects_bytes`, etc.) and that
   no sample blocks longer than 200 ms even on a large synthetic
   corpus.

## Impact (production)

- ENOSPC during the 30-s autosave silently loses every state change
  since the last successful save. On a small home-dir partition
  near-full, this is a routine occurrence.
- The user's only signal is the absence of restored sessions on next
  start. There is no in-app indicator, no client-side toast, no log
  warning louder than the existing `Failed to save sessions:` line.
- `~/.ai-or-die/` size growth is bounded by:
  - `sessions.json` (sub-MB per typical install — bounded by 512 KB
    × N session output buffers + envelope overhead)
  - `.crash` files (now bounded by DISK-02's 7-day pruning, keeping
    the latest one)
  - future content (attachments, voice recordings — not yet in this
    dir, but the architectural docs imply they will land here)
  Without an explicit quota the third bucket is unbounded.

## Proposed fix (this PR)

### Size cap and quota

- **Default ceiling:** 1 GB total bytes under `~/.ai-or-die/`.
- **Override:** `AIORDIE_DISK_QUOTA_MB` env var (positive integer MB).
- **Enforcement:** documentary-only for the first release. The
  current writers (`sessions.json` and `.crash`) are both
  intrinsically small; the quota is the alarm threshold, not a hard
  blocker. Once attachments/uploads land in `~/.ai-or-die/`, the
  enforcement gets a pre-write check.
- **Sampling cadence:** the existing 5 min diagnostics tick polls
  `_sampleDiskUsage()` with a 60 s cache TTL and a 50 ms walk budget;
  the cached numbers feed the diagnostics endpoint.

### ENOSPC circuit breaker

- `session-store.js#saveSessions` already returns `false` on any
  write failure. Extend `saveSessionsToDisk` in `server.js` to:
  - Detect when the most recent save failure was ENOSPC (or surface
    "disk pressure" via the diagnostic sample exceeding the quota).
  - Broadcast a `disk_full` WebSocket message to all connected
    clients exactly once per state transition (not every 30 s — avoid
    spam).
  - Set `this._diskFull = true`. Periodic recheck via the diagnostics
    tick clears it when usage drops 10 % below the quota (hysteresis
    to avoid flapping).
- **Degrade gracefully:**
  - Refuse new sessions (return 507 from the create endpoint).
  - Refuse new attachment uploads.
  - Keep existing sessions read-only-ish — they can still emit PTY
    output to clients (no disk write), but the output buffer is
    bounded by the 512 KB cap, so it does not grow on disk-pressured
    save failure.

### `/api/diagnostics` extension

`src/server.js:_collectDiagnostics` already returns a `disk` block
(landed alongside DISK-02 in the same PR), populated by
`_sampleDiskUsage`. DISK-03 adds:

```json
{
  "disk": {
    "ai_or_die_dir_bytes": 1234567,
    "ai_or_die_dir_files": 5,
    "ai_or_die_dir_stale": false,
    "claude_projects_bytes": 758912345,
    "claude_projects_files": 889,
    "claude_projects_stale": false,
    "quota_total_mb": 1024,
    "quota_used_pct": 0.1,
    "circuit_breaker_open": false,
    "sampled_at": "2026-05-27T12:00:00.000Z"
  }
}
```

`quota_total_mb` reads `AIORDIE_DISK_QUOTA_MB` once at startup;
`quota_used_pct` is computed from `ai_or_die_dir_bytes` /
(`quota_total_mb` × 1024 × 1024).

`circuit_breaker_open` reflects `this._diskFull`.

The sampling uses an async directory walk with a 50 ms wall-clock
budget and caches results for 60 s — must NOT block the event loop.
If the sample times out, the previous cached value is returned with a
`*_stale: true` flag.

### Manual reproduction (operator)

Documented in `docs/specs/disk-budget.md` §6. Summary:

- **Linux:** tmpfs mount with `size=10m`, point env var at it, watch
  the daemon refuse new writes gracefully.
- **macOS:** `hdiutil` 10 MB HFS+ disk image.
- **Windows:** Disk Management VHD, 10 MB.

## Risks of the fix

1. **The 50 ms walk budget can be exceeded on a network-mounted
   home dir.** Cached + degraded-mode return: the diagnostics report
   includes `*_stale: true` and the previous numbers; the operator
   sees the staleness and knows to investigate. No deadlock.
2. **`disk_full` broadcast spam.** Mitigated by the hysteresis +
   transition-edge dispatch. The state machine only fires the
   broadcast when transitioning IDLE→FULL or FULL→IDLE, not on every
   tick.
3. **False ENOSPC from quota check vs. real ENOSPC from filesystem.**
   The two are distinct: quota is the daemon's own enforcement; real
   ENOSPC comes from the kernel. Both surface the same `disk_full`
   message to keep the client UX consistent; the structured payload
   includes the `source` (`'quota' | 'fs'`) so a future client can
   message them differently.
4. **Refusing new sessions under disk pressure breaks the user's
   ability to recover.** Acceptable — the user can still delete old
   sessions via the existing delete endpoint (which doesn't grow the
   on-disk state). Once they delete enough to drop below the
   hysteresis floor, new sessions are allowed again. Documented in
   the spec.

## Test strategy

- **Cross-platform unit test**: mock `fs.promises.open` to reject
  ENOSPC; assert `saveSessions` returns `false` and the prior
  sessions.json content is unchanged.
- **Diagnostics sample test**: build a synthetic 1000-file dir;
  call `_sampleDiskUsage(50)`; assert it completes < 200 ms and
  returns either a complete sample or a `*_stale: true` partial
  sample.
- **Linux-only tmpfs test**: skipped on macOS/Windows in CI with a
  comment pointing to the manual repro. The test exercises a real
  ENOSPC from the kernel, not a mock.

## Out of scope

- Hard quota enforcement on the JSONL corpus (`~/.claude/projects/`)
  is upstream — that's the Claude CLI's domain. DISK-02's janitor
  is consumer-side compaction, not enforcement.
- Disk-IO throttling (rate limiting saves) — not a problem in
  observed workloads (30 s cadence is well below disk bandwidth).
- Per-session disk quotas — out of scope; the 512 KB output-buffer
  cap is the per-session bound.

## References

- `src/server.js#_collectDiagnostics`, `#_sampleDiskUsage`,
  `#_dirSizeWithBudget`
- `src/utils/session-store.js#saveSessions` (ENOSPC handling)
- `docs/specs/disk-budget.md` — §4, §6
- `test/longevity/disk/enospc-handling.test.js` — regression test
- `docs/audits/disk-atomic-write.md` (DISK-01 — same temp+rename
  guarantees the failure mode does not corrupt the prior file)
- `docs/audits/disk-usage-analytics-jsonl.md` (DISK-02 — janitor
  shares the log-rotator + diagnostics-tick wire-up)
