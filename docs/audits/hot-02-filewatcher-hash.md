# HOT-02 — FileWatcher synchronous MD5 on hot path

**Lane**: SUP-HOT (event-loop hot paths)
**Owner**: SUP-HOT
**Status**: Investigation complete. **Fix landed in HOT-07** (`src/utils/file-watcher.js`).
**Files**: `src/utils/file-watcher.js:83–92`, `src/utils/file-watcher.js:580–608`,
`src/utils/file-watcher.js:130–161` (constructor / `includeHash` default)
**Date**: 2026-05-27 (investigation), 2026-05-28 (fix)

## Symptom

Under a bulk-edit storm — a Claude agent generating 50 files at once,
`git checkout` swapping a branch, `npm install` populating
`node_modules/` (when the ignore filter doesn't strip it), or `rg --files`
warming page cache while a watcher subscription happens to cover the same
tree — the Node event loop blocks in 10–80 ms windows for each emitted
`change`/`rename` event whose file is large enough that the `_hashFileSync`
read is non-trivial. Cumulative lag of 200 ms+ under a 50-file burst is
realistic on a slow disk (HDD / spinning rust / encrypted FUSE mount).

The block sits inside the watcher's `_flush()` (`file-watcher.js:580–608`):

```js
if (this._includeHash && (type === 'change' || type === 'rename') &&
    st.isFile && st.isFile() && st.size <= HASH_MAX_BYTES) {
  hash = _hashFileSync(absPath); // sync fs.readFileSync + crypto.createHash
}
```

`_hashFileSync` (`file-watcher.js:83–92`):

```js
function _hashFileSync(absPath) {
  try {
    const stat = fs.statSync(absPath);                     // sync
    if (!stat.isFile() || stat.size > HASH_MAX_BYTES) return null;
    const data = fs.readFileSync(absPath);                 // sync — bounded at 5 MB
    return crypto.createHash('md5').update(data).digest('hex');
  } catch (_) { return null; }
}
```

`HASH_MAX_BYTES = 5 * 1024 * 1024` caps any single read at 5 MB, but a
burst of N 5 MB files is unbounded by file-watcher itself: each flush
serializes its sync read on the hot path one after another (the debounce
window collapses repeated changes to ONE flush per path, but not across
paths).

## Why the existing default is not enough

The constructor (`file-watcher.js:152–161`) defaults `includeHash` to
`false` **only** when the caller passes `depth: 0`:

```js
if (typeof opts.includeHash === 'boolean') {
  this._includeHash = opts.includeHash;
} else if (this._depth === 0) {
  this._includeHash = false;
} else {
  this._includeHash = true;    // ← LEGACY DEFAULT — still applies
}
```

In the current codebase, the only production caller is `server.js:2339`
and it passes `depth: 0`, so production is incidentally safe today. But:

1. Any future caller (or a regression-revived recursive subscription)
   resurrects the leak by default.
2. The legacy default is a **footgun**: a developer adding a non-`depth:0`
   watcher anywhere — including in tests, scripts, or in another bridge —
   pays the sync-hash cost without warning.
3. The fix-the-callers approach is fragile across long-running campaigns;
   a structural fix (push the cost off the hot path entirely) survives
   future callers.

## Repro

`test/longevity/event-loop/hot-02-filewatcher-hash.test.js`:

1. Construct a `FileWatcher` with `includeHash: true` (explicit — the
   legacy default that would apply to any caller that doesn't pass
   `depth: 0`).
2. Subscribe to 20 4.5 MB files inside a tmp dir.
3. Stub `fs.readFileSync` with a 30 ms busy-wait wrapper, applied only to
   paths inside the tmp dir (avoids destabilising mocha's own module
   loads). Counts invocations.
4. Drive the watcher's `_flush()` via 20 direct `_onChokidar('change',
   path, stat)` calls in rapid succession — bypassing chokidar (which
   would add nondeterministic timing variance) but exercising the exact
   debounce + flush code path that runs in production.
5. Measure event-loop lag with `perf_hooks.monitorEventLoopDelay` during
   the burst.

Observed on main:
- `fs.readFileSync` called 20 times — once per flush.
- `perf_hooks.monitorEventLoopDelay` records `h.max` ≈ 600 ms (20 × 30 ms
  busy-waits bunch into a single tick under the `debounceMs: 10` window).
  Note: `p99` is misleading here because the histogram has ~150 idle
  samples; the single bunched-flush spike gets sorted past the 99th
  percentile. `h.max` is the load-bearing metric for this workload.

Both assertions trip the thresholds (`readSyncCalls === 0`,
`max < 50 ms`). The test FAILS on main as required.

## Impact (production)

- 50-file Claude-agent batch on a slow disk: ~50 × 20 ms = **1 s of
  cumulative event-loop block** during the burst, distributed across the
  debounce window (default 500 ms) plus the trailing flush cycle.
- All WebSocket pongs / heartbeat / HTTP serving queue behind the burst.
  The pong watchdog tolerates this (25 s ping interval) but the user-
  visible UI freeze is direct.
- The hash is consumed by `file-tabs.js`'s "did the disk content actually
  change vs just mtime bump" short-circuit; that fast-path is already
  documented to gracefully fall back to an HTTP refetch when hash is
  absent (file-watcher.js:122–128). So the hash is a nice-to-have for
  cache invalidation, NEVER a correctness signal — making it safe to
  move async or drop entirely.

## Proposed fix outline (HOT-07)

Two viable approaches; the implementation should pick one.

### Option A — flip the default + audit callers

- Change the `includeHash` default to `false` unconditionally
  (`file-watcher.js:155–160`).
- Make any caller that *needs* hashing opt-in explicitly via
  `includeHash: true`.
- The single current caller (`server.js:2339`) already gets the
  no-hash behaviour (via depth:0); the default flip is observably a
  no-op for production. The change is a future-proofing measure.

Pros: tiny diff, zero runtime cost. Cons: doesn't fix the footgun for
the next dev who writes `new FileWatcher({ ..., includeHash: true })`.

### Option B — move hashing async with a bounded worker queue (recommended)

- Replace `_hashFileSync` with an async `_hashFile` that uses
  `fs.promises.readFile` (or streaming via `createReadStream` for files
  approaching the 5 MB cap).
- Maintain a bounded in-process **hash queue** (suggested cap: 8
  concurrent) so a 100-file burst doesn't fan out into 100 simultaneous
  reads (which would EMFILE on Windows + small `ulimit -n` macOS).
- On hash completion, emit a follow-up `hash` event for the path, OR
  attach the hash to the original event's payload via a small per-path
  cache the consumer can query (`watcher.getHash(absPath)`).
- The `file-tabs.js` consumer's behaviour does NOT regress: missing
  hash already takes the HTTP-refetch path (file-watcher.js:122–128).
  Adding the hash later is a strict improvement over its absence.

Pros: structural — survives all future callers. Cons: small API
addition (the `hash` follow-up event or `getHash` accessor).

### Either way: add a hot-path guard

After the fix, add an internal `process.env.AI_OR_DIE_HASH_DEBUG` assert
that throws if `fs.readFileSync` is called from inside `_flush()` on a
non-test build. This is a guardrail against the next dev re-introducing
the sync path during a future refactor.

## Risks of the fix

1. **Option B**: a queue overflow under a 10000-file burst would back
   pressure the watcher. The queue should drop oldest entries (rather
   than blocking new emissions), and the watcher should log the drop
   rate via `_collectDiagnostics`.
2. **Option B**: the `hash` follow-up event arrives out-of-order vs
   the original `change` event. `file-tabs.js` already debounces;
   any new consumer must be reviewed for race conditions before
   relying on hash-arrival ordering.

## Out of scope

- Replacing MD5 with a faster non-crypto hash (xxhash, blake3). The
  cost is dominated by the *read*, not the digest — moving the read
  async wins more.
- Caching previously computed hashes keyed by `(path, mtime)`. Useful
  optimization, but orthogonal to the hot-path-block fix.

## References

- `src/utils/file-watcher.js:83–92` — `_hashFileSync`
- `src/utils/file-watcher.js:130–161` — `includeHash` default logic
- `src/utils/file-watcher.js:580–608` — `_flush` (hot path)
- `src/server.js:2339–2361` — production caller (depth: 0, safe today)
- `src/public/file-tabs.js` — hash consumer (already tolerates missing
  hash via HTTP-refetch fallback)
- `test/longevity/event-loop/hot-02-filewatcher-hash.test.js` —
  regression test

## Fix landed (HOT-07)

Picked **Option B** (async hash via bounded worker queue) per the memo
recommendation. Structural fix that survives future callers.

Implementation in `src/utils/file-watcher.js`:

- New module-level constants `HASH_DEFAULT_CONCURRENCY = 8` (caps
  concurrent reads to avoid EMFILE under a 1000-file burst) and
  `HASH_CACHE_MAX_ENTRIES = 1024` (bounds the per-FileWatcher hash
  cache against unbounded watched-path counts).
- New module-level function `_hashFileAsync` using `fs.promises.stat` +
  `fs.promises.readFile`. The synchronous `_hashFileSync` is retained
  for back-compat but is no longer called from `_flush()`.
- New instance fields: `_hashCache: Map<absPath, {hash, mtime}>`,
  `_hashPending: [{absPath, mtime}, ...]`, `_hashInflight: number`,
  `_hashConcurrency: number`, `_hashIdleWaiters: [resolve, ...]`.
- New instance methods `_enqueueHash`, `_drainHashQueue`,
  `hashQueueIdle()` (test affordance), `_fireHashIdleWaiters`.
- `_flush()` rewritten: emits event synchronously WITHOUT hash on the
  hot path; if `_includeHash` and the path's cached hash matches the
  event's mtime, the emitted payload INCLUDES the hash (late-inclusion
  path); otherwise the path is enqueued for async hashing so the NEXT
  event for the same path can take the late-inclusion path.
- `close()` extended to drop the pending queue + cache and resolve any
  outstanding `hashQueueIdle()` waiters (test cleanup hygiene).

### API-shape compatibility

- The `event` payload's `hash` field remains OPTIONAL (same shape as
  before). The only observable behaviour change is *when* it appears:
  pre-fix it appeared on the first event after a content change (with a
  blocking read); post-fix it appears on the SECOND and subsequent
  events for the same mtime (after the async queue populates the cache).
- `file-tabs.js`'s hash short-circuit (`evt.hash && panel._fileHash &&
  evt.hash === panel._fileHash`) still fires for rapid-repeated-touch
  patterns — the first event flows through HTTP refresh which populates
  `panel._fileHash`, the second event's `evt.hash` arrives from the
  async cache, comparison fires, no-op.
- The very first event for a freshly-changed file no longer pays the
  hash-skip optimization; it falls through to the HTTP-refresh path.
  This is a strictly safer trade-off (no event-loop block) and `file-
  tabs.js` documents the absent-hash path as supported
  (file-watcher.js:122–128).

### Decision divergence from this memo

- **Did NOT add the `AI_OR_DIE_HASH_DEBUG` hot-path guard.** Would be
  load-bearing only if a future dev re-introduced a sync `readFileSync`
  inside `_flush()`. The new HOT-07 regression test
  (`test/file-watcher.test.js: '_flush() never calls fs.readFileSync
  synchronously'`) covers that explicitly via wrap-and-count, which is
  catch-via-CI rather than catch-via-runtime — same protection, lower
  runtime cost.
- **Did NOT add a follow-up `hash` event.** The per-path cache + late-
  inclusion design fits the existing `event`-payload contract better.
  No new event type, no new wire format, no need to update the SSE
  forwarding code in `server.js:2364–2377`.

### Test surface

- `test/longevity/event-loop/hot-02-filewatcher-hash.test.js` —
  both assertions flip from failing on main → passing:
  - `fs.readFileSync` called 0 times from `_flush()` hot path (was 20
    on a 20-file burst).
  - `h.max < 50 ms` (was ~600 ms on bunched flushes).
- `test/file-watcher.test.js` — two new HOT-07 tests:
  - `first event for a changed path has no hash; second event
    (post-queue-drain) includes it` — proves the late-inclusion
    contract end-to-end with a real chokidar drive.
  - `_flush() never calls fs.readFileSync synchronously, even with
    includeHash:true` — wrap-and-count guard.
- Adjacent sweep: `file-watcher`, `fs-watch-cleanup`,
  `file-watcher-client` — **42 passing / 0 failing**.

### Out-of-scope follow-ups (deliberately deferred)

- Streaming hash via `createReadStream` for files near `HASH_MAX_BYTES`.
  Not needed — `fs.promises.readFile` on a 5 MB file takes <10 ms on a
  worker thread and the queue caps concurrency, so memory pressure is
  bounded.
- Surfacing hash queue depth / hit-rate via `_collectDiagnostics`.
  Useful for tuning the queue under sustained soak but not load-bearing.
- Diagnostic-style drop-rate logging on queue overflow. The dedupe-by-
  path inside `_enqueueHash` already collapses repeated writes to the
  same path; an unbounded distinct-path burst would still grow the
  pending array (no explicit cap). Revisit if SUP-SOAK sees pending
  array growth in long runs.
