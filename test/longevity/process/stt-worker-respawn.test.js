'use strict';

const assert = require('assert');
const path = require('path');
const ModelHost = require('../../../src/model-host');

const fixture = path.join(__dirname, '..', '..', 'fixtures', 'model-host-fixture.js');

describe('PROC-02: STT model-host respawn discipline', function () {
  this.timeout(15000);

  it('preserves the established exponential backoff sequence', function () {
    assert.deepStrictEqual(
      [0, 1, 2, 3, 4].map((attempt) => ModelHost.restartDelayFor(attempt)),
      [1000, 2000, 4000, 8000, 15000]
    );
  });

  it('does not erase the rolling crash ring after a successful ready state', async function () {
    const host = new ModelHost({ name: 'stt-test', entryPath: fixture, readinessTimeoutMs: 5000 });
    host._recordCrash();
    await host.demand();
    assert.strictEqual(host._crashTimes.length, 1);
    assert.strictEqual(host._consecutiveFailures, 0, 'ready resets only consecutive failures');
    await host.shutdown();
  });

  it('shutdown cannot schedule a respawn', async function () {
    const host = new ModelHost({ name: 'stt-test', entryPath: fixture, readinessTimeoutMs: 5000 });
    await host.demand();
    const generationCount = host._generationCounter;
    await host.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.strictEqual(host.diagnostics().pid, null);
    assert.strictEqual(host._generationCounter, generationCount, 'shutdown did not spawn a replacement generation');
  });

  it('MODULE_NOT_FOUND remains permanent and schedules no retry', async function () {
    const host = new ModelHost({
      name: 'stt-test',
      entryPath: fixture,
      hostData: { failCode: 'MODULE_NOT_FOUND', failMessage: 'missing sherpa-onnx-node' },
      readinessTimeoutMs: 5000,
    });
    await assert.rejects(host.demand(), /missing sherpa/);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.strictEqual(host.getState(), 'failed');
    assert.strictEqual(host.diagnostics().consecutiveFailures, 1);
  });

  it('keeps child listener counts bounded for each generation', async function () {
    const host = new ModelHost({ name: 'stt-test', entryPath: fixture, readinessTimeoutMs: 5000 });
    await host.demand();
    const child = host._generation.child;
    assert.strictEqual(child.listenerCount('exit'), 1);
    assert.strictEqual(child.listenerCount('disconnect'), 1);
    assert.strictEqual(child.listenerCount('error'), 1);
    await host.shutdown();
  });
});
