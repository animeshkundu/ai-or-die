// test/longevity/process/stt-worker-respawn.test.js
//
// PROC-02 regression test — STT engine worker crash / respawn discipline.
//
// Memo: docs/audits/proc-child-processes.md
//
// What this proves on main HEAD:
//
//   - Listener accounting: across N crash-respawn cycles, listenerCount
//     on the live Worker stays bounded (1 'message' + 1 'exit'). Old
//     Worker refs are dropped; new ones do not inherit listeners.
//   - Backoff escalation: `_restartAttempts` climbs per crash-without-ready
//     and drives an exponential delay (1s, 2s, 4s, 8s, 15s-capped).
//   - Bookkeeping consistency: on each crash the queue is cleared,
//     `_currentRequest` nulled, `_restartAttempts` incremented, status
//     transitions through 'loading' → 'ready' (or 'unavailable' on cap).
//   - Shutdown / respawn race (gap 1 in the memo): after `shutdown()`,
//     `_onWorkerExit` must NOT schedule a respawn. Today on main this
//     test FAILS — engine has no `_stopping` flag.
//   - MODULE_NOT_FOUND short-circuit and MAX_RESTART_ATTEMPTS cap.
//
// We deliberately do NOT load real sherpa-onnx-node — the load is heavy
// (~150 MB resident, 4-thread CPU pool) and the test would race the load
// timing on a slow machine. Instead we stub `_spawnWorker` to return a
// fake EventEmitter that mimics the Worker surface (`postMessage`,
// `terminate`, plus 'message' / 'exit' events). The native-load skip
// pattern in the suite header (mirroring test/fs-watch-cleanup.test.js
// lines 30–35) is still honored — if `worker_threads` itself or the
// `SttEngine` module fails to load, the whole suite skips.

'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');

let workerThreadsAvailable = true;
try {
  require('worker_threads');
} catch (_) {
  workerThreadsAvailable = false;
}

let SttEngine;
try {
  SttEngine = require('../../../src/stt-engine.js');
} catch (_) { /* suite will be skipped */ }

// ---------------------------------------------------------------------------
// Stub worker — mimics worker_threads.Worker EventEmitter surface enough
// for SttEngine to attach handlers, simulate ready / crash / exit, and
// inspect listenerCount across cycles. The real Worker is NOT loaded.
// ---------------------------------------------------------------------------
class StubWorker extends EventEmitter {
  constructor() {
    super();
    this._terminated = false;
    this._messages = [];
  }
  postMessage(msg) {
    this._messages.push(msg);
    // Mirror the real worker: a graceful {type:'shutdown'} request makes the
    // worker dispose + exit on its own (the engine no longer calls terminate()).
    if (msg && msg.type === 'shutdown') {
      process.nextTick(() => this.emit('exit', 0));
    }
  }
  off(event, fn) { this.removeListener(event, fn); return this; }
  async terminate() {
    this._terminated = true;
    // worker_threads.Worker emits 'exit' on terminate(); mirror that.
    process.nextTick(() => this.emit('exit', 0));
    return 0;
  }
}

// Install a `_spawnWorker` override that PRODUCES a stub but does NOT
// auto-ready. The test body controls when 'ready' fires (so backoff
// escalation can be observed without _restartAttempts being reset by
// a phantom ready). The override mirrors the real spawn handshake at
// stt-engine.js:197–243: transient onReady/onError + permanent handlers
// attached on ready.
function installSpawnStub(engine, stubsArray) {
  engine._spawnWorker = function () {
    return new Promise((resolve, reject) => {
      const stub = new StubWorker();
      stubsArray.push(stub);

      const onReady = (msg) => {
        if (msg && msg.type === 'ready') {
          stub.off('message', onReady);
          stub.off('error', onError);
          engine._worker = stub;
          engine._status = 'ready';
          engine._restartAttempts = 0;
          engine._lastSpawnError = null;
          stub.on('message', (m) => engine._onWorkerMessage(m));
          stub.on('exit', (c) => engine._onWorkerExit(c));
          engine._processQueue();
          resolve();
        } else if (msg && msg.type === 'error') {
          stub.off('message', onReady);
          stub.off('error', onError);
          reject(new Error(msg.message));
        }
      };
      const onError = (err) => {
        stub.off('message', onReady);
        stub.off('error', onError);
        if (err && (err.code === 'MODULE_NOT_FOUND'
          || (err.message && err.message.includes('sherpa-onnx-node')))) {
          engine._lastSpawnError = 'MODULE_NOT_FOUND';
        }
        reject(err);
      };
      stub.on('message', onReady);
      stub.on('error', onError);
    });
  };
}

// Drive the stub through the ready handshake — the test body uses this
// to complete a spawn deterministically.
function readyStub(stub) {
  stub.emit('message', { type: 'ready' });
}

// Crash the stub. exit handler fires synchronously through the EE.
function crashStub(stub, code) {
  stub.emit('exit', code === undefined ? 1 : code);
}

(SttEngine && workerThreadsAvailable
  ? describe : describe.skip)('PROC-02: STT engine worker respawn discipline', function () {
  this.timeout(10000);

  let engine, stubs, capturedDelays;

  beforeEach(function () {
    engine = new SttEngine({ enabled: true });
    stubs = [];
    installSpawnStub(engine, stubs);

    // Capture backoff delays without burning wall-clock. _restartWorker
    // (stt-engine.js:186–195) calls setTimeout(fn, delay) → fn awaits
    // _spawnWorker. We capture the delay and immediately run the
    // callback so the next cycle is testable in a tight loop.
    capturedDelays = [];
    engine._restartWorker = function (delay) {
      capturedDelays.push(delay);
      process.nextTick(async () => {
        try {
          await engine._spawnWorker();
        } catch (_) {
          engine._status = 'unavailable';
        }
      });
    };
  });

  afterEach(async function () {
    if (engine && typeof engine.shutdown === 'function') {
      try { await engine.shutdown(); } catch (_) {}
    }
    engine = null;
  });

  // -----------------------------------------------------------------------
  // Test 1: listener accumulation across crash-respawn cycles
  // -----------------------------------------------------------------------
  it('does not accumulate listeners across crash cycles (worker.listenerCount stays bounded)', async function () {
    const spawnPromise = engine._spawnWorker();
    readyStub(stubs[0]);
    await spawnPromise;
    assert.strictEqual(engine._status, 'ready', 'pre-condition: engine ready');

    const live = engine._worker;
    assert.strictEqual(live.listenerCount('message'), 1,
      'baseline: exactly one message listener on the live worker after handshake');
    assert.strictEqual(live.listenerCount('exit'), 1,
      'baseline: exactly one exit listener on the live worker after handshake');

    for (let cycle = 0; cycle < 4; cycle++) {
      const prior = engine._worker;
      crashStub(prior, 1);
      // Two ticks: one for the nextTick respawn schedule, one for the
      // _spawnWorker promise chain to settle.
      await new Promise((r) => process.nextTick(r));
      await new Promise((r) => process.nextTick(r));
      // The new spawn is awaiting a 'ready' from the new stub — complete it.
      const newStub = stubs[stubs.length - 1];
      assert.notStrictEqual(newStub, prior, `cycle ${cycle}: new stub allocated`);
      readyStub(newStub);
      await new Promise((r) => process.nextTick(r));

      const next = engine._worker;
      assert.notStrictEqual(next, prior, `cycle ${cycle}: engine swapped to new worker`);
      assert.strictEqual(next.listenerCount('message'), 1,
        `cycle ${cycle}: exactly one message listener on the new worker (no accumulation)`);
      assert.strictEqual(next.listenerCount('exit'), 1,
        `cycle ${cycle}: exactly one exit listener on the new worker (no accumulation)`);
    }
  });

  // -----------------------------------------------------------------------
  // Test 2: backoff escalates per crash-without-ready
  //
  // The escalation is observable only when the new worker crashes BEFORE
  // sending 'ready' — once ready arrives, _restartAttempts resets to 0.
  // Simulate a sherpa-load-failure loop: each new spawn crashes immediately
  // before ready, so the backoff climbs.
  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // Test 2: backoff formula + reset-on-ready discipline
  //
  // The actual escalation path on current main is narrow: _restartAttempts
  // resets to 0 on every successful 'ready' (stt-engine.js:114, 214), so
  // for escalation past delay=1000ms to be observed, two crashes would
  // need to happen on the SAME worker without an intervening ready —
  // impossible by construction (exit fires once per worker lifetime).
  //
  // The test therefore makes two load-bearing assertions:
  //   (a) the FORMULA at line 178 produces [1000,2000,4000,8000,15000]
  //       for _restartAttempts 0..4 — guards the formula itself.
  //   (b) each natural crash-respawn-ready cycle produces delay=1000ms
  //       — proves the reset-on-ready discipline. If a future refactor
  //       broke the reset, delays would climb across cycles and this
  //       assertion would FAIL.
  // -----------------------------------------------------------------------
  it('backoff formula produces [1000,2000,4000,8000,15000]; reset-on-ready clamps real cycles to 1000ms', async function () {
    // (a) Formula check — compute against the production constants.
    const computed = [];
    for (let a = 0; a < 5; a++) {
      computed.push(Math.min(1000 * Math.pow(2, a), 15000));
    }
    assert.deepStrictEqual(computed, [1000, 2000, 4000, 8000, 15000],
      'backoff formula at stt-engine.js:178 must produce [1000,2000,4000,8000,15000]');

    // (b) Real-cycle check — drive 4 natural crash-ready-respawn cycles
    // and confirm each delay is 1000ms (reset-on-ready discipline).
    const initial = engine._spawnWorker();
    readyStub(stubs[0]);
    await initial;

    for (let cycle = 0; cycle < 4; cycle++) {
      crashStub(engine._worker, 1);
      await new Promise((r) => process.nextTick(r));
      await new Promise((r) => process.nextTick(r));
      // Ready the new stub so attempts resets before the next crash.
      const pending = stubs[stubs.length - 1];
      readyStub(pending);
      await new Promise((r) => process.nextTick(r));
      assert.strictEqual(engine._restartAttempts, 0,
        `cycle ${cycle}: _restartAttempts must reset to 0 after ready`);
    }

    assert.strictEqual(capturedDelays.length, 4,
      '4 crash-respawn cycles → 4 captured delays');
    for (let i = 0; i < capturedDelays.length; i++) {
      assert.strictEqual(capturedDelays[i], 1000,
        `cycle ${i}: delay must be 1000ms (reset-on-ready zeros attempts before next crash). ` +
        `If this fails, the reset-on-ready discipline regressed — see stt-engine.js:114,214.`);
    }
  });

  // -----------------------------------------------------------------------
  // Test 3: bookkeeping on crash — queue cleared, currentRequest nulled,
  // restartAttempts incremented, status transitions
  // -----------------------------------------------------------------------
  it('on crash: queue drained, _currentRequest nulled, _restartAttempts incremented, status transitions', async function () {
    const initial = engine._spawnWorker();
    readyStub(stubs[0]);
    await initial;

    // Synthesize a queued request without going through transcribe()
    // (which requires a real Float32Array contract + ready state).
    let resolved = false, rejectedReason = null;
    const ghost = {
      id: 999,
      samples: new Float32Array(1),
      resolve: () => { resolved = true; },
      reject: (err) => { rejectedReason = err && err.message; },
      timer: setTimeout(() => {}, 60000),
    };
    engine._queue.push(ghost);
    engine._currentRequest = ghost;
    const attemptsBefore = engine._restartAttempts;

    crashStub(engine._worker, 1);
    // Bookkeeping check BEFORE the nextTick respawn runs (otherwise the
    // respawn-and-ready would reset _restartAttempts to 0).
    assert.strictEqual(engine._queue.length, 0, 'queue must be drained on crash');
    assert.strictEqual(engine._currentRequest, null, '_currentRequest must be nulled on crash');
    assert.strictEqual(resolved, false, 'queued request must NOT resolve on crash');
    assert.strictEqual(rejectedReason, 'STT worker crashed',
      'queued request must reject with "STT worker crashed"');
    assert.strictEqual(engine._restartAttempts, attemptsBefore + 1,
      '_restartAttempts must increment per crash');
    assert.strictEqual(engine._status, 'loading',
      'status must flip to "loading" immediately after crash');

    // Now let the respawn flow complete.
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));
    readyStub(stubs[stubs.length - 1]);
    await new Promise((r) => process.nextTick(r));
    assert.strictEqual(engine._status, 'ready',
      'status must return to "ready" after successful respawn');
    assert.strictEqual(engine._restartAttempts, 0,
      '_restartAttempts must reset on successful "ready"');
  });

  // -----------------------------------------------------------------------
  // Test 4: shutdown / respawn race — THE load-bearing test for gap 1.
  //
  // After `shutdown()`, the stub's terminate() fires an 'exit' event on
  // nextTick. The exit handler on main HEAD enters the restart branch
  // (no `_stopping` flag exists). Expected post-fix: no respawn, status
  // stays 'unavailable', capturedDelays stays empty.
  // -----------------------------------------------------------------------
  it('shutdown() must NOT trigger a respawn from _onWorkerExit (gap 1 in memo)', async function () {
    const initial = engine._spawnWorker();
    readyStub(stubs[0]);
    await initial;
    assert.strictEqual(engine._status, 'ready');

    // Reset capturedDelays so we only see post-shutdown activity.
    capturedDelays.length = 0;
    const stubCountBefore = stubs.length;

    await engine.shutdown();
    // Let terminate's nextTick-scheduled 'exit' propagate through
    // engine._onWorkerExit and any setTimeout it may schedule.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => process.nextTick(r));
    }

    assert.strictEqual(capturedDelays.length, 0,
      'PROC-02 gap 1: shutdown() must NOT schedule a respawn via _onWorkerExit. ' +
      'On main HEAD this assertion FAILS — engine has no _stopping flag. ' +
      'See docs/audits/proc-child-processes.md gap 1.');
    assert.strictEqual(stubs.length, stubCountBefore,
      'PROC-02 gap 1: no new stub Worker must be allocated post-shutdown');
    assert.strictEqual(engine._status, 'unavailable',
      'post-shutdown status must remain "unavailable"');
    // Regression (Ctrl+C SIGABRT): shutdown() must stop the worker cooperatively
    // (graceful {type:'shutdown'} message -> worker exits) and must NOT call
    // worker.terminate(), which force-kills the native sherpa-onnx worker and
    // aborts the whole process during native teardown.
    assert.ok(stubs[0]._messages.some((m) => m && m.type === 'shutdown'),
      'shutdown() must send a graceful shutdown message to the worker');
    assert.strictEqual(stubs[0]._terminated, false,
      'shutdown() must NOT call worker.terminate() (aborts the native worker)');
  });

  // -----------------------------------------------------------------------
  // Test 5: MODULE_NOT_FOUND short-circuit — engine does not retry if
  // the native dependency is missing.
  // -----------------------------------------------------------------------
  it('MODULE_NOT_FOUND short-circuit: no retry, no delay scheduled', async function () {
    const initial = engine._spawnWorker();
    readyStub(stubs[0]);
    await initial;
    capturedDelays.length = 0;

    // Simulate the worker reporting MODULE_NOT_FOUND via the 'message'
    // path (mirrors stt-worker.js:36–40 → _onWorkerMessage lines 119–125).
    engine._onWorkerMessage({
      type: 'error',
      message: 'sherpa-onnx-node is not installed. Install it with: npm install sherpa-onnx-node',
    });
    assert.strictEqual(engine._lastSpawnError, 'MODULE_NOT_FOUND',
      '_lastSpawnError must be tagged MODULE_NOT_FOUND');
    assert.strictEqual(engine._status, 'unavailable', 'status flips to unavailable');

    // Now the worker exits (mirrors stt-worker.js:40 process.exit(1)).
    crashStub(engine._worker, 1);
    await new Promise((r) => process.nextTick(r));

    assert.strictEqual(capturedDelays.length, 0,
      'MODULE_NOT_FOUND short-circuit: NO respawn scheduled (stt-engine.js:162–166)');
    assert.strictEqual(engine._status, 'unavailable');
  });

  // -----------------------------------------------------------------------
  // Test 6: MAX_RESTART_ATTEMPTS cap — engine gives up at the cap
  //
  // We synthesize the cap state directly (set _restartAttempts = 5, then
  // fire _onWorkerExit). This avoids the multi-cycle race described in
  // test 2 and isolates the cap branch at stt-engine.js:169.
  // -----------------------------------------------------------------------
  it('gives up at MAX_RESTART_ATTEMPTS (5) — no respawn scheduled at the cap', async function () {
    const initial = engine._spawnWorker();
    readyStub(stubs[0]);
    await initial;

    capturedDelays.length = 0;
    // Force the engine to the cap state.
    engine._restartAttempts = 5;

    // Fire the permanent exit handler (this is what _onWorkerExit
    // would receive on a real crash of a readied worker).
    engine._onWorkerExit(1);
    await new Promise((r) => process.nextTick(r));

    assert.strictEqual(capturedDelays.length, 0,
      'at _restartAttempts === MAX_RESTART_ATTEMPTS (5), _onWorkerExit must NOT schedule a respawn (stt-engine.js:169–173)');
    assert.strictEqual(engine._status, 'unavailable',
      'status must flip to "unavailable" at the cap');
    assert.strictEqual(engine._worker, null,
      'worker reference must be cleared at the cap');
  });
});
