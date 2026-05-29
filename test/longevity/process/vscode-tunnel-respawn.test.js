// test/longevity/process/vscode-tunnel-respawn.test.js
//
// PROC-02 regression test — vscode-tunnel.js crash / restart discipline.
//
// Memo: docs/audits/proc-child-processes.md
//
// What this proves on main HEAD:
//
//   1. (PASS) Backoff math: per-tunnel `retryCount` climbs per crash,
//      backoff doubles up to the MAX_RESTART_DELAY_MS cap.
//   2. (FAIL on main) `_restart` re-entrancy: the natural exit handler
//      and the health-check sweep can both call `_restart(sessionId)`,
//      double-incrementing `retryCount`. There is no `_restarting`
//      guard. THIS IS GAP 2 IN THE MEMO.
//   3. (SKIPPED on main) Stable-uptime reset of `retryCount`: requires
//      a per-instance `_stabilityThresholdMs` override that does not
//      exist on `vscode-tunnel.js`. THIS IS GAP 3 IN THE MEMO. The
//      test is left as `it.skip` with a load-bearing TODO; it will
//      flip to `it` once the override lands.
//   4. (PASS) `MAX_RETRIES` (10) bound is honored — no respawn at cap;
//      `tunnel.status === 'error'`, `_cleanupTunnel` runs.
//
// We bypass the CLI-discovery, auth, and `code serve-web` paths by
// calling `_spawnTunnel` (the `devtunnel host` spawn) directly with a
// hand-crafted tunnel state. The `_spawnTunnel` method is the kernel
// of the tunnel-side respawn logic; for the server-side respawn the
// same restart machinery applies via `_whichDied`.

'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');

let VSCodeTunnelModule;
try {
  VSCodeTunnelModule = require('../../../src/vscode-tunnel.js');
} catch (_) { /* suite will be skipped */ }

class StubChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.exitCode = null;
    this.killSignal = null;
  }
  kill(sig) {
    this.killSignal = sig || 'SIGTERM';
    this.killed = true;
    this.exitCode = sig === 'SIGKILL' ? 137 : 0;
    process.nextTick(() => this.emit('exit', this.exitCode, sig || null));
  }
}

(VSCodeTunnelModule ? describe : describe.skip)('PROC-02: vscode-tunnel crash/restart discipline', function () {
  this.timeout(15000);

  const { VSCodeTunnelManager } = VSCodeTunnelModule || {};
  let mgr, sessionId, tunnel, stubChildren, originalSetTimeout;

  beforeEach(function () {
    stubChildren = [];
    mgr = new VSCodeTunnelManager();
    sessionId = 'test-sess-' + Date.now();

    // Pre-allocate a tunnel state object matching vscode-tunnel.js:119–139.
    tunnel = {
      serverProcess: null,
      tunnelProcess: null,
      _loginProcess: null,
      localPort: 19199,
      connectionToken: 'tok',
      localUrl: 'http://localhost:19199/?tkn=tok',
      publicUrl: null,
      tunnelId: 'test-vscode-tunnel',
      status: 'starting',
      sessionId,
      workingDir: process.cwd(),
      retryCount: 0,
      stopping: false,
      _lastSpawnTime: null,
      _totalRestarts: 0,
      _stabilityTimer: null,
      _restartDelayTimer: null,
      _restartDelayResolve: null,
      _whichDied: null,
    };
    mgr.tunnels.set(sessionId, tunnel);

    // Override _spawnTunnel: same shape as production at
    // vscode-tunnel.js:766–847, but with stub children so we control
    // the crash timing. We mirror the load-bearing handlers (stdout
    // URL match, exit → _restart with _whichDied='tunnel').
    mgr._spawnTunnel = function (sid) {
      const t = this.tunnels.get(sid);
      if (!t || t.stopping) return Promise.resolve();
      const proc = new StubChildProcess();
      stubChildren.push(proc);
      t.tunnelProcess = proc;
      t._lastSpawnTime = Date.now();

      return new Promise((resolve) => {
        let urlResolved = false;
        proc.stdout.on('data', (data) => {
          const match = data.toString().match(/https:\/\/[\w.-]+\.devtunnels\.ms[^\s,]*/);
          if (match && !t.publicUrl) {
            t.publicUrl = match[0].trim() + '?tkn=' + t.connectionToken;
            t.status = 'running';
            urlResolved = true;
            mgr._startStabilityTimer(t);
            resolve();
          }
        });
        proc.on('error', () => { if (!urlResolved) { urlResolved = true; resolve(); } });
        proc.on('exit', (code) => {
          t.tunnelProcess = null;
          if (!urlResolved) { urlResolved = true; resolve(); }
          // Mirror vscode-tunnel.js:841: auto-restart if not stopping.
          if (!t.stopping && mgr.tunnels.has(sid)) {
            t._whichDied = 'tunnel';
            mgr._restart(sid);
          }
        });
      });
    };

    // We also stub _ensureDevtunnel so _restart's tunnel-only branch
    // (lines 967–971) can complete without invoking the real
    // `devtunnel create` / `devtunnel port create` chain.
    mgr._ensureDevtunnel = function () { return Promise.resolve(true); };

    // Intercept the backoff sleep so the test runs fast. Narrow the
    // capture window to the backoff range [MIN_RESTART_DELAY_MS=1000,
    // MAX_RESTART_DELAY_MS=30000] so the stability timer (60000 default
    // or overridden) is NOT captured + nextTick-fired — that would
    // collapse the timer to immediate execution and silently reset
    // retryCount in the middle of the test. Stability + other timers
    // pass through to the real setTimeout (which won't fire during the
    // test's short wall-clock).
    originalSetTimeout = global.setTimeout;
    tunnel._capturedDelays = [];
    global.setTimeout = function (fn, ms, ...rest) {
      if (typeof ms === 'number' && ms >= 1000 && ms <= 30000) {
        tunnel._capturedDelays.push(ms);
        const handle = { unref: () => {} };
        process.nextTick(() => fn());
        return handle;
      }
      return originalSetTimeout(fn, ms, ...rest);
    };

    // Simulate the serverProcess being alive — vscode-tunnel's _restart
    // takes the tunnel-only branch when `_whichDied === 'tunnel' &&
    // tunnel.serverProcess` is truthy (line 917). Without this, _restart
    // takes the server-restart branch which requires _spawnServer too.
    tunnel.serverProcess = new StubChildProcess();
    stubChildren.push(tunnel.serverProcess);
  });

  afterEach(async function () {
    if (originalSetTimeout) global.setTimeout = originalSetTimeout;
    if (mgr) {
      try { await mgr.stopAll(); } catch (_) {}
    }
    mgr = null;
  });

  function emitUrlOnLatestTunnel() {
    // Find the most recently created tunnelProcess (not serverProcess).
    // We track by stubChildren order: the latest one we pushed in
    // _spawnTunnel.
    const t = mgr.tunnels.get(sessionId);
    if (!t || !t.tunnelProcess) {
      throw new Error('no live tunnelProcess to emit URL on');
    }
    t.tunnelProcess.stdout.emit('data',
      Buffer.from('Tunnel URL: https://vscode-test.devtunnels.ms/\n'));
  }
  function crashLatestTunnel(code) {
    const t = mgr.tunnels.get(sessionId);
    if (!t || !t.tunnelProcess) {
      throw new Error('no live tunnelProcess to crash');
    }
    t.tunnelProcess.emit('exit', code === undefined ? 1 : code);
  }

  // Helper used by tests 1 and 4: drive one full crash → restart → URL
  // cycle, waiting long enough for `_restart`'s `_restarting` guard to
  // clear (cleared in the `finally` block of `_restart` AFTER
  // `_spawnTunnel` resolves on URL emit). Without emitting URL in
  // between, the next crash's `_restart` call is correctly serialised
  // by the PROC-02 gap-2 fix and never captures its delay.
  async function settleOneCycle() {
    // 1. Yield enough ticks for the exit handler → _restart → captured
    //    setTimeout(delay) → nextTick-shim → _restart resumes →
    //    _spawnTunnel called → fresh tunnelProcess created.
    for (let t = 0; t < 8; t++) {
      await new Promise((r) => process.nextTick(r));
    }
    // 2. If a fresh tunnelProcess exists, emit URL so _spawnTunnel
    //    resolves and _restart can finish (clearing _restarting).
    const t = mgr.tunnels.get(sessionId);
    if (t && t.tunnelProcess) {
      t.tunnelProcess.stdout.emit('data',
        Buffer.from('Tunnel URL: https://vscode-test.devtunnels.ms/\n'));
    }
    // 3. Yield more ticks for _restart's tail (URL handler →
    //    _spawnTunnel resolves → _restart's finally clears _restarting).
    for (let t = 0; t < 5; t++) {
      await new Promise((r) => process.nextTick(r));
    }
  }

  // -----------------------------------------------------------------------
  // Test 1: backoff escalates per crash and caps at MAX_RESTART_DELAY_MS
  // -----------------------------------------------------------------------
  it('backoff doubles per crash and caps at MAX_RESTART_DELAY_MS (30s)', async function () {
    const spawnP = mgr._spawnTunnel(sessionId);
    emitUrlOnLatestTunnel();
    await spawnP;
    tunnel._capturedDelays.length = 0;

    // 6 crashes without stability-reset: delays should climb 1k, 2k,
    // 4k, 8k, 16k, capped at 30k. Each cycle waits for _spawnTunnel
    // to resolve so the PROC-02 gap-2 `_restarting` serialisation
    // releases before the next crash.
    for (let i = 0; i < 6; i++) {
      crashLatestTunnel(1);
      await settleOneCycle();
    }

    assert.deepStrictEqual(tunnel._capturedDelays,
      [1000, 2000, 4000, 8000, 16000, 30000],
      'vscode-tunnel backoff must climb [1000,2000,4000,8000,16000,30000] ' +
      'per vscode-tunnel.js:912–915');
  });

  // -----------------------------------------------------------------------
  // Test 2: _restart re-entrancy race — GAP 2 IN THE MEMO
  //
  // The natural exit handler at vscode-tunnel.js:831 calls _restart;
  // the health-check sweep at line 1005 ALSO calls _restart on the
  // same dead process. There is no `_restarting` guard, so both calls
  // execute and increment `retryCount` and `_totalRestarts` twice for
  // a single death event.
  //
  // We test the load-bearing signal: `_totalRestarts` is unconditionally
  // incremented at vscode-tunnel.js:885 BEFORE any branching, so a
  // double-call shows +2 instead of +1. Same for `retryCount` at line
  // 886. The fix is a per-tunnel `_restarting` flag mirroring
  // tunnel-manager.js:96.
  //
  // On main HEAD this FAILS — see memo gap 2.
  // -----------------------------------------------------------------------
  it('_restart must NOT double-increment _totalRestarts when called concurrently (gap 2 in memo)', async function () {
    const spawnP = mgr._spawnTunnel(sessionId);
    emitUrlOnLatestTunnel();
    await spawnP;

    tunnel._capturedDelays.length = 0;
    const totalBefore = tunnel._totalRestarts;
    const retryBefore = tunnel.retryCount;

    // Stub _ensureDevtunnel + _spawnTunnel to resolve immediately so
    // neither _restart hangs awaiting downstream operations. The
    // load-bearing observation is the synchronous increment at
    // vscode-tunnel.js:885–886 BEFORE any await.
    mgr._spawnTunnel = function () { return Promise.resolve(); };

    // Set _whichDied to 'tunnel' BEFORE each call so both invocations
    // take the same branch. This is faithful to the real race: in
    // production both call sites set `_whichDied = 'tunnel'` (exit
    // handler at line 842, health-check sweep at line 1009) before
    // invoking _restart.
    tunnel._whichDied = 'tunnel';
    const p1 = mgr._restart(sessionId);
    tunnel._whichDied = 'tunnel';
    const p2 = mgr._restart(sessionId);

    // Don't Promise.all (would hang on the captured-delay setTimeout
    // because the second _restart enters the same "await setTimeout"
    // and on our nextTick-shim that's fine, but the assert wants to
    // see post-increment-pre-cleanup state). Just yield enough ticks
    // for both calls to pass through the synchronous increment block
    // (line 885–886). The increment is unconditional, NOT gated by an
    // await — so a single tick suffices.
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));

    // Load-bearing assertions. `_totalRestarts` is incremented at line
    // 885 BEFORE any conditional logic; `retryCount` at line 886. A
    // proper `_restarting` guard would short-circuit the second call
    // before either increment.
    assert.strictEqual(tunnel._totalRestarts, totalBefore + 1,
      'PROC-02 gap 2: concurrent _restart calls must NOT double-increment _totalRestarts. ' +
      'On main HEAD this FAILS — vscode-tunnel.js has no _restarting guard. ' +
      'See docs/audits/proc-child-processes.md gap 2.');
    assert.strictEqual(tunnel.retryCount, retryBefore + 1,
      'PROC-02 gap 2: concurrent _restart calls must NOT double-increment retryCount.');

    // Let the two pending Promises resolve so afterEach doesn't see
    // dangling promises (irrelevant — fire-and-forget — but tidy).
    await Promise.all([p1, p2]).catch(() => {});
  });

  // -----------------------------------------------------------------------
  // Test 3: stable-uptime reset of retryCount — GAP 3 IN THE MEMO
  //
  // The fix landed: vscode-tunnel.js now accepts `_stabilityThresholdMs`
  // in the constructor and threads it through `_startStabilityTimer`.
  // We construct a fresh manager with a 50 ms threshold, drive a crash,
  // emit URL (starts the stability timer), wait > 50 ms, then verify
  // retryCount has been reset to 0.
  // -----------------------------------------------------------------------
  it('retryCount resets after _stabilityThresholdMs uptime (gap 3 in memo — now fixed)', async function () {
    // Build a fresh manager with the shrunk stability threshold so the
    // test does not have to wait 60 s of wall-clock per cycle.
    const fastMgr = new VSCodeTunnelManager({ _stabilityThresholdMs: 50 });
    const sid = 'gap3-' + Date.now();
    const t = {
      serverProcess: null,
      tunnelProcess: null,
      _loginProcess: null,
      localPort: 19299,
      connectionToken: 'tok',
      localUrl: 'http://localhost:19299/?tkn=tok',
      publicUrl: null,
      tunnelId: 'gap3-tunnel',
      status: 'starting',
      sessionId: sid,
      workingDir: process.cwd(),
      retryCount: 3, // pretend we've already accumulated retries
      stopping: false,
      _lastSpawnTime: null,
      _totalRestarts: 0,
      _stabilityTimer: null,
      _restartDelayTimer: null,
      _restartDelayResolve: null,
      _whichDied: null,
    };
    fastMgr.tunnels.set(sid, t);

    // Kick the stability timer directly — that's what _spawnTunnel does
    // on URL resolution. With the 50 ms threshold the reset should fire
    // within ~70 ms.
    fastMgr._startStabilityTimer(t);
    await new Promise((r) => originalSetTimeout(r, 120));

    assert.strictEqual(t.retryCount, 0,
      'PROC-02 gap 3: with _stabilityThresholdMs=50 ms override, retryCount ' +
      'should reset to 0 within ~70 ms of _startStabilityTimer. See memo gap 3.');

    // Tidy
    fastMgr._clearStabilityTimer(t);
    fastMgr.tunnels.delete(sid);
  });

  // -----------------------------------------------------------------------
  // Test 4: MAX_RETRIES (10) bound is honored
  // -----------------------------------------------------------------------
  it('MAX_RETRIES (10) bound is honored — tunnel.status flips to "error", _cleanupTunnel runs', async function () {
    const spawnP = mgr._spawnTunnel(sessionId);
    emitUrlOnLatestTunnel();
    await spawnP;
    tunnel._capturedDelays.length = 0;

    // 10 crashes — retryCount climbs to 10. The 11th hits the cap.
    // Each cycle waits for _spawnTunnel to resolve so the PROC-02
    // gap-2 `_restarting` serialisation releases before the next crash.
    for (let i = 0; i < 10; i++) {
      crashLatestTunnel(1);
      await settleOneCycle();
    }
    assert.strictEqual(tunnel.retryCount, 10, 'retryCount at the cap after 10 crashes');
    tunnel._capturedDelays.length = 0;
    const spawnsBefore = stubChildren.length;

    // 11th crash → retryCount becomes 11, > MAX_RETRIES → fatal branch
    // at vscode-tunnel.js:897.
    crashLatestTunnel(1);
    for (let t = 0; t < 10; t++) {
      await new Promise((r) => process.nextTick(r));
    }

    // The load-bearing assertion: past MAX_RETRIES, no NEW spawn occurs.
    // The _capturedDelays length is a softer signal because a dangling
    // pre-cap _restart's setTimeout may still be in flight when we
    // reset — we tolerate at most 1 spurious capture from that source.
    assert.ok(tunnel._capturedDelays.length <= 1,
      `past MAX_RETRIES, at most one in-flight delay may settle (got ${tunnel._capturedDelays.length})`);
    assert.strictEqual(stubChildren.length, spawnsBefore,
      'past MAX_RETRIES, no new tunnelProcess must spawn');
    assert.strictEqual(mgr.tunnels.has(sessionId), false,
      'past MAX_RETRIES, _cleanupTunnel must drop the tunnel entry from the Map');
    assert.strictEqual(tunnel.status, 'error',
      'past MAX_RETRIES, tunnel.status must be "error"');
  });
});
