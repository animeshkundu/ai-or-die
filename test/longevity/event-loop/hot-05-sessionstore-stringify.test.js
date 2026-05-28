// test/longevity/event-loop/hot-05-sessionstore-stringify.test.js
//
// HOT-05 regression test — SessionStore JSON.stringify blocks main thread
//
// Memo: docs/audits/hot-05-sessionstore-stringify.md
//
// What this proves on main HEAD (failing assertion = real bug):
//
//   SessionStore.saveSessions (src/utils/session-store.js:97) calls
//   JSON.stringify(data) wrapped in a setImmediate. The wrapper yields
//   ONCE before the stringify but the stringify itself is fully
//   synchronous on the main thread. For 20 sessions × 512 KB output
//   buffer each (= ~10 MB serialized), stringify blocks the loop for
//   80-150 ms. setupAutoSave triggers this every 30 s.
//
// Repro: build 20 sessions with 512 KB random-ASCII output buffers
// (defeats V8 string-internment fast path), drive saveSessions(), and
// during the save count high-frequency timer ticks via
// perf_hooks.monitorEventLoopDelay h.max.
//
// On main:
//   • h.max ≥ 80 ms during the stringify call.
//   ⇒ assertion fails.
//
// After the proposed fix (Option A: stringify in worker_threads —
// see memo §Proposed fix):
//   • Main thread sends data to worker, awaits the serialized string.
//   • Main loop unblocked; h.max stays in single digits.
//   ⇒ assertion passes.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const SessionStore = require('../../../src/utils/session-store');

// Build a 512 KB random-ASCII string. Random content defeats V8's
// string-internment + dedupe fast path, so the stringify cost matches
// real-world session output (which is also high-entropy ANSI/PTY text).
function makeRandomString(bytes) {
  const out = Buffer.allocUnsafe(bytes);
  for (let i = 0; i < bytes; i++) {
    // 0x20..0x7E printable ASCII — same range PTY output produces (mostly).
    out[i] = 0x20 + ((Math.random() * 95) | 0);
  }
  return out.toString('ascii');
}

describe('HOT-05: SessionStore JSON.stringify blocks main thread', function () {
  this.timeout(30000);

  let tmpDir;
  let store;
  let prevSessionDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot05-ss-'));
    prevSessionDir = process.env.AI_OR_DIE_SESSION_DIR;
    process.env.AI_OR_DIE_SESSION_DIR = tmpDir;
    store = new SessionStore({ storageDir: tmpDir });
  });

  afterEach(() => {
    if (prevSessionDir == null) delete process.env.AI_OR_DIE_SESSION_DIR;
    else process.env.AI_OR_DIE_SESSION_DIR = prevSessionDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('keeps event-loop max lag under 50 ms during saveSessions of 20 × 512 KB sessions', async () => {
    // Build the session Map. Each session carries a 1000-line output
    // buffer slice; lines are ~512 bytes of random ASCII so the per-
    // session capped buffer is ~512 KB (matches MAX_BUFFER_BYTES_PER_SESSION
    // exactly post-_capBufferByBytes).
    //
    // 100 sessions ≈ 51 MB of JSON serialized — at modern V8's ~500 MB/s
    // stringify throughput, that's ~100 ms of sync CPU. The threshold is
    // 50 ms; main fails comfortably, fix (worker offload) passes.
    const sessions = new Map();
    const NUM_SESSIONS = 100;
    const LINE_BYTES = 512;
    const LINES_PER_SESSION = 1000;

    for (let s = 0; s < NUM_SESSIONS; s++) {
      const buf = [];
      for (let i = 0; i < LINES_PER_SESSION; i++) {
        buf.push(makeRandomString(LINE_BYTES));
      }
      sessions.set(`session-${s}`, {
        name: `Session ${s}`,
        created: new Date(),
        lastActivity: new Date(),
        workingDir: '/tmp',
        agent: 'claude',
        // saveSessions calls outputBuffer.slice(-1000) so plain array works.
        outputBuffer: buf,
        connections: new Set(),
        sessionUsage: { requests: 0, inputTokens: 0, outputTokens: 0,
                        cacheTokens: 0, totalCost: 0, models: {} },
        tempImages: [],
      });
    }

    // Force the dirty flag so saveSessions actually serializes (it
    // short-circuits on !_dirty otherwise).
    store.markDirty();

    // Monitor event-loop delay across the save. The histogram captures
    // the longest gap between scheduled loop iterations; on main, the
    // ~100 ms JSON.stringify shows up as a single big sample.
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();

    const t0 = Date.now();
    const ok = await store.saveSessions(sessions);
    const wallMs = Date.now() - t0;

    h.disable();

    assert.ok(ok, 'saveSessions should return true on success');

    const maxMs = h.max / 1e6;
    const meanMs = h.mean / 1e6;

    // On main: JSON.stringify of ~10 MB → h.max ≥ 80 ms.
    // After fix (worker_threads offload): main thread is free → h.max
    // dominated by Node's scheduling noise (typically < 20 ms).
    assert.ok(
      maxMs < 50,
      `event-loop max lag = ${maxMs.toFixed(2)} ms ` +
      `(mean ${meanMs.toFixed(2)} ms, total wall ${wallMs} ms) during ` +
      `saveSessions of ${NUM_SESSIONS} × ${LINE_BYTES * LINES_PER_SESSION / 1024} KB sessions; ` +
      'expected < 50 ms — JSON.stringify still on main thread ' +
      '(see docs/audits/hot-05-sessionstore-stringify.md)'
    );
  });
});
