'use strict';

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const ModelHost = require('../src/model-host');

const fixture = path.join(__dirname, 'fixtures', 'model-host-fixture.js');

describe('ModelHost lifecycle', function () {
  this.timeout(15000);

  it('defines every state x event transition', function () {
    for (const state of ModelHost.states) {
      for (const event of ModelHost.events) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(ModelHost.transitions[state], event),
          `missing transition for ${state} x ${event}`
        );
      }
    }
    assert.strictEqual(ModelHost.nextState('ready', 'unload'), 'unloading');
    assert.strictEqual(ModelHost.nextState('restarting', 'unload'), 'restarting');
    assert.strictEqual(ModelHost.nextState('failed', 'demand'), 'failed');
    assert.throws(() => ModelHost.nextState('bogus', 'demand'), /Invalid model-host transition/);
  });

  it('spawns on demand, exchanges a binary frame, and unloads only from ready', async function () {
    const host = new ModelHost({ name: 'fixture', entryPath: fixture, readinessTimeoutMs: 5000 });
    assert.strictEqual(await host.unload(), false, 'idle unload is a no-op');
    await host.demand();
    assert.strictEqual(host.getState(), 'ready');
    assert.strictEqual(host.getRuntimeInfo().addonLoaded, 'fixture-native');
    const result = await host.request({ dtype: 'utf8', payload: 'hello' });
    assert.strictEqual(result.text, 'hello');
    const pid = host.diagnostics().pid;
    assert.ok(pid > 0);
    assert.strictEqual(await host.unload(), true);
    assert.strictEqual(host.getState(), 'idle');
    assert.strictEqual(host.diagnostics().pid, null);
  });

  it('retires for memory pressure only while ready, inactive, and request-free', async function () {
    const host = new ModelHost({ name: 'fixture', entryPath: fixture, readinessTimeoutMs: 5000 });
    assert.strictEqual(await host.retireForMemoryPressure(), false);
    await host.demand();
    host.setActive(true);
    assert.strictEqual(await host.retireForMemoryPressure(), false);
    assert.strictEqual(host.getState(), 'ready');
    host.setActive(false);
    assert.strictEqual(await host.retireForMemoryPressure(), true);
    assert.strictEqual(host.getState(), 'idle');
  });

  it('does not allow caller metadata to override frame correlation fields', async function () {
    const host = new ModelHost({ name: 'fixture', entryPath: fixture, readinessTimeoutMs: 5000 });
    try {
      const result = await host.request({
        dtype: 'utf8',
        payload: 'metadata-safe',
        metadata: {
          type: 'forged',
          nonce: 0,
          seq: 0,
          dtype: 'float32',
          length: 999,
        },
      });
      assert.strictEqual(result.text, 'metadata-safe');
    } finally {
      await host.shutdown();
    }
  });

  it('does not inherit unrelated core credentials', async function () {
    const originalToken = process.env.AIORDIE_TOKEN;
    const originalCuda = process.env.CUDA_PATH;
    process.env.AIORDIE_TOKEN = 'must-not-cross-model-boundary';
    process.env.CUDA_PATH = '/runtime/cuda';
    const host = new ModelHost({ name: 'fixture', entryPath: fixture, readinessTimeoutMs: 5000 });
    try {
      await host.demand();
      assert.strictEqual(host.getRuntimeInfo().inheritedCredential, null);
      assert.strictEqual(host.getRuntimeInfo().backendConfig, '/runtime/cuda');
    } finally {
      if (originalToken === undefined) delete process.env.AIORDIE_TOKEN;
      else process.env.AIORDIE_TOKEN = originalToken;
      if (originalCuda === undefined) delete process.env.CUDA_PATH;
      else process.env.CUDA_PATH = originalCuda;
      await host.shutdown();
    }
  });

  it('keeps permanent failures permanent', async function () {
    const host = new ModelHost({
      name: 'fixture',
      entryPath: fixture,
      hostData: { failCode: 'MODULE_NOT_FOUND', failMessage: 'missing fixture addon' },
      readinessTimeoutMs: 5000,
    });
    await assert.rejects(host.demand(), /missing fixture addon/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(host.getState(), 'failed');
    const generation = host.diagnostics().generation;
    await assert.rejects(host.demand(), /missing fixture addon/);
    assert.strictEqual(host.diagnostics().generation, generation, 'cooloff must not retry permanent failures');
  });

  it('retires a timed-out host process instead of wedging its queue', async function () {
    const host = new ModelHost({
      name: 'fixture',
      entryPath: fixture,
      hostData: { requestDelayMs: 500 },
      requestTimeoutMs: 30,
      readinessTimeoutMs: 5000,
    });

    await assert.rejects(
      host.request({ dtype: 'utf8', payload: 'slow' }),
      /timed out/
    );
    const oldPid = host.diagnostics().pid;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.notStrictEqual(host.getState(), 'ready');
    if (oldPid) {
      assert.throws(() => process.kill(oldPid, 0), /ESRCH/);
    }
    await host.shutdown();
  });

  it('retires a host that misses its readiness deadline', async function () {
    const host = new ModelHost({
      name: 'fixture',
      entryPath: fixture,
      hostData: { loadDelayMs: 500 },
      readinessTimeoutMs: 30,
      maxCrashes: 1,
    });
    await assert.rejects(host.demand(), /readiness timed out/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(host.getState(), 'failed');
    assert.strictEqual(host.diagnostics().pid, null);
  });

  it('retires a host on duplicate control metadata', async function () {
    const host = new ModelHost({
      name: 'fixture',
      entryPath: fixture,
      readinessTimeoutMs: 5000,
      maxCrashes: 1,
    });
    await host.demand();
    const generation = host._generation;
    const duplicate = {
      type: 'request',
      nonce: generation.nonce,
      seq: 999,
      dtype: 'utf8',
      length: 1,
    };
    generation.child.send(duplicate);
    generation.child.send(duplicate);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(host.getState(), 'failed');
    assert.strictEqual(host.diagnostics().pid, null);
  });

  it('rejects reuse of a completed request id', async function () {
    const host = new ModelHost({
      name: 'fixture',
      entryPath: fixture,
      readinessTimeoutMs: 5000,
      maxCrashes: 1,
    });
    await host.request({ dtype: 'utf8', payload: 'completed' });
    const generation = host._generation;
    generation.child.send({
      type: 'request',
      nonce: generation.nonce,
      seq: 1,
      dtype: 'utf8',
      length: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(host.getState(), 'failed');
    assert.strictEqual(host.diagnostics().pid, null);
  });

  it('settles demand when shutdown interrupts model loading', async function () {
    const host = new ModelHost({
      name: 'fixture',
      entryPath: fixture,
      hostData: { loadDelayMs: 1000 },
      readinessTimeoutMs: 5000,
    });
    const demand = host.demand();
    const rejectedDemand = assert.rejects(demand, /shutting down/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.shutdown();
    await rejectedDemand;
    await assert.rejects(host.demand(), /shutting down/);
  });

  it('does not let a stale generation exit mutate a replacement', async function () {
    const host = new ModelHost({ name: 'fixture', entryPath: fixture, readinessTimeoutMs: 5000 });
    await host.demand();
    const first = host._generation;
    first.runtime.intentional = 'unload';
    await host.unload();
    await host.demand();
    const second = host._generation;
    assert.notStrictEqual(second, first);
    first.runtime.events.delete('exit');
    first.runtime.exitObserved = false;
    host._finalize(first, 'exit', { code: 0, signal: null });
    assert.strictEqual(host._generation, second);
    assert.strictEqual(host.getState(), 'ready');
    await host.shutdown();
  });

  it('settles a spawn error that produces close without exit', async function () {
    const child = new EventEmitter();
    child.pid = null;
    child.stdio = [null, null, null, null, new PassThrough(), new PassThrough()];
    child.send = () => {};
    child.kill = () => false;
    const host = new ModelHost({
      name: 'spawn-error',
      entryPath: fixture,
      maxCrashes: 1,
      createChild: () => {
        process.nextTick(() => {
          child.emit('error', new Error('spawn EACCES'));
          child.emit('close', -1, null);
        });
        return child;
      },
    });
    await assert.rejects(host.demand(), /spawn EACCES/);
    assert.strictEqual(host.getState(), 'failed');
    assert.strictEqual(host.diagnostics().pid, null);
  });

  it('bounds repeated warm extensions to one two-minute hold window', function () {
    const host = new ModelHost({ name: 'fixture', entryPath: fixture });
    const realNow = Date.now;
    let now = 100000;
    Date.now = () => now;
    try {
      host.demand = () => Promise.resolve();
      host.warm(30000);
      const ceiling = host._warmCeiling;
      now += 90000;
      host.warm(120000);
      assert.strictEqual(host._warmCeiling, ceiling);
      assert.strictEqual(host._warmUntil, ceiling);
    } finally {
      Date.now = realNow;
      if (host._warmTimer) clearTimeout(host._warmTimer);
    }
  });

  it('does not respawn after the rolling crash budget is exhausted', async function () {
    const host = new ModelHost({
      name: 'fixture',
      entryPath: fixture,
      hostData: { failCode: 'TRANSIENT_LOAD_FAILURE' },
      maxCrashes: 1,
      readinessTimeoutMs: 5000,
      cooloffMs: 60000,
    });
    await assert.rejects(host.demand(), /fixture load failed/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(host.getState(), 'failed');
    const generation = host.diagnostics().generation;
    await assert.rejects(host.demand(), /fixture load failed/);
    assert.strictEqual(host.diagnostics().generation, generation);
    await host.shutdown();
  });

  it('waits for unloading to finish before satisfying a new demand', async function () {
    const host = new ModelHost({
      name: 'fixture',
      entryPath: fixture,
      hostData: { shutdownDelayMs: 100 },
      readinessTimeoutMs: 5000,
    });
    await host.demand();
    const firstPid = host.diagnostics().pid;
    const states = [];
    host.on('state', (state) => states.push(state));
    const unloading = host.unload();
    assert.strictEqual(host.getState(), 'unloading');
    const demand = host.demand();
    await demand;
    assert.ok(states.includes('loading'), 'clean idle reload enters loading');
    assert.ok(!states.includes('restarting'), 'clean idle reload is not a crash reconnect');
    assert.strictEqual(host.getState(), 'ready');
    assert.notStrictEqual(host.diagnostics().pid, firstPid);
    assert.strictEqual(await unloading, true);
    await host.shutdown();
  });

  it('does not let a retiring generation become ready again', async function () {
    const host = new ModelHost({
      name: 'fixture',
      entryPath: fixture,
      hostData: { loadDelayMs: 100 },
      readinessTimeoutMs: 30,
      maxCrashes: 1,
    });
    const demand = host.demand();
    const generation = host._generation;
    await assert.rejects(demand, /readiness timed out/);
    host._onMessage(generation, { type: 'ready', addonLoaded: 'late-fixture' });
    assert.notStrictEqual(host.getState(), 'ready');
    assert.strictEqual(host.getRuntimeInfo(), null);
    await host.shutdown();
  });

  it('contains an immediate child exit without an unhandled liveness-pipe error', async function () {
    const host = new ModelHost({
      name: 'fixture',
      entryPath: fixture,
      hostData: { exitImmediately: true },
      maxCrashes: 1,
      readinessTimeoutMs: 5000,
    });
    await assert.rejects(host.demand(), /(model host|ECONNRESET|EPIPE)/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(host.getState(), 'failed');
    await host.shutdown();
  });
});
