'use strict';

const assert = require('assert');
const RestartManager = require('../src/restart-manager');

describe('RestartManager', function () {

  function createMockServer(overrides = {}) {
    return {
      isShuttingDown: false,
      supervised: false,
      webSocketConnections: new Map(),
      broadcastToAll: () => {},
      handleShutdown: async () => {},
      ...overrides
    };
  }

  describe('constructor', function () {
    it('should use default thresholds when env vars not set', function () {
      const rm = new RestartManager(createMockServer());
      assert.strictEqual(rm.gcThresholdBytes, 1024 * 1024 * 1024); // 1 GB
      assert.strictEqual(rm.warnThresholdBytes, 2048 * 1024 * 1024); // 2 GB
    });

    it('should read thresholds from env vars', function () {
      process.env.MEMORY_GC_THRESHOLD_MB = '256';
      process.env.MEMORY_WARN_THRESHOLD_MB = '512';
      try {
        const rm = new RestartManager(createMockServer());
        assert.strictEqual(rm.gcThresholdBytes, 256 * 1024 * 1024);
        assert.strictEqual(rm.warnThresholdBytes, 512 * 1024 * 1024);
      } finally {
        delete process.env.MEMORY_GC_THRESHOLD_MB;
        delete process.env.MEMORY_WARN_THRESHOLD_MB;
      }
    });
  });

  describe('startMemoryMonitoring', function () {
    it('should create an interval', function () {
      const rm = new RestartManager(createMockServer());
      rm.startMemoryMonitoring();
      assert.ok(rm._monitorInterval, 'monitor interval should be set');
      rm.stopMemoryMonitoring();
    });

    it('should clear interval on stop', function () {
      const rm = new RestartManager(createMockServer());
      rm.startMemoryMonitoring();
      rm.stopMemoryMonitoring();
      assert.strictEqual(rm._monitorInterval, null);
    });
  });

  describe('_checkMemory', function () {
    it('should broadcast memory_warning when RSS exceeds warn threshold', function () {
      let broadcastedData = null;
      const server = createMockServer({
        supervised: true,
        broadcastToAll: (data) => { broadcastedData = data; }
      });
      const rm = new RestartManager(server);
      rm.warnThresholdBytes = 1; // Set very low to trigger

      rm._checkMemory();

      assert.ok(broadcastedData, 'should have broadcast');
      assert.strictEqual(broadcastedData.type, 'memory_warning');
      assert.strictEqual(broadcastedData.supervised, true);
      assert.ok(broadcastedData.rss);
      assert.ok(broadcastedData.heapUsed);
    });

    it('should throttle notifications to once per 30 minutes', function () {
      let broadcastCount = 0;
      const server = createMockServer({
        broadcastToAll: () => { broadcastCount++; }
      });
      const rm = new RestartManager(server);
      rm.warnThresholdBytes = 1; // Always triggers

      rm._checkMemory();
      rm._checkMemory();
      rm._checkMemory();

      assert.strictEqual(broadcastCount, 1, 'should only broadcast once within throttle window');
    });

    it('should schedule GC via setImmediate when global.gc is available', function (done) {
      const rm = new RestartManager(createMockServer());
      rm.gcThresholdBytes = 1; // Always triggers
      // Stub global.gc so the GC branch is reachable without --expose-gc
      const origGc = global.gc;
      global.gc = () => {};
      let gcScheduled = false;
      const origSetImmediate = global.setImmediate;
      global.setImmediate = (fn) => {
        gcScheduled = true;
        global.setImmediate = origSetImmediate;
        global.gc = origGc;
        // Execute the scheduled GC callback, then verify and complete
        origSetImmediate(() => {
          fn();
          assert.ok(gcScheduled, 'GC should have been scheduled via setImmediate');
          done();
        });
      };
      try {
        rm._checkMemory();
      } catch (e) {
        global.setImmediate = origSetImmediate;
        global.gc = origGc;
        done(e);
      }
    });
  });

  describe('_runGc', function () {
    it('should log reclaimed MB after GC', function () {
      const rm = new RestartManager(createMockServer());
      const messages = [];
      const origLog = console.log;
      console.log = (...args) => messages.push(args.join(' '));
      try {
        rm._runGc();
      } finally {
        console.log = origLog;
      }
      assert.ok(messages.some(m => m.includes('GC complete')), 'should log GC completion');
    });

    it('should not throw when global.gc is undefined', function () {
      const rm = new RestartManager(createMockServer());
      const origGc = global.gc;
      delete global.gc;
      try {
        assert.doesNotThrow(() => rm._runGc());
      } finally {
        if (origGc !== undefined) global.gc = origGc;
      }
    });
  });

  describe('initiateRestart', function () {
    it('should skip if already shutting down', async function () {
      let shutdownCalled = false;
      const server = createMockServer({
        isShuttingDown: true,
        handleShutdown: async () => { shutdownCalled = true; }
      });
      const rm = new RestartManager(server);
      await rm.initiateRestart();
      assert.strictEqual(shutdownCalled, false, 'should not call handleShutdown when already shutting down');
    });

    it('should broadcast server_restarting before delegating to handleShutdown', async function () {
      const callOrder = [];
      const server = createMockServer({
        broadcastToAll: (data) => {
          if (data.type === 'server_restarting') callOrder.push('broadcast');
        },
        handleShutdown: async () => { callOrder.push('shutdown'); }
      });
      const rm = new RestartManager(server);
      await rm.initiateRestart('user_requested');
      assert.strictEqual(callOrder[0], 'broadcast', 'should broadcast before shutdown');
      assert.strictEqual(callOrder[1], 'shutdown', 'should call handleShutdown after broadcast');
    });

    it('should pass exit code 75 to handleShutdown', async function () {
      let receivedExitCode = null;
      const server = createMockServer({
        handleShutdown: async (code) => { receivedExitCode = code; }
      });
      const rm = new RestartManager(server);
      await rm.initiateRestart();
      assert.strictEqual(receivedExitCode, 75);
    });

    it('should include reason in server_restarting broadcast', async function () {
      let broadcastedData = null;
      const server = createMockServer({
        broadcastToAll: (data) => { broadcastedData = data; },
        handleShutdown: async () => {}
      });
      const rm = new RestartManager(server);
      await rm.initiateRestart('user_requested');
      assert.ok(broadcastedData);
      assert.strictEqual(broadcastedData.type, 'server_restarting');
      assert.strictEqual(broadcastedData.reason, 'user_requested');
    });

    it('should rate-limit restarts to once per 5 minutes', async function () {
      const server = createMockServer({
        handleShutdown: async () => {}
      });
      const rm = new RestartManager(server);

      // First restart should succeed
      const result1 = await rm.initiateRestart();
      assert.strictEqual(result1, 'restarting');

      // Reset isShuttingDown to simulate supervisor having respawned
      server.isShuttingDown = false;

      // Second restart within 5 minutes should be rate-limited
      const result2 = await rm.initiateRestart();
      assert.strictEqual(result2, 'rate_limited');
    });

    it('should return already_shutting_down when server is shutting down', async function () {
      const server = createMockServer({ isShuttingDown: true });
      const rm = new RestartManager(server);
      const result = await rm.initiateRestart();
      assert.strictEqual(result, 'already_shutting_down');
    });
  });
});
