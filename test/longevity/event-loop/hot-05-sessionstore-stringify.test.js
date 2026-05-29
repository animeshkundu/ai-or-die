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
//   synchronous on the main thread. For 100 sessions × 512 KB output
//   buffer each (= ~51 MB serialized), stringify blocks the loop for
//   80-150 ms. setupAutoSave triggers this every 30 s.
//
// Repro: build 100 sessions with 512 KB random-ASCII output buffers
// (defeats V8 string-internment fast path), drive saveSessions(), and
// count the number of setImmediate yields the save makes.
//
// Pre-HOT-10 (bare stringify): saveSessions calls setImmediate exactly
// ONCE — the wrapper around the synchronous stringify. Plus a handful
// of internal Node scheduler yields from the fs.promises path.
// Total: ~1-10 setImmediate calls.
//
// Post-HOT-10 (streaming serializer): `_serializeDataStreamed` calls
// `await setImmediate()` once per session entry plus once for the
// envelope warmup. For 100 sessions, expect ≥ 100 setImmediate calls
// (plus the same handful from fs.promises internals).
//
// Assertion is CONTRACT-DIRECT — measures the yield count, NOT a noisy
// event-loop-lag proxy. Adopted per the "Test the contract, not the
// proxy" pattern from HOT-04-fixup (see HOT-11 §Process patterns):
//
// > When a regression test asserts a *proxy* for the contract being
// > protected (e.g. event-loop max-lag as a proxy for "the streaming
// > serializer is actually streaming"), CI environment variance can make
// > the test fail even when the contract IS satisfied. Replace the
// > proxy with a direct contract assertion.
//
// Earlier version of this test asserted `monitorEventLoopDelay h.max
// < 50ms`. On macOS GitHub Actions shared runners h.max was 68 ms; on
// Windows it was 95 ms — both pushed over the threshold by CI runner
// disk contention, NOT by the HOT-10 fix failing. The contract was
// satisfied (streaming yields 100+ times); the proxy measurement was
// drowned in I/O noise. See sup-hot/hot-04-darwin-warmup commit
// `353cc37` for the precedent.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

  it('streaming serializer yields ≥ N times for N sessions (contract-direct, CI-robust)', async () => {
    // Build the session Map. Each session carries a 1000-line output
    // buffer slice; lines are ~512 bytes of random ASCII so the per-
    // session capped buffer is ~512 KB (matches MAX_BUFFER_BYTES_PER_SESSION
    // exactly post-_capBufferByBytes).
    //
    // 100 sessions × ~512 KB ≈ 51 MB of JSON. Pre-fix this is one
    // ~100 ms monolithic stringify; post-fix it's 100 per-session
    // stringifies of ~5–15 ms each separated by setImmediate yields.
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

    // CONTRACT-DIRECT MEASUREMENT.
    //
    // Wrap global.setImmediate to count invocations during the save.
    // Restore IMMEDIATELY after the save so other tests / mocha
    // internals see the original. The count threshold (≥ NUM_SESSIONS)
    // is dominated by the streaming serializer's per-session yields;
    // a handful of fs.promises internal setImmediates during the
    // write/sync/rename path are noise relative to the 100+ floor.
    let yieldCount = 0;
    const origSetImmediate = global.setImmediate;
    global.setImmediate = function patchedSetImmediate(cb, ...args) {
      yieldCount++;
      return origSetImmediate(cb, ...args);
    };

    let ok;
    let wallMs;
    try {
      const t0 = Date.now();
      ok = await store.saveSessions(sessions);
      wallMs = Date.now() - t0;
    } finally {
      global.setImmediate = origSetImmediate;
    }

    assert.ok(ok, 'saveSessions should return true on success');

    // Pre-HOT-10 baseline: bare JSON.stringify wrapped in ONE
    // setImmediate. With 100 sessions, expect ~1-10 total setImmediate
    // calls during the save (the wrapper plus a few fs.promises
    // internal scheduling).
    //
    // Post-HOT-10 contract: `_serializeDataStreamed` does per-session
    // JSON.stringify + `await setImmediate()` between each. For
    // NUM_SESSIONS = 100, expect ≥ 100 setImmediate calls (plus the
    // envelope warmup + a handful from fs internals).
    //
    // Threshold: ≥ NUM_SESSIONS gives a wide gap from the pre-fix
    // ceiling (~10) and clean separation from CI-induced internal
    // scheduling noise. Failing this assertion means the streaming
    // serializer is not actually streaming — the HOT-10 fix is
    // structurally absent or broken.
    assert.ok(
      yieldCount >= NUM_SESSIONS,
      `expected ≥ ${NUM_SESSIONS} setImmediate yields during saveSessions ` +
      `(streaming serializer's per-session yield contract), got ${yieldCount} ` +
      `over ${wallMs} ms wall — streaming serializer not actually streaming, ` +
      'see docs/audits/hot-05-sessionstore-stringify.md'
    );
  });
});
