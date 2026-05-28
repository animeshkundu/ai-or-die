# HOT-04 — Attachment directory bytes scan on every upload

**Lane**: SUP-HOT (event-loop hot paths)
**Owner**: SUP-HOT
**Status**: Investigation complete; fix deferred to HOT-09 (post-baseline)
**Files**: `src/server.js:553–574` (`_attachmentDirBytes`),
`src/server.js:2578–2593` (upload-time cap check)
**Date**: 2026-05-27

## Symptom

Every POST to `/api/files/upload` that targets a `.claude-attachments/`
directory pays an O(N) sync filesystem scan to compute the per-session
size cap (`_attachmentSessionCapBytes()` = 100 MB,
`src/server.js:547–550`):

```js
_attachmentDirBytes(attachmentsDir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(attachmentsDir, { withFileTypes: true });
  } catch (_) { return 0; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    try {
      const st = fs.statSync(path.join(attachmentsDir, ent.name));
      total += st.size;
    } catch (_) { /* file vanished mid-readdir — skip */ }
  }
  return total;
}
```

One `readdirSync` + one `statSync` per entry. On a fast SSD a 1000-file
directory takes ~50 ms; on macOS Spotlight-indexing the same dir it can
spike to 200 ms; on a network share (SMB/NFS) every `statSync` is a
round-trip and 1000 files becomes 5–20 s.

Each call blocks the event loop synchronously. While the scan runs:

- WebSocket pongs queue → `heartbeat-watchdog` may force-close other
  tabs at code 4000.
- PTY output frames accumulate in the bridge's `_pendingOutput` buffer
  until the scan completes.
- File-watcher SSE events queue.
- Concurrent `/api/files/upload` requests serialize behind this one
  (Express keeps the event loop, not a thread pool, for sync code).

## How the burst pattern arises in practice

- **Generic-drop multi-file uploads.** When the user drops 10 files onto
  the file-browser at once, the client iterates and POSTs them one at a
  time. Each POST pays the full scan. 10 files on a 1000-file existing
  attachments dir → 10 × 50 ms = 500 ms cumulative scan cost.
- **Paste-image storms.** A user pasting 5 screenshots from clipboard in
  quick succession hits the same path.
- **Slow-disk amplification.** On a network-mounted home directory
  (corporate Mac with macOS network-home, Linux NFS home), each `statSync`
  is a network round-trip. A 200-file dir on a 50 ms RTT link =
  200 × 50 ms = 10 s of pure I/O wait per upload.

The scan runs on the **request thread** (Express's main event loop),
which is the same loop that drives every other server activity. There is
no thread-pool offload (`fs.readdirSync` and `fs.statSync` are both sync
syscalls in libuv).

## Repro

`test/longevity/event-loop/hot-04-attachment-scan.test.js`:

1. Preload a tmp `.claude-attachments/` with 500 small files.
2. Wrap `fs.statSync` so calls inside the tmp dir busy-wait 1 ms (proxy
   for a 1 ms-RTT network share — conservative; SMB/NFS over WAN is
   10–50 ms per stat).
3. Call `_attachmentDirBytes(tmpdir)` 10 times back-to-back, measuring
   total wall and `fs.statSync` invocation count via the wrapper.
4. Assert (a) total `statSync` calls < 600 (cache hits after first scan)
   and (b) `perf_hooks.monitorEventLoopDelay h.max < 50 ms`.

Observed on main:
- `statSync` called 5000 times (500 files × 10 scans — no cache).
- `h.max` ≥ 500 ms (10 × 500 × 1 ms = 5 s of sync I/O, bunched into
  one or two ticks depending on scheduler timing).

Both assertions trip. The test FAILS on main as required.

## Impact (production)

- Single 1000-file SSD scan: ~50 ms loop block per upload.
- Same dir on macOS network-home: ~5–20 s loop block per upload
  (essentially a one-shot self-DoS).
- The 100 MB per-session cap is rarely reached in a normal session —
  but the scan runs **regardless of whether the cap is close to being
  exceeded**. A 1-file 1 MB upload to a 1000-file 50 MB dir pays the
  full scan cost just to confirm 50 + 1 < 100.

## Proposed fix outline (HOT-09)

Replace the per-upload scan with a **per-session cached
`(total_bytes, last_known_mtime)` pair**, refreshed only when the
attachments dir's own `mtime` advances past the cached value.

Sketch (instance-level cache keyed by canonical attachments dir):

```js
// New on the server instance:
this._attachmentDirCache = new Map();  // canonicalDir → {bytes, mtimeMs, fileCount}

_attachmentDirBytesCached(attachmentsDir) {
  let dirStat;
  try { dirStat = fs.statSync(attachmentsDir); }
  catch (_) { return 0; }                              // dir missing → 0

  const cached = this._attachmentDirCache.get(attachmentsDir);
  if (cached && cached.mtimeMs === dirStat.mtimeMs) {
    return cached.bytes;                               // FRESH — one stat, no scan
  }
  // STALE — rescan, populate.
  const fresh = this._attachmentDirBytes(attachmentsDir);
  this._attachmentDirCache.set(attachmentsDir, {
    bytes: fresh,
    mtimeMs: dirStat.mtimeMs,
    fileCount: cached ? (cached.fileCount + 1) : 1,
  });
  return fresh;
}
```

### Invalidation on writes through known code paths

The upload handler **already knows** when it adds bytes to the dir
(immediately after `fs.promises.writeFile`). On successful upload,
update the cache:

```js
await fs.promises.writeFile(targetPath, buffer);
const stat = await fs.promises.stat(targetPath);
// Invalidate via mtime bump: the FS update itself will have bumped
// the parent dir's mtime, so the next read will refresh naturally.
// Optionally, eagerly update:
const cached = this._attachmentDirCache.get(dirValidation.path);
if (cached) {
  cached.bytes += stat.size;
  cached.mtimeMs = (await fs.promises.stat(dirValidation.path)).mtimeMs;
}
```

The `_sweepAttachments()` path (`server.js:613`) also removes files;
update the cache there too (or just delete the entry, forcing the next
upload to re-scan).

### Cap on cache size

The cache is keyed by canonical attachments dir. There's one such dir
per working directory; even a power user with 50 working dirs has at
most 50 cache entries. No explicit bound needed, but document the
invariant.

### Edge case: external mutation

A user who deletes files via `rm` outside of the upload/sweep code paths
will bump the dir's mtime; the next upload will refresh the cache. Worst
case (mtime resolution = 1 s on some FS): cache may be stale for 1 s,
under-reporting attachment size by the size of the externally-modified
files. Acceptable — the cap is 100 MB and the worst-case discrepancy is
bounded by the size of a single recent file (≤ 10 MB).

## Risks of the fix

1. **mtime granularity on FAT32 / older NTFS.** 2 s resolution. The
   discrepancy window grows to 2 s. Mitigation: combine mtime with
   per-known-write eager update so the path through normal upload flow
   never goes stale.
2. **Cache cohesion under server restart.** Cache is in-process;
   restart loses it; first post-restart upload pays the full scan once
   to repopulate. Acceptable — restarts are infrequent.

## Out of scope

- Moving the scan async via `fs.promises.readdir` + `fs.promises.stat`.
  Would unblock the loop but the cumulative cost is still O(N) per
  upload — caching is the real win.
- Tracking attachment sizes in a sidecar JSON to survive restarts.
  Adds disk I/O on every upload that the cache avoids; counterproductive.

## References

- `src/server.js:547–550` — `_attachmentSessionCapBytes` (100 MB)
- `src/server.js:553–574` — `_attachmentDirBytes` (the scan)
- `src/server.js:2578–2593` — upload-time cap check (the caller)
- `src/server.js:613–664` — `_sweepAttachments` (the invalidator)
- `test/longevity/event-loop/hot-04-attachment-scan.test.js` —
  regression test
