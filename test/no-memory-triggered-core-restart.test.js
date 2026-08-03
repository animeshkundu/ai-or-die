'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RestartManager = require('../src/restart-manager');

describe('memory monitoring never restarts the core', function () {
  it('only collects, reclaims, and warns under pressure', function () {
    let shutdownCalls = 0;
    let retireCalls = 0;
    const server = {
      supervised: true,
      broadcastToAll() {},
      handleShutdown() { shutdownCalls++; },
      retireModelHostsForMemoryPressure() { retireCalls++; },
    };
    const manager = new RestartManager(server);
    manager.gcThresholdBytes = 0;
    manager.warnThresholdBytes = 0;
    manager._freeMemoryBytes = () => 0;
    const originalGc = global.gc;
    global.gc = () => {};
    try {
      manager._checkMemory();
      assert.strictEqual(shutdownCalls, 0, 'memory pressure must never reach core shutdown');
      assert.strictEqual(retireCalls, 1, 'memory pressure retires model hosts');
    } finally {
      if (originalGc) global.gc = originalGc;
      else delete global.gc;
    }
  });

  it('model-host lifecycle code has no route to core restart or shutdown', function () {
    for (const file of [
      'model-host.js',
      'model-host-runtime.js',
      'stt-engine.js',
      'sticky-note-engine.js',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
      assert.ok(!source.includes('initiateRestart('), `${file} must not restart the core`);
      assert.ok(!source.includes('handleShutdown('), `${file} must not shut down the core`);
    }
  });
});
