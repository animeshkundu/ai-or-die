# DISK-01 — `sessions.json` atomic-write durability

**Lane**: SUP-DISK (persistence / disk hygiene)
**Owner**: SUP-DISK
**Status**: Investigation complete; fix landing in this PR
**Files**:
- `src/utils/session-store.js:50–109` (`saveSessions`)
- `src/server.js:199–211` (`uncaughtException` `.crash` writer)
- `test/longevity/disk/atomic-write-power-loss.test.js` (regression test)
**Date**: 2026-05-27

## Symptom

`SessionStore` already implements the temp-file + rename atomic-write
pattern (`src/utils/session-store.js:90–101`), which guarantees that a
crash during the `writeFile` call cannot leave the *target* file
half-written: a reader either sees the previous `sessions.json` (rename
not yet committed) or the new one (rename succeeded). That much is
correct.

However, the audit found three durability gaps that bite a daemon meant
to run for months on a single user's machine:

1. **No `fsync` on the temp-file fd before rename.** `fs.writeFile`
   (`session-store.js:98`) opens, writes, and closes the temp file — but
   does NOT flush the page cache to the disk platter. On a power loss
   between rename and the OS's writeback (typically up to 30 s on
   default Linux ext4, 5 s on macOS HFS+/APFS, similarly bounded on
   NTFS), the rename's *directory entry* may be persisted ahead of the
   *file contents*. The result on next boot: a sessions.json directory
   entry pointing at zero-length or partially-written data. The file
   still **opens**, JSON.parse fails, and `loadSessions` falls back to
   the corruption path at `session-store.js:128–134` — every session
   state is lost.
2. **No `fsync` on the parent directory after rename.** Under POSIX,
   `rename(2)` updates the directory entry in the page cache; the
   guarantee that the renamed name survives a power loss requires
   `fsync(2)` on the directory fd. The current code does not open the
   directory at all, so a power loss between the rename's metadata write
   and the next periodic dirty-inode flush can resurrect the old
   sessions.json (the rename is lost, the temp file is gone or orphan).
3. **`.crash` writer (`server.js:199–211`) is even less durable than
   the periodic save.** It uses `fs.writeFileSync` directly with NO
   temp+rename, no fsync, no parent fsync — so on power loss during an
   `uncaughtException` save the `.crash` file may itself be partial.
   Worse: nothing in the codebase ever rotates or evicts `.crash` files.
   A pathological supervisor-restart loop on a long-running daemon
   could accumulate one `.crash` per crash forever (mitigated for now
   by the fact that the supervisor's circuit breaker hard-exits after
   3 crashes / 30 s, but still unbounded under the slow-steady-crash
   pattern called out in PROC-01).

Additionally, two operational sharp edges:

4. **`fs.mkdir(recursive: true)` is called *after* the temp write
   succeeds** (`session-store.js:100`). If the directory was deleted
   between write-open and rename, the rename will EEXIST or ENOENT
   depending on platform. The mkdir-before-rename is a defensive race
   guard but it's in the wrong order: the temp file was already
   written *into* the directory, so the directory existed at write
   time, and a delete-between-write-and-rename is a TOCTOU race that
   the second mkdir cannot rescue (the temp file was deleted along
   with the directory). The double-mkdir is wasted I/O and the wrong
   defense.
5. **Stale `.tmp` files are auto-cleaned by the next save** (writeFile
   overwrites, then rename moves), so persistent orphans only happen
   if the daemon crashes and never restarts. Minor: we still add an
   opportunistic defensive unlink at the top of `saveSessions` to
   short-circuit a partial orphan from a disk-full mid-write
   (DISK-03 territory).

## Repro

The synthetic repro implemented in
`test/longevity/disk/atomic-write-power-loss.test.js` exercises three
guarantees the fix must hold:

1. **fsync-call ordering** — wraps `fs.promises.open`'s `FileHandle`
   prototype so that `.sync()` calls are counted with their target
   (file fd or directory fd) and call-order. After one `saveSessions`,
   the test asserts:
   - the temp-file `sync()` happened BEFORE `rename`,
   - on POSIX, the storage-directory `sync()` happened AFTER `rename`,
   - on Windows, the directory `sync()` is skipped (NTFS journal +
     `MoveFileExW` provide the equivalent guarantee; Node's `fsync` on
     a directory handle returns `EPERM`/`EISDIR` on Windows).
2. **No partial / empty / garbled file under SIGKILL.** Spawns a small
   child process (`scripts/_disk-atomic-write-child.js`, created by the
   test harness inline) that loops `saveSessions` on a populated Map.
   The parent SIGKILLs the child after a random 10–200 ms delay, then
   loads `sessions.json` and asserts: either the file is absent, or
   `JSON.parse` succeeds and the envelope (`version`, `savedAt`,
   `sessions[]`) is well-formed. Runs 20 SIGKILL cycles to sample
   different points in the write/rename pipeline. Any cycle producing
   a partial file fails the test.
3. **`.tmp` post-save invariant** — after any successful save, no
   `${target}.tmp` should remain. Auto-cleaned by the existing
   writeFile-overwrite-then-rename flow; the test confirms the
   invariant still holds post-fix and guards against accidental
   regressions where (e.g.) a copy-mode rename leaves the source
   behind.

Observed on `main` HEAD:
- Assertion #1 fails: zero `.sync()` calls occur — confirms the fsync
  gap.
- Assertions #2 and #3 already pass on `main` because `rename(2)` is
  itself atomic with respect to readers, and writeFile+rename
  naturally consumes any prior orphan. The fsync ordering is the
  only gap exposed under SIGKILL; a true power-loss test would also
  surface #2 (kernel still flushes dirty pages from SIGKILL'd
  processes, so SIGKILL alone cannot reproduce the torn-write).

## Impact (production)

- One power-loss event during the 30-s autosave window
  (`server.js:167–194`) can erase the entire user's session corpus —
  the daemon comes back up with `loadSessions` returning an empty Map
  via the corruption recovery path. The user loses every saved name,
  cwd, agent assignment, and 1000-line scrollback for every session.
  Existing tests catch JSON-shape corruption, not power-loss torn
  writes.
- Months-of-uptime soak: even without power loss, a kernel panic or
  hard reboot during writeback (rare but expected over a 6-month
  horizon) produces the same loss. The user-perceived symptom is "I
  restarted my Mac/Windows box and all my Claude sessions disappeared,"
  which reads as a bug in the *daemon* even though the root cause is
  filesystem semantics the daemon failed to invoke correctly.
- `.crash` accumulation: PROC-01 is investigating the slow-steady-crash
  pattern. If the supervisor restarts the daemon once every 5 min for
  a week, that's ~2000 `.crash` files in `~/.ai-or-die/`. Each one is
  whatever `JSON.stringify(this.claudeSessions)` produces — could be
  tens of KB per file, so single-digit MB total today but unbounded
  in the limit.

## Proposed fix (this PR)

### Atomic-write fsync ordering (POSIX)

Replace the `fs.writeFile + fs.rename` pair with the standard durable
sequence, using `fs.promises.open` to keep an explicit `FileHandle`:

```js
const fileHandle = await fs.open(tempFile, 'w', 0o600);
try {
  await fileHandle.writeFile(jsonStr);
  await fileHandle.sync();           // fsync data + metadata of TEMP
} finally {
  await fileHandle.close();
}
await fs.rename(tempFile, this.sessionsFile);

// Durability of the rename itself requires fsync of the parent dir.
// POSIX-only: Windows NTFS journal + ReplaceFileW-equivalent
// (MoveFileExW with REPLACE_EXISTING) provide the same guarantee
// without an explicit dir fsync, AND Node's fsync on a directory
// handle EPERMs on Windows.
if (process.platform !== 'win32') {
  let dirHandle = null;
  try {
    dirHandle = await fs.open(this.storageDir, 'r');
    await dirHandle.sync();
  } catch (dirErr) {
    // Some filesystems (e.g., procfs, some FUSE mounts) refuse fsync
    // on directory handles with EINVAL / EISDIR. Treat as non-fatal:
    // the rename has been issued; durability is best-effort.
  } finally {
    if (dirHandle) await dirHandle.close().catch(() => {});
  }
}
```

### Windows atomicity

`fs.rename` on Windows already invokes `MoveFileExW` with
`MOVEFILE_REPLACE_EXISTING` (verified via Node libuv source `uv-fs.c`'s
`fs__rename`). This is atomic at the NTFS-journal level for same-volume
moves, which is the case here (temp and target are in the same dir).
We do NOT need to call `ReplaceFileW` ourselves; the libuv path is
sufficient.

If the user has moved `~/.ai-or-die/` onto a FAT32 / exFAT volume
(possible if they pointed `AI_OR_DIE_SESSION_DIR` at a USB stick),
neither atomicity nor durability is guaranteed by the filesystem. We
document this as out-of-scope: the daemon assumes its storage dir is
on a journaled filesystem.

### Stale `.tmp` cleanup

Add an opportunistic unlink of `${tempFile}` at the top of
`saveSessions` (before opening it for write) — this rescues any orphan
from a prior aborted run. The unlink swallows `ENOENT` (no orphan)
silently.

### `.crash` file durability + rotation

Out of scope for this memo: `.crash` rotation will land under DISK-02
(usage-analytics rotation introduces the shared `log-rotator.js`
utility, which `.crash` files reuse). The `.crash` writer itself
remains `writeFileSync` for now — the existing code is in the
uncaughtException handler where async is unsafe; making it durable
requires `writeFileSync` + `fsyncSync` + `closeSync` in sequence. That
small change rides along with the DISK-02 PR.

## Risks of the fix

1. **Slower autosave under sustained writes.** `fsync` on a tmp file
   that's ≤ 1 MB is sub-millisecond on SSD; on spinning disk it can be
   10–30 ms. The autosave runs every 30 s and is already async — even
   30 ms is invisible. Worst case: shutdown save (where the user is
   waiting) takes 30 ms longer on HDD. Acceptable.
2. **Directory fsync ENOTSUP on exotic filesystems.** Caught and
   ignored — the rename still goes through, durability is just
   best-effort. Logged once at debug level (not error) so the user can
   diagnose if they later report data loss.
3. **`FileHandle.sync()` semantics on Node 18 / 20 / 22.** Stable
   public API since Node 14; behaves identically to `fs.fsync(fd)` on
   the underlying handle. No risk.

## Test strategy

The regression test under
`test/longevity/disk/atomic-write-power-loss.test.js` covers:

- Counter wrapping `FileHandle.prototype.sync` to verify ordering
  (temp fsync → rename → dir fsync on POSIX; temp fsync → rename only
  on Windows).
- Stale `.tmp` orphan cleanup via the opportunistic unlink.
- A SIGKILL torn-write loop (20 iterations) that asserts the target
  file is always either absent or fully parseable. (This passes on
  both pre- and post-fix `main` because `rename` already guarantees
  it — the test is documented as catching regressions to the *rename*
  ordering, not the fsync ordering. The fsync ordering is verified by
  the counter test.)

Manual / power-loss validation is out-of-scope for CI; documented in
the spec under "Manual reproduction" so future operators can run it
on a real machine with `sync && echo b > /proc/sysrq-trigger`.

## Out of scope

- `~/.ai-or-die/` size cap and ENOSPC handling — see DISK-03.
- `usage-analytics.jsonl` durability (separate append-only path) — see
  DISK-02.
- `.crash` file rotation — see DISK-02 (reuses the log-rotator).

## Follow-up (post-merge): concurrent saveSessions rename race

**Reporter:** SUP-SOAK via the `session-stringify` workload at 6
saves/min × 50 sessions.
**Symptom:** Two callers of `saveSessions` both `writeFile` to
`${sessionsFile}.tmp`, then both `rename` it. The first wins; the
second's `rename` ENOENTs because the winner's rename removed the
shared tmp:

```
Failed to save sessions: ENOENT: no such file or directory,
  rename '<storage>/sessions.json.tmp' -> '<storage>/sessions.json'
```

This is not a corruption bug — the temp+rename invariant still holds
for the call that wins — but the losing caller's `false` return
trickles up into `saveSessionsToDisk` and (post-DISK-03) misfires the
disk-full circuit breaker because `_lastSaveError.code === 'ENOENT'`
looks like real disk trouble. Operationally it spams stderr every
30 s.

**Root cause.** The 30 s autosave timer overlaps in practice with
explicit saves from session-create / session-delete / `beforeExit` /
SIGINT/SIGTERM handlers. There is no mutual exclusion on the
`saveSessions` entry — anyone can race in.

**Fix (same PR scope as DISK-01).** Per-instance promise chain
(`_inFlightSave`) serializes calls. Each call awaits the prior
call's settle (success or failure — we catch+ignore the prior's
rejection so a failed save doesn't block subsequent retries
forever), then enters its own write critical section via
`_saveSessionsLocked`. The dirty-flag fast-path stays — a queued
call that finds `_dirty=false` on entry returns `true` without
doing redundant work (its state was already persisted by the
preceding save).

**Regression test:** `test/longevity/disk/concurrent-save-race.test.js`
exercises:
1. 50 concurrent saves: all return `true`, file well-formed,
   no `.tmp` orphan. **Fails on `main` HEAD with the exact ENOENT
   SOAK reported.**
2. Mutating state across concurrent saves: persisted name must be
   one of the queued snapshots (last-write semantics intact).
3. Slow prior save (200 ms): subsequent caller serializes behind
   it and both complete cleanly.
4. Failed prior save (mocked EIO): the lock releases so the next
   caller is not stuck forever.

## References

- `src/utils/session-store.js:50–109` — current `saveSessions`
- `src/server.js:199–211` — `.crash` writer in `uncaughtException`
- `src/server.js:167–194` — 30 s autosave interval
- POSIX rationale: <https://lwn.net/Articles/322823/> (Ext4 + delayed
  allocation + rename safety)
- `test/longevity/disk/atomic-write-power-loss.test.js` — regression test
- `test/longevity/disk/concurrent-save-race.test.js` — follow-up
  regression test for the SOAK-reported rename race
