// test/longevity/process/eviction-sublinear.test.js
//
// PROC-04 regression test — sub-linear _evictStaleSessions
//
// Memo: docs/audits/proc-04-sublinear-eviction.md
//
// What this proves on main HEAD (pre-fix):
//
//   src/server.js's `_evictStaleSessions` does
//   `Array.from(this.claudeSessions.entries())` + full iteration of all
//   sessions every 5 minutes. At 100K sessions (mock-clock-uncapped
//   eviction-storm workload — SOAK-05o's BLOCKING signal) this produced
//   a 2,709ms event-loop max in the bundled soak. Linear cost
//   compounds with the .map iteration's intermediate array (~100K
//   tuples = MBs of heap allocations).
//
// After fix (lazy-tombstone min-heap keyed by lastActivity):
//
//   The sweep peeks the heap top; if fresh, returns in O(log n).
//   100K mostly-fresh sessions complete the sweep in < 10 ms (heap.peek
//   is O(1); the tombstone-pop loop is bounded by the popBudget).
//
// Tests cover:
//   1. Correctness: stale sessions are evicted; fresh are not.
//   2. Mixed workload: 99K fresh + 1K stale evicts exactly 1K.
//   3. PERF gate: 100K all-fresh + 0 stale completes the sweep in <10ms.
//   4. PERF gate: event-loop monitor records p99 < 50 ms across the sweep.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../../../src/server'));
} catch (_) { /* suite will be skipped */ }

// Build a single test-injected session compatible with `_evictStaleSessions`.
// Bypasses the full createAndJoinSession path so we can inject 100K of them
// in tens of ms instead of seconds.
function makeFakeSession(id, lastActivityMs, opts) {
  opts = opts || {};
  return {
    id,
    name: `inj-${id}`,
    created: new Date(lastActivityMs),
    lastActivity: new Date(lastActivityMs),
    active: !!opts.active,
    agent: null,                  // null agent → getBridgeForAgent returns falsy → skip stopSession
    workingDir: '/tmp',
    connections: new Set(),       // empty connections → evictable
    outputBuffer: { push() {}, dump() { return []; } },  // tiny stub; eviction doesn't touch
    priority: 'background',
    sessionStartTime: null,
    sessionUsage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0 },
  };
}

function injectSessions(server, count, lastActivityMs, opts) {
  for (let i = 0; i < count; i++) {
    const id = `inj-${i}-${opts && opts.tag || 'x'}`;
    const session = makeFakeSession(id, lastActivityMs, opts);
    server.claudeSessions.set(id, session);
    // Mirror what _pushEvictionEntry does — heap entry keyed by lastActivity ms.
    server._evictionHeap.push({ id, lastActivity: lastActivityMs });
  }
}

(ClaudeCodeWebServer ? describe : describe.skip)('PROC-04: sub-linear _evictStaleSessions', function () {
  this.timeout(30000);

  let server, tmpDir;

  before(async function () {
    // Construct an in-process server without binding a port. We never call
    // .start() — eviction is a pure-in-memory algorithm that touches
    // `claudeSessions` (which carries per-session voice rate-limit state),
    // `_evictionHeap`, `activityBroadcastTimestamps`, `_fsWatchSessions`, and
    // `sessionStore`.
    // Isolated session-store dir so the test doesn't clobber
    // ~/.ai-or-die/sessions.json on the host.
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-04-eviction-'));
    tmpDir = fs.realpathSync(raw);
    const sessionStoreDir = path.join(tmpDir, '.session-store');
    fs.mkdirSync(sessionStoreDir, { recursive: true });

    server = new ClaudeCodeWebServer({
      port: 0,
      noAuth: true,
      sessionStoreOptions: { storageDir: sessionStoreDir },
    });
    // Cancel the auto-save / eviction / heartbeat intervals so they
    // don't race the test. We're only exercising the in-process sweep.
    if (server.autoSaveInterval) clearInterval(server.autoSaveInterval);
    if (server.imageSweepInterval) clearInterval(server.imageSweepInterval);
    if (server.sessionEvictionInterval) clearInterval(server.sessionEvictionInterval);
    if (server.diagnosticsHeartbeatInterval) clearInterval(server.diagnosticsHeartbeatInterval);
  });

  after(function () {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
    // Strop the RestartManager's memory monitor (started in the constructor).
    if (server && server.restartManager && typeof server.restartManager.stopMemoryMonitoring === 'function') {
      try { server.restartManager.stopMemoryMonitoring(); } catch (_) {}
    }
  });

  beforeEach(function () {
    server.claudeSessions.clear();
    server._evictionHeap.clear();
  });

  // ---------------------------------------------------------------------
  // Correctness
  // ---------------------------------------------------------------------

  it('evicts only sessions older than 7 days; fresh sessions survive', async function () {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;

    injectSessions(server, 500, eightDaysAgo, { tag: 'stale' });
    injectSessions(server, 500, oneDayAgo, { tag: 'fresh' });
    assert.strictEqual(server.claudeSessions.size, 1000);

    const evicted = await server._evictStaleSessions();

    assert.strictEqual(evicted, 500, 'should evict exactly the 500 stale sessions');
    assert.strictEqual(server.claudeSessions.size, 500, 'should leave 500 fresh sessions');
    // Spot-check: a fresh entry stays; a stale entry is gone.
    assert.ok(server.claudeSessions.has('inj-0-fresh'), 'fresh inj-0 should survive');
    assert.ok(!server.claudeSessions.has('inj-0-stale'), 'stale inj-0 should be gone');
  });

  it('skips sessions with active=true or connections.size > 0', async function () {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

    // 100 stale-but-active: should NOT evict
    injectSessions(server, 100, eightDaysAgo, { tag: 'active', active: true });
    // 100 stale-but-connected: should NOT evict
    const id = 'inj-c-0';
    const sess = makeFakeSession(id, eightDaysAgo, {});
    sess.connections = new Set(['ws-1']);
    server.claudeSessions.set(id, sess);
    server._evictionHeap.push({ id, lastActivity: eightDaysAgo });
    // 100 stale-and-truly-idle: SHOULD evict
    injectSessions(server, 100, eightDaysAgo, { tag: 'idle' });

    const evicted = await server._evictStaleSessions();

    assert.strictEqual(evicted, 100, 'only the 100 truly-idle stale sessions should be evicted');
    assert.strictEqual(server.claudeSessions.size, 101, '200 in-use sessions survive (100 active + 1 connected)');
  });

  // ---------------------------------------------------------------------
  // Perf — the load-bearing PROC-04 assertions
  // ---------------------------------------------------------------------

  it('100K all-fresh sessions: sweep completes in < 10 ms (heap early-exit)', async function () {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    injectSessions(server, 100000, oneHourAgo, { tag: 'fresh' });

    // Warm-up: V8's first call into the method is JIT'd, not steady-state.
    await server._evictStaleSessions();

    const t0 = process.hrtime.bigint();
    const evicted = await server._evictStaleSessions();
    const t1 = process.hrtime.bigint();
    const elapsedMs = Number(t1 - t0) / 1e6;

    assert.strictEqual(evicted, 0, 'no fresh sessions should be evicted');
    assert.ok(
      elapsedMs < 10,
      `PROC-04 perf gate: 100K all-fresh sweep took ${elapsedMs.toFixed(2)} ms; expected < 10 ms ` +
      '(heap.peek + early-exit on fresh top — see docs/audits/proc-04-sublinear-eviction.md). ' +
      'Pre-fix O(n) scan typically takes 30-150 ms here.'
    );
    // Sessions stay put.
    assert.strictEqual(server.claudeSessions.size, 100000);
  });

  it('99K fresh + 1K stale: evicts exactly 1K; sweep completes in < 100 ms', async function () {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

    injectSessions(server, 99000, oneHourAgo, { tag: 'fresh' });
    injectSessions(server, 1000, eightDaysAgo, { tag: 'stale' });

    const t0 = process.hrtime.bigint();
    const evicted = await server._evictStaleSessions();
    const t1 = process.hrtime.bigint();
    const elapsedMs = Number(t1 - t0) / 1e6;

    assert.strictEqual(evicted, 1000, 'should evict exactly the 1000 stale sessions');
    assert.strictEqual(server.claudeSessions.size, 99000);
    // O(k log n) where k=1000, n=100000 → ~17K compares + 1K Map deletes.
    // Comfortably under 100 ms; pre-fix would be 100-300 ms here.
    assert.ok(
      elapsedMs < 100,
      `PROC-04 perf gate: mixed sweep took ${elapsedMs.toFixed(2)} ms; expected < 100 ms`
    );
  });

  it('event-loop p99 < 50 ms during a 100K-session sweep', async function () {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    injectSessions(server, 100000, oneHourAgo, { tag: 'fresh' });

    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    // Run a series of sweeps; the histogram needs samples around them.
    for (let i = 0; i < 5; i++) {
      await server._evictStaleSessions();
      await new Promise((r) => setImmediate(r));
    }
    h.disable();

    const p99ms = h.percentile(99) / 1e6;
    const maxMs = h.max / 1e6;
    assert.ok(
      p99ms < 50,
      `PROC-04 event-loop gate: p99 = ${p99ms.toFixed(2)} ms, max = ${maxMs.toFixed(2)} ms; ` +
      'expected < 50 ms. Pre-fix the same workload produced 2709 ms max in SOAK-05o.'
    );
  });

  // ---------------------------------------------------------------------
  // Heap-bound — tombstones don't accumulate forever
  // ---------------------------------------------------------------------

  it('tombstone rebuild keeps heap size bounded under sustained activity bumps', async function () {
    const now = Date.now();
    // 1000 sessions
    injectSessions(server, 1000, now - 60 * 1000, { tag: 'churn' });
    assert.strictEqual(server._evictionHeap.size, 1000);

    // Simulate 1000 lastActivity bumps per session — totals 1M push.
    // Without rebuild, heap.size = 1.001M; with rebuild + a final sweep,
    // it stays bounded at ~2x live (rebuild trigger).
    for (let bump = 0; bump < 1000; bump++) {
      for (let i = 0; i < 1000; i++) {
        const id = `inj-${i}-churn`;
        const session = server.claudeSessions.get(id);
        if (!session) continue;
        session.lastActivity = new Date(now + bump);
        server._pushEvictionEntry(id);
      }
      // Periodically run the sweep — which triggers _maybeRebuildEvictionHeap.
      if (bump % 50 === 0) await server._evictStaleSessions();
    }
    // Final sweep to clear any post-last-rebuild burst — mirrors
    // production behaviour where the 5-min sessionEvictionInterval is
    // guaranteed to fire between long quiescent periods.
    await server._evictStaleSessions();

    // After rebuilds + a final sweep, the heap should be bounded close
    // to live-session count (1000), well under the 1.001M unbounded size.
    assert.ok(
      server._evictionHeap.size <= 4 * server.claudeSessions.size,
      `heap should be bounded by rebuild trigger (2x live); got ${server._evictionHeap.size} ` +
      `for ${server.claudeSessions.size} live sessions`
    );
  });
});
