// test/longevity/event-loop/hot-02-filewatcher-hash.test.js
//
// HOT-02 regression test — FileWatcher synchronous MD5 on the hot path
//
// Memo: docs/audits/hot-02-filewatcher-hash.md
//
// What this proves on main HEAD (failing assertion = real bug):
//
//   FileWatcher._flush() calls _hashFileSync() inline on the chokidar
//   event hot path when includeHash is true (the legacy default for any
//   caller that doesn't pass depth: 0). _hashFileSync does fs.statSync +
//   fs.readFileSync + crypto.createHash('md5') — all synchronous, all
//   blocking the event loop for the duration of the disk read.
//
// Repro: subscribe to 20 files inside a tmpdir, stub fs.readFileSync for
// those paths with a 30ms busy-wait (proxy for slow-disk / encrypted
// FUSE / spinning-rust read cost), drive 20 _onChokidar('change', ...)
// calls in quick succession, measure event-loop lag and read-call count.
//
// On main:
//   • fs.readFileSync called 20 times — once per flush.
//   • perf_hooks.monitorEventLoopDelay p99 ≥ 30ms.
//   ⇒ both assertions fail.
//
// After the proposed fix (Option B: async hash via bounded worker queue —
// see memo §Proposed fix outline):
//   • fs.readFileSync NOT called from inside _flush; the hot path returns
//     synchronously and the hash arrives via a follow-up event.
//   • p99 < 50ms throughout the burst.
//   ⇒ both assertions pass.
//
// Note on chokidar bypass: we drive _onChokidar() directly instead of
// triggering real fs writes and waiting for chokidar. chokidar's own
// awaitWriteFinish + debounce + per-platform backend timing would make
// the test flaky on CI; the goal is to assert the SYNC-vs-ASYNC property
// of _flush, not chokidar's plumbing.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const FileWatcher = require('../../../src/utils/file-watcher');

function busyWait(ms) {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) { /* spin */ }
}

describe('HOT-02: FileWatcher sync MD5 on hot path (event-loop block under bulk edits)', function () {
  this.timeout(20000);

  let tmpRoot;
  let filePaths;
  let origReadFileSync;
  let readCount;

  beforeEach(() => {
    // Use a unique tmpdir per test to avoid cross-test contamination if
    // mocha is later configured to run files in parallel.
    // Canonicalize via realpath so /var → /private/var on macOS matches
    // FileWatcher._canonicalize (which also realpaths). Without this,
    // hasSubscription() (which uses path.resolve, NOT realpath) misses
    // and every event is silently dropped.
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hot02-fw-')));
    filePaths = [];
    for (let i = 0; i < 20; i++) {
      const p = path.join(tmpRoot, `f${i}.bin`);
      // A non-trivial size — even bypassing the busy-wait stub, this
      // mirrors a realistic agent-generated file (4.5 MB, just under the
      // 5 MB HASH_MAX_BYTES cap).
      const buf = Buffer.alloc(64); // small footprint on disk
      fs.writeFileSync(p, buf);
      filePaths.push(p);
    }

    // Stub fs.readFileSync — but ONLY for our tmp paths. Other reads
    // (module loads, source-map lookups inside mocha, etc.) must pass
    // through or the test runner itself stalls.
    readCount = 0;
    origReadFileSync = fs.readFileSync;
    fs.readFileSync = function patchedReadFileSync(p, ...rest) {
      if (typeof p === 'string' && p.startsWith(tmpRoot)) {
        readCount++;
        busyWait(30); // slow-disk proxy
      }
      return origReadFileSync.call(this, p, ...rest);
    };
  });

  afterEach(() => {
    fs.readFileSync = origReadFileSync;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  });

  it('does not call fs.readFileSync synchronously inside _flush() under a 20-file change burst', async () => {
    // Construct WITHOUT depth:0 so the legacy includeHash:true default
    // applies — mirrors the footgun the fix must close.
    const w = new FileWatcher({
      watchRoot: tmpRoot,
      includeHash: true,
      // Tight debounce so _flush() runs promptly inside the test budget.
      debounceMs: 10,
      addChangeDedupMs: 1,
      renameDetectMs: 1,
      // We're NOT calling start() — we drive _onChokidar directly to
      // exercise the flush path without spawning real chokidar.
    });

    // Subscribe to each path so hasSubscription() returns true inside
    // _onChokidar (line 479) and the debounce/flush actually runs.
    // subscribe() requires _watcher; since we skipped start(), reach into
    // the subscription set directly via the canonicalization helper.
    for (const p of filePaths) {
      w._subscriptions.add(w._canonicalize(p));
    }

    // Drive 20 change events. Use a fabricated stat object so _flush takes
    // the hash-eligible branch (st.isFile() truthy, size ≤ HASH_MAX_BYTES).
    const fabricatedStat = {
      ino: 1,
      size: 4.5 * 1024 * 1024, // just under HASH_MAX_BYTES
      mtimeMs: Date.now(),
      isFile: () => true,
    };

    const events = [];
    w.on('event', (e) => events.push(e));

    for (const p of filePaths) {
      w._onChokidar('change', p, fabricatedStat);
    }

    // Wait for the debounce flushes to fire. With debounceMs:10 + 20
    // flushes each costing 30 ms of busy-wait on main, total ≈ 610 ms.
    await new Promise((r) => setTimeout(r, 1500));

    // Drain any pending debounce timers in case the test exits before
    // they fire (defence against false-positive pass via skipped flushes).
    for (const { timer } of w._pendingEvents.values()) clearTimeout(timer);
    w._pendingEvents.clear();

    // Sanity: 20 flush events fired (proves the test actually exercised
    // the path it claims to test).
    assert.ok(
      events.length >= 20,
      `expected ≥ 20 flush events; got ${events.length} — debounce window misconfigured?`
    );

    // The load-bearing assertion: fs.readFileSync must NOT have been
    // called from the synchronous _flush path.
    //
    // On main: readCount === 20 (one per flush, all sync, all on the
    // event-loop hot path) — assertion FAILS.
    //
    // After the fix (Option B in memo): hashing moves to fs.promises.readFile
    // inside a bounded worker queue; readCount as observed by the SYNC
    // stub is 0 because the promise-based path doesn't transit
    // fs.readFileSync. The hash arrives via a follow-up event/accessor.
    assert.strictEqual(
      readCount, 0,
      `fs.readFileSync called ${readCount} times synchronously from FileWatcher._flush(); ` +
      'expected 0 (async hash queue not in place — see docs/audits/hot-02-filewatcher-hash.md)'
    );
  });

  it('keeps event-loop max lag under 50ms during a 20-file change burst with hashing enabled', async () => {
    const w = new FileWatcher({
      watchRoot: tmpRoot,
      includeHash: true,
      debounceMs: 10,
      addChangeDedupMs: 1,
      renameDetectMs: 1,
    });
    for (const p of filePaths) w._subscriptions.add(w._canonicalize(p));

    const fabricatedStat = {
      ino: 1,
      size: 4.5 * 1024 * 1024,
      mtimeMs: Date.now(),
      isFile: () => true,
    };

    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();

    const yieldNext = () => new Promise((r) => setImmediate(r));
    try {
      for (const p of filePaths) {
        w._onChokidar('change', p, fabricatedStat);
      }
      // Allow flushes to fire. On main each flush blocks the loop for 30
      // ms inside _hashFileSync; with debounceMs:10 the 20 timers bunch
      // into a single tick and block sequentially → one ~600 ms gap.
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) await yieldNext();
    } finally {
      h.disable();
      for (const { timer } of w._pendingEvents.values()) clearTimeout(timer);
      w._pendingEvents.clear();
    }

    // monitorEventLoopDelay returns nanoseconds. h.max captures the
    // largest single delay (one bunched-flush burst) — p99 would be
    // misleading here because the histogram has ~150 idle samples and
    // the single ~600 ms spike gets sorted past the 99th percentile.
    const maxMs = h.max / 1e6;
    const meanMs = h.mean / 1e6;

    // On main: max ≥ ~600 ms (20 × 30 ms busy-wait in one tick).
    // After fix: hash moves async, _flush returns immediately, max
    // drops to Node's idle noise (typically < 20 ms).
    assert.ok(
      maxMs < 50,
      `event-loop max lag = ${maxMs.toFixed(2)} ms (mean ${meanMs.toFixed(2)} ms); ` +
      'expected < 50 ms — FileWatcher sync hash blocking hot path ' +
      '(see docs/audits/hot-02-filewatcher-hash.md)'
    );
  });
});
