# DISK Hygiene — Stability Hardening 2026

**Date:** 2026-05-28
**Lane:** SUP-DISK (stability-hardening-2026 campaign)
**Files shipped:**
- `src/utils/session-store.js` — atomic-write fsync recipe + concurrent-save serialization
- `src/utils/log-rotator.js` (new) — reusable durable rotation primitives
- `src/usage-reader.js` — accepts `.jsonl.gz`, `compactStale()`, static `pruneCrashFiles()`
- `src/server.js` — `_sampleDiskUsage`, `_diskCompactionSweep`, `_pruneCrashFilesOnce`, `_enterDiskFull`/`_maybeExitDiskFull`/`_broadcastDiskFull`, `_buildDiagnosticsDiskBlock`, ENOSPC catch in `saveSessionsToDisk`
**Tests:** `test/longevity/disk/{atomic-write-power-loss,usage-analytics-growth,enospc-handling,concurrent-save-race}.test.js` (29 new specs)
**Spec:** `docs/specs/disk-budget.md` (new canonical disk-surface spec)
**Audit memos:** `docs/audits/disk-{atomic-write,usage-analytics-jsonl,enospc}.md`
**Branches on origin (bundled into `stability-hardening-2026` by SUP-REL):**
- `sup-disk/disk-01-atomic-write` @ 6ea72d4
- `sup-disk/disk-02-rotation` @ d388cc7
- `sup-disk/disk-03-enospc` @ 6a5813a
- `sup-disk/disk-01-rename-race` @ 048c518

## Problem

`ai-or-die` must run continuously for months on a single user's machine.
Five disk-class failure modes were either unbounded or unhandled:

1. **Power loss during `sessions.json` autosave silently corrupts the
   file.** Temp+rename was already in place (atomicity vs. readers is
   fine) but neither the temp file nor the parent directory was
   `fsync`'d. On next boot a rename's directory entry can be persisted
   ahead of the file contents → `JSON.parse` fails → corruption-recovery
   path triggers → every saved session is lost.
2. **Concurrent saves race on `rename`.** The 30s autosave timer
   overlaps in practice with explicit saves from session-create /
   delete / `beforeExit` / SIGINT/SIGTERM handlers. Two callers both
   write `sessions.json.tmp`, then both `rename` it. The first wins;
   the second's rename ENOENTs because the winner's rename removed the
   shared tmp.
3. **The Claude CLI's JSONL corpus under `~/.claude/projects/` grows
   unbounded.** Empirical measurement on one dev box: 723 MB across
   889 files in ~6 months of mixed usage, with zero rotation anywhere
   in either the CLI or in `ai-or-die`'s consumer code.
4. **`.crash` files accumulate forever.** `src/server.js`'s
   `uncaughtException` handler writes `sessions.json.crash`. Grep
   showed exactly one writer and zero readers/cleaners. A
   slow-steady-crash supervisor restart pattern (PROC-01 lane's
   concern) would leak crash files monotonically.
5. **No ENOSPC handling and no `~/.ai-or-die/` size cap.** The daemon
   silently fails its 30s autosave forever when the disk is full. No
   structured signal to the client. No graceful degradation. No
   observability into how close the daemon is to the wall.

## The audit correction that prevented wasted work

The original campaign plan identified `src/usage-analytics.js` (493
LOC) + `src/usage-reader.js` (894 LOC) as the JSONL-producing surfaces
to audit for rotation. The actual reading showed something different:

- `src/usage-analytics.js` is **pure in-memory** — an `EventEmitter`
  with bounded `recentUsage` (burn-rate window), `burnRateHistory`
  (1h cap), `activeSessions`/`sessionHistory` (24h prune). There is
  no `fs.appendFile`, no `createWriteStream`, no JSONL emission
  anywhere. The filename is misleading.
- The JSONL files we read are written by the **Claude CLI itself**
  under `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`.
  `ai-or-die` is a pure consumer.

This single correction reshaped the entire DISK-02 fix:
- We could not "fix rotation upstream" — that's the Claude CLI's
  domain. We had to build a consumer-side janitor.
- The fix had to be **opt-in** (env-flagged) because we're touching
  files we don't own.
- The reader code (`readJsonlFile`) had to learn to transparently
  gunzip `.jsonl.gz` so a partial rotation didn't break the read path.
- The Windows fallback strategy was different: the CLI may still hold
  an active append handle to a file we want to compact, so
  `fs.rename` can EBUSY. We fall back to `copyFile`+`unlink` with
  retry instead.

Without the audit re-reading the actual code, the campaign would
have spent days adding rotation hooks into the wrong file.

## Solution

Four commits, ~3000 lines added across 13 files. Stacked so SUP-REL
can merge the chain at the tip of `sup-disk/disk-01-rename-race`.

### DISK-01 — POSIX durability recipe for `sessions.json`

The standard temp+rename pattern needs **two `fsync` calls** to be
power-loss-durable on POSIX:

```
1. open(temp, O_WRONLY|O_CREAT|O_TRUNC, 0o600)
2. write(jsonStr)
3. fsync(tempFd)         <- DURABILITY of file contents
4. close(tempFd)
5. rename(temp, target)  <- ATOMICITY of swap (rename(2))
6. fsync(dirFd)          <- DURABILITY of the rename
```

Implemented via `fs.promises.open` (FileHandle gives `.sync()`),
wrapped in try/finally so handles never leak on exception paths.
Step 6 is skipped on Windows: NTFS journal + `MoveFileExW(MOVEFILE_
REPLACE_EXISTING)` provide the equivalent guarantee, and Node's
`fsync` on a directory handle returns `EPERM` there. The dir-fsync
also catches `EINVAL`/`EISDIR`/`EBADF` for exotic mounts (procfs,
some FUSE) that refuse fsync on directory handles.

An opportunistic `unlink(tempFile)` at the top of `saveSessions`
short-circuits a partial orphan from a prior disk-full mid-write
(defense-in-depth — DISK-03's territory).

### DISK-02 — Reusable rotation primitives + JSONL janitor + diagnostics

`src/utils/log-rotator.js` ships two primitives reusable by any
future append-only-file owner:

- **`compactJsonlFile(srcPath)`** — atomic gzip in place. Same
  fsync+rename recipe as DISK-01 (temp `.gz.tmp` → fsync → rename →
  dir-fsync POSIX-only). Windows EBUSY fallback to copyFile+unlink
  with 3-attempt exponential backoff. Idempotent.
- **`pruneOldFiles(dir, regex, {maxAgeMs, preserveLatestN})`** —
  regex-matched file deletion sorted newest-first, keeps the latest
  N regardless of age. Used for `.crash` cleanup.

`UsageReader` got an object-arg constructor for testability
(`{claudeProjectsPath, compactPolicy}`), `findJsonlFiles` +
`readJsonlFile` learned to handle `.jsonl.gz` transparently via
`zlib.createGunzip()`, and the new `compactStale()` walks all
project dirs applying the policy:

| Trigger | Default | Action |
|---|---|---|
| per-file size | ≥ 100 MB | gzip |
| per-dir total | ≥ 500 MB | gzip oldest until under cap |
| age | mtime > 90 days | gzip |
| preserve | newest 3 per dir | never touch |
| idle protect | mtime within 1h | skip (CLI may hold append fd) |

Wired into `setupAutoSave` as a 5-minute opt-in tick gated by
`AI_OR_DIE_USAGE_COMPACT=1`. Default-off for the first release
because we're touching files we don't own. Always-on `.crash` file
pruning (`UsageReader.pruneCrashFiles`) runs once at startup via
`setImmediate`; keeps the most recent crash for operator inspection,
deletes anything > 7 days old.

`_collectDiagnostics()` gained a `disk` block populated by a new
`_sampleDiskUsage(budgetMs)` method that walks `~/.ai-or-die/` +
`~/.claude/projects/` with a **strict 50ms wall-clock budget** and
caches results for 60s. On budget timeout the previous cache is
returned with a `*_stale: true` flag — never blocks the event loop.

### DISK-03 — ENOSPC circuit breaker + quota + structured `disk_full`

Three layers compose:

1. **`SessionStore._lastSaveError`** — `saveSessions` already
   returned `false` on any error; now also stores the catch'd Error
   on the instance so callers can read `.code`.
2. **`Server._enterDiskFull` / `_maybeExitDiskFull`** — edge-triggered
   breaker that opens on `ENOSPC`/`EDQUOT` from saves OR on ≥90% of
   `AIORDIE_DISK_QUOTA_MB` (default 1 GB) from the disk sampler.
   Closes only when usage drops below 80% (10% hysteresis avoids
   flapping near the threshold). The transition fires
   `_broadcastDiskFull` exactly once per IDLE→FULL transition so the
   operator's stderr isn't spammed every 30s.
3. **`createAndJoinSession` refuses new sessions while open** with a
   structured `{type: 'error', code: 'disk_full'}` to the requesting
   client. Existing sessions keep streaming PTY output (output
   buffer is bounded by the 512 KB cap — no disk growth on degraded
   mode).

The `_collectDiagnostics().disk` block extension reports
`quota_total_mb`, `quota_used_pct`, `circuit_breaker_open`,
`circuit_breaker_since` so an operator can see pressure building
before ENOSPC hits.

### DISK-04 — Serialize concurrent saveSessions (SOAK follow-up)

SUP-SOAK's `session-stringify` workload (6 saves/min × 50 sessions)
reproduced the rename race within minutes: 5–10 "Failed to save
sessions: ENOENT … rename" stderr lines per 2-min soak on `main`
HEAD. Not corruption — the winning save still writes a complete file
via DISK-01's recipe — but it (a) spammed stderr every 30s and (b)
risked misfiring DISK-03's circuit breaker because `ENOENT` looks
disk-pressure-shaped enough to trip the catch.

Fix: per-instance `_inFlightSave` promise-chain mutex in
`SessionStore`. Each `saveSessions` call chains onto the prior:

```js
async saveSessions(sessions) {
  if (!this._dirty) return true;
  const prior = this._inFlightSave;
  let release;
  this._inFlightSave = new Promise(r => { release = r; });
  try {
    await prior.catch(() => {});  // swallow prior reject — not our problem
    return await this._saveSessionsLocked(sessions);
  } finally {
    release();
  }
}
```

The dirty-flag fast-path is preserved: a queued caller that finds
`_dirty=false` on entry returns `true` cheaply (its state was
already persisted by the preceding save). Failed-prior doesn't
deadlock the queue because the `.catch(() => {})` lets the chain
proceed.

## How the three layers compose

The campaign's most interesting cross-lane property is that DISK-03,
PROC-01, and the future CLIENT-04 reinforce each other without
explicit coordination:

| Layer | Responsibility | Code |
|---|---|---|
| **DISK-03 (in-process breaker)** | Detect disk pressure, refuse new writes, broadcast `disk_full` | `src/server.js#_enterDiskFull` |
| **PROC-01 (supervisor cadence)** | Classify actual crash pattern, choose respawn delay, queue `supervisor_warning` IPC | `bin/supervisor.js` tier-1/2 backoff |
| **CLIENT-04 (banner + IPC reader, future)** | Surface "underlying disk-full?" hint to the user once the supervisor warning fires | TBD |

A user runs out of disk → DISK-03 refuses new sessions and existing
sessions keep streaming bounded output → if the daemon eventually
crashes from a write-side ENOSPC anyway, PROC-01 classifies the
recurrence pattern and throttles → CLIENT-04 (future) surfaces
"likely disk full" to the user via the IPC channel. The
`_collectDiagnostics().disk` block is already exposed for CLIENT-04
to enrich the supervisor_warning payload — no plumbing needed when
that task lands.

## Why we didn't…

- **…wrap the `_saveSessionsLocked` in a real async-mutex library.**
  `_inFlightSave` is a 5-line promise chain — adding a dep
  (`async-mutex`, `p-queue`) for that surface area would be net
  negative.
- **…use unique tmp suffixes (`${target}.${pid}.${random}.tmp`) per
  call instead of a mutex.** Would also solve the race, but the
  dirty-flag fast-path (where queued saves see their state already
  flushed and return cheaply) is a real efficiency win that
  per-call tmps would lose. Serialization is the right model
  because the underlying state IS shared.
- **…push hard rotation up to the Claude CLI.** It's the right
  long-term answer but a months-long upstream cycle. Consumer-side
  janitor ships now, behind an env flag, and we re-evaluate when /
  if the CLI gains rotation.
- **…enforce the `~/.ai-or-die/` quota as a hard pre-write block
  today.** The current writers (`sessions.json` + `.crash`) are
  intrinsically small; the quota is the alarm threshold, not a hard
  blocker. When attachments/uploads start landing in this dir,
  pre-write enforcement gets added then.
- **…use a real loopback mount for the ENOSPC regression test.**
  Requires privileges that CI runners don't have. The Linux-tmpfs
  test is gated `this.skip()` in CI with manual repro instructions
  in `docs/specs/disk-budget.md` §6 for macOS (hdiutil), Linux
  (`mount -t tmpfs`), and Windows (Disk Management VHD).
- **…make the disk-usage sampler synchronous.** A 1000-file
  `~/.ai-or-die/` (post-attachments) would block the event loop for
  100ms+ on spinning disk. The 50ms async budget + 60s cache + stale
  flag gives operators real data without taxing the autosave loop.

## Peer collaboration & cross-lane finds

- **SUP-SOAK** reported the rename race within hours of bringing up
  the harness — a clean repro saved an hour of investigation. The
  regression test in `concurrent-save-race.test.js` matches SOAK's
  workload pattern (50 concurrent saves; first-rename wins, others
  ENOENT pre-fix; 0 post-fix).
- **SUP-PROC** correctly identified that DISK-03's in-process breaker
  composes additively with PROC-01's supervisor cadence (no explicit
  coordination needed; each layer reacts to its own signal). Their
  cross-lane analysis ("in-process refuses writes → supervisor
  classifies actual crashes correctly → tier-2 IPC explains
  underlying disk-full") is captured in the cross-lane composition
  table above.
- **SUP-REL** signed off on the 3-commit DISK-01/02/03 stack and
  asked for a 4th gate (`disk.concurrent_save_race`) to cover the
  follow-up. Per-PR gate mapping captured in the message thread.
- **SUP-HOT** confirmed HOT-10 (the JSON.stringify worker_threads
  offload) is sequenceable independently — the DISK-01 fsync
  changes don't move the stringify point, so HOT-10's worker contract
  can wrap the same `setImmediate` line whether DISK-01 has landed or
  not.

## Verification

Local: 41 specs across `test/longevity/disk/{atomic-write-power-loss,
usage-analytics-growth,enospc-handling,concurrent-save-race}.test.js`
plus `test/session-store.test.js` — all green. Full `npm test` 1144
passing post-stack.

CI: regression tests use only Node built-ins (`fs/promises`, `zlib`,
`child_process`) — no new deps. Should pass on the existing
Windows/macOS/Linux matrix without changes.

Soak: SUP-SOAK to re-run `session-stringify` against the DISK stack
once the bundle merges; expected zero `disk.concurrent_save_race`
counter hits and bounded `disk.bytes_used_mb` slope.

Manual: spec §6 documents three OS-specific manual ENOSPC
repros (Linux tmpfs, macOS hdiutil, Windows VHD) for operators who
want to validate the circuit breaker on a real near-full disk.

## What's still open

- **DISK-03 hard pre-write quota enforcement** — landed as soft alarm
  + breaker; when attachments/uploads start landing under
  `~/.ai-or-die/`, the pre-write block should be added.
- **Disk-pressure enrichment of `supervisor_warning` IPC** — DISK-03
  exposes the data via `_collectDiagnostics().disk`; the wiring
  lands when CLIENT-04 implements the supervisor-warning UI.
- **Upstream rotation on the Claude CLI side** — out of scope for
  this campaign; consumer-side janitor is the bridge.

## References

- `docs/specs/disk-budget.md` — canonical disk-surface spec
- `docs/audits/disk-atomic-write.md` — DISK-01 + DISK-04 audit
- `docs/audits/disk-usage-analytics-jsonl.md` — DISK-02 audit (includes
  the usage-analytics producer correction)
- `docs/audits/disk-enospc.md` — DISK-03 audit
- `docs/specs/session-store.md` — updated SessionStore spec
- LWN — <https://lwn.net/Articles/322823/> (ext4 + delayed allocation +
  rename safety rationale)
