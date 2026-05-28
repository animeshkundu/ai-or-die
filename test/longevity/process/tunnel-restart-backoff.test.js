// test/longevity/process/tunnel-restart-backoff.test.js
//
// PROC-02 regression test — tunnel-manager.js crash / restart backoff.
//
// Memo: docs/audits/proc-child-processes.md
//
// What this proves on main HEAD (all assertions should PASS — this is a
// forward-looking guard against regression of the already-correct
// backoff discipline; tunnel-manager.js is the gold-standard sibling of
// vscode-tunnel.js which has known gaps tested separately):
//
//   - `_totalRestarts` monotonically increments per crash cycle.
//   - Backoff delay doubles per crash and caps at 30s.
//   - Stable uptime (> `_stabilityThresholdMs`) resets `retryCount`
//     so a long-uptime crash gets a fresh retry budget.
//   - `MAX_RETRIES` (10) bound is honored — beyond that the manager
//     gives up and does not respawn.
//
// We override `tunnel._spawn` (rather than monkey-patching the
// `child_process` module's `spawn` export — that import is bound at
// require time and post-load reassignment is invisible to the module).
// The override constructs a StubChildProcess and wires it into the
// production code paths that drive the restart logic:
//   - sets `this.process` to the stub
//   - attaches the same stdout/stderr/error/exit listeners _spawn does
//   - resolves the spawn promise on URL detection OR rejects on error
// This lets the test body drive crashes via `stubChild.emit('exit',1)`
// against the real _onExit-equivalent handler that triggers _restart.

'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');

let TunnelManagerModule;
try {
  TunnelManagerModule = require('../../../src/tunnel-manager.js');
} catch (_) { /* suite will be skipped */ }

// Stub ChildProcess — minimal surface for tunnel-manager.js needs.
class StubChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.killSignal = null;
  }
  kill(sig) {
    this.killSignal = sig || 'SIGTERM';
    this.killed = true;
    // Don't auto-emit exit — the test body controls timing.
  }
}

(TunnelManagerModule ? describe : describe.skip)('PROC-02: tunnel-manager crash/restart discipline', function () {
  this.timeout(15000);

  const { TunnelManager } = TunnelManagerModule || {};
  let tunnel, stubChildren;
  let originalSetTimeout;

  beforeEach(function () {
    stubChildren = [];

    tunnel = new TunnelManager({
      port: 19999,
      allowAnonymous: true,
      _stabilityThresholdMs: 50,
    });
    tunnel.tunnelId = 'test-tunnel-id';

    // Override _spawn: produce a stub, attach the production-equivalent
    // listeners, resolve the spawn promise on the FIRST URL emission,
    // and route crashes through the same _restart-on-exit path. We
    // mirror the listener attachments at tunnel-manager.js:317–363 so
    // the test exercises the same crash path the production code does.
    tunnel._spawn = function () {
      this._lastSpawnTime = Date.now();
      const proc = new StubChildProcess();
      stubChildren.push(proc);
      this.process = proc;

      return new Promise((resolve) => {
        let urlResolved = false;

        proc.stdout.on('data', (data) => {
          const output = data.toString();
          const match = output.match(/https:\/\/[\w.-]+\.devtunnels\.ms[^\s,]*/);
          if (match && !this.publicUrl) {
            this.publicUrl = match[0].trim();
            urlResolved = true;
            this._startStabilityTimer();
            resolve();
          }
        });
        proc.on('error', () => { if (!urlResolved) { urlResolved = true; resolve(); } });
        proc.on('exit', (code) => {
          this._clearStabilityTimer();
          this.process = null;
          if (!urlResolved) { urlResolved = true; resolve(); }
          // Mirror tunnel-manager.js:360: auto-restart if not stopped
          // and not user-initiated restart and exit code ≠ 0.
          if (!this.stopping && !this._restarting && code !== 0) {
            this._restart();
          }
        });
      });
    };

    // Intercept the backoff sleep so the test runs in <100ms wall-clock.
    // _restart at line 429 does `await new Promise(r => setTimeout(r, delay))`.
    // We capture delays >= 1000 (backoff range) and short-circuit them.
    originalSetTimeout = global.setTimeout;
    tunnel._capturedDelays = [];
    global.setTimeout = function (fn, ms, ...rest) {
      if (typeof ms === 'number' && ms >= 1000) {
        tunnel._capturedDelays.push(ms);
        const handle = { unref: () => {} };
        process.nextTick(() => fn());
        return handle;
      }
      return originalSetTimeout(fn, ms, ...rest);
    };
  });

  afterEach(async function () {
    if (originalSetTimeout) global.setTimeout = originalSetTimeout;
    if (tunnel) {
      try { await tunnel.stop(); } catch (_) {}
    }
    tunnel = null;
  });

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
  function emitUrlOnLatest() {
    const c = stubChildren[stubChildren.length - 1];
    c.stdout.emit('data', Buffer.from('Tunnel URL: https://test-foo.devtunnels.ms/\n'));
  }
  function crashLatest(code) {
    const c = stubChildren[stubChildren.length - 1];
    c.emit('exit', code === undefined ? 1 : code, null);
  }

  // -----------------------------------------------------------------------
  // Test 1: _totalRestarts increments per crash cycle
  // -----------------------------------------------------------------------
  it('_totalRestarts increments per crash cycle (5 cycles → totalRestarts === 5)', async function () {
    const spawnP = tunnel._spawn();
    emitUrlOnLatest();
    await spawnP;
    assert.strictEqual(tunnel._totalRestarts, 0, 'baseline: no restarts before any crash');

    for (let i = 1; i <= 5; i++) {
      crashLatest(1);
      // Wait for the _restart promise chain: exit handler → _restart
      // → captured setTimeout (fires immediately via nextTick) →
      // _spawn → URL match needed.
      await new Promise((r) => process.nextTick(r));
      await new Promise((r) => process.nextTick(r));
      await new Promise((r) => process.nextTick(r));
      // The new spawn is waiting for a URL — emit it.
      emitUrlOnLatest();
      await new Promise((r) => process.nextTick(r));
      assert.strictEqual(tunnel._totalRestarts, i,
        `_totalRestarts must be ${i} after ${i} crash cycles`);
    }
  });

  // -----------------------------------------------------------------------
  // Test 2: backoff doubles, caps at 30s
  // -----------------------------------------------------------------------
  it('backoff delay doubles per crash and caps at MAX_RESTART_DELAY_MS (30s)', async function () {
    const spawnP = tunnel._spawn();
    emitUrlOnLatest();
    await spawnP;
    tunnel._capturedDelays.length = 0;

    // Crash 6 times rapid-fire WITHOUT letting the stability timer fire
    // (each new spawn never gets a URL emitted, so the stability timer
    // never starts, so retryCount keeps climbing).
    for (let i = 0; i < 6; i++) {
      crashLatest(1);
      await new Promise((r) => process.nextTick(r));
      await new Promise((r) => process.nextTick(r));
      await new Promise((r) => process.nextTick(r));
    }

    // Formula at tunnel-manager.js:417:
    //   delay = min(2^(retryCount-1) * 1000, 30000)
    // retryCount sequence on crashes: 1, 2, 3, 4, 5, 6
    // → delays:  1000, 2000, 4000, 8000, 16000, 30000(capped)
    assert.deepStrictEqual(tunnel._capturedDelays,
      [1000, 2000, 4000, 8000, 16000, 30000],
      'backoff must double per crash and cap at MAX_RESTART_DELAY_MS=30000');
  });

  // -----------------------------------------------------------------------
  // Test 3: stable uptime resets retryCount
  // -----------------------------------------------------------------------
  it('retryCount resets after stable uptime (> _stabilityThresholdMs)', async function () {
    // Spawn, get URL → stability timer starts (50ms in this test).
    const spawnP = tunnel._spawn();
    emitUrlOnLatest();
    await spawnP;

    // Crash → respawn → URL → stability timer starts again.
    crashLatest(1);
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));
    emitUrlOnLatest();
    await new Promise((r) => process.nextTick(r));
    assert.strictEqual(tunnel.retryCount, 1, 'retryCount=1 after one crash');

    // Wait long enough for the stability timer (50ms) to fire.
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(tunnel.retryCount, 0,
      'retryCount must reset to 0 after stable uptime > _stabilityThresholdMs');

    // Verify the reset has practical effect: a fresh crash gets a fresh
    // 1000ms backoff (not 2000ms which would be 2^(2-1) for retryCount=2).
    tunnel._capturedDelays.length = 0;
    crashLatest(1);
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));
    assert.deepStrictEqual(tunnel._capturedDelays, [1000],
      'post-reset crash must use base delay (1000ms), proving retryCount was reset');
  });

  // -----------------------------------------------------------------------
  // Test 4: MAX_RETRIES bound is honored
  // -----------------------------------------------------------------------
  it('MAX_RETRIES (10) bound is honored — no respawn at the cap', async function () {
    const spawnP = tunnel._spawn();
    emitUrlOnLatest();
    await spawnP;

    // Crash 10 times rapid-fire (no stability reset). retryCount climbs
    // to 10. The 11th crash should hit retryCount > MAX_RETRIES branch
    // at tunnel-manager.js:405 and NOT schedule a respawn.
    for (let i = 0; i < 10; i++) {
      crashLatest(1);
      await new Promise((r) => process.nextTick(r));
      await new Promise((r) => process.nextTick(r));
      await new Promise((r) => process.nextTick(r));
    }
    assert.strictEqual(tunnel.retryCount, 10, 'retryCount at the cap');
    const spawnsSoFar = stubChildren.length;
    tunnel._capturedDelays.length = 0;

    // 11th crash — retryCount becomes 11, > MAX_RETRIES (10), branch
    // at line 405 fires, console errors, function returns WITHOUT
    // scheduling a respawn.
    crashLatest(1);
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));

    assert.strictEqual(tunnel._capturedDelays.length, 0,
      'at retryCount > MAX_RETRIES, _restart must NOT schedule a respawn');
    assert.strictEqual(stubChildren.length, spawnsSoFar,
      'no new child process must be spawned past MAX_RETRIES');
  });

  // -----------------------------------------------------------------------
  // Test 5: stop() during in-flight backoff aborts cleanly
  // -----------------------------------------------------------------------
  it('stop() during in-flight backoff aborts the pending restart without spawning a new child', async function () {
    const spawnP = tunnel._spawn();
    emitUrlOnLatest();
    await spawnP;

    // Replace our test setTimeout shim with one that does NOT fire fn,
    // so the backoff delay is observably "in flight" — letting us
    // exercise the stop() abort path.
    tunnel._capturedDelays.length = 0;
    global.setTimeout = function (fn, ms) {
      if (typeof ms === 'number' && ms >= 1000) {
        tunnel._capturedDelays.push(ms);
        return { unref: () => {} };
      }
      return originalSetTimeout(fn, ms);
    };

    crashLatest(1);
    // Wait for _restart to enter its await-Promise window.
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));

    assert.strictEqual(tunnel._capturedDelays.length, 1,
      '_restart entered the backoff window (1 delay captured)');
    const spawnsAfterCrash = stubChildren.length;

    // stop() should abort the pending resolve.
    await tunnel.stop();
    // Wait a tick to make sure no respawn slips through.
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));

    assert.strictEqual(stubChildren.length, spawnsAfterCrash,
      'stop() during in-flight backoff must NOT allow a new spawn');
    assert.strictEqual(tunnel.stopping, true, 'tunnel.stopping flag is set');
  });
});
