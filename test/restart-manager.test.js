'use strict';

const assert = require('assert');
const RestartManager = require('../src/restart-manager');

describe('RestartManager', function () {

  function createMockServer(overrides = {}) {
    return {
      isShuttingDown: false,
      supervised: false,
      autoSaveInterval: setInterval(() => {}, 999999),
      sessionEvictionInterval: setInterval(() => {}, 999999),
      imageSweepInterval: setInterval(() => {}, 999999),
      claudeSessions: new Map(),
      claudeBridge: { cleanup: async () => {} },
      codexBridge: { cleanup: async () => {} },
      copilotBridge: { cleanup: async () => {} },
      geminiBridge: { cleanup: async () => {} },
      terminalBridge: { cleanup: async () => {} },
      wss: { close: () => {} },
      server: { close: (cb) => cb && cb() },
      webSocketConnections: new Map(),
      broadcastToAll: () => {},
      sendToWebSocket: () => {},
      saveSessionsToDisk: async () => {},
      _flushAndClearOutputTimer: () => {},
      ...overrides
    };
  }

  afterEach(function () {
    // Restore process.exit if stubbed
    if (this._origExit) {
      process.exit = this._origExit;
      delete this._origExit;
    }
  });

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
  });

  describe('initiateRestart', function () {
    it('should skip if already shutting down', async function () {
      let saveCalled = false;
      const server = createMockServer({
        isShuttingDown: true,
        saveSessionsToDisk: async () => { saveCalled = true; }
      });
      const rm = new RestartManager(server);
      await rm.initiateRestart();
      assert.strictEqual(saveCalled, false, 'should not save when already shutting down');
    });

    it('should set isShuttingDown to true', async function () {
      const server = createMockServer();
      const rm = new RestartManager(server);
      // Stub process.exit to prevent actual exit
      this._origExit = process.exit;
      process.exit = () => {};
      await rm.initiateRestart();
      assert.strictEqual(server.isShuttingDown, true);
    });

    it('should clear all intervals', async function () {
      const server = createMockServer();
      const rm = new RestartManager(server);
      this._origExit = process.exit;
      process.exit = () => {};
      await rm.initiateRestart();
      assert.strictEqual(server.autoSaveInterval, null);
      assert.strictEqual(server.sessionEvictionInterval, null);
      assert.strictEqual(server.imageSweepInterval, null);
    });

    it('should broadcast server_restarting', async function () {
      let broadcastedData = null;
      const server = createMockServer({
        broadcastToAll: (data) => { broadcastedData = data; }
      });
      const rm = new RestartManager(server);
      this._origExit = process.exit;
      process.exit = () => {};
      await rm.initiateRestart('user_requested');
      assert.ok(broadcastedData);
      assert.strictEqual(broadcastedData.type, 'server_restarting');
      assert.strictEqual(broadcastedData.reason, 'user_requested');
    });

    it('should call saveSessionsToDisk', async function () {
      let saveCalled = false;
      const server = createMockServer({
        saveSessionsToDisk: async () => { saveCalled = true; }
      });
      const rm = new RestartManager(server);
      this._origExit = process.exit;
      process.exit = () => {};
      await rm.initiateRestart();
      assert.strictEqual(saveCalled, true);
    });

    it('should continue if save fails', async function () {
      let cleanupCalled = false;
      const server = createMockServer({
        saveSessionsToDisk: async () => { throw new Error('disk full'); },
        claudeBridge: { cleanup: async () => { cleanupCalled = true; } }
      });
      const rm = new RestartManager(server);
      this._origExit = process.exit;
      process.exit = () => {};
      await rm.initiateRestart();
      assert.strictEqual(cleanupCalled, true, 'should continue to bridge cleanup even after save failure');
    });

    it('should use Promise.allSettled for bridge cleanup', async function () {
      let cleanupCount = 0;
      const makeBridge = (shouldThrow) => ({
        cleanup: async () => {
          cleanupCount++;
          if (shouldThrow) throw new Error('bridge error');
        }
      });
      const server = createMockServer({
        claudeBridge: makeBridge(true),  // This one throws
        codexBridge: makeBridge(false),
        copilotBridge: makeBridge(false),
        geminiBridge: makeBridge(false),
        terminalBridge: makeBridge(false)
      });
      const rm = new RestartManager(server);
      this._origExit = process.exit;
      process.exit = () => {};
      await rm.initiateRestart();
      assert.strictEqual(cleanupCount, 5, 'all 5 bridges should attempt cleanup even if one throws');
    });

    it('should flush output timers before saving', async function () {
      const flushedSessions = [];
      const server = createMockServer({
        claudeSessions: new Map([['s1', { id: 's1' }], ['s2', { id: 's2' }]]),
        _flushAndClearOutputTimer: (session, id) => { flushedSessions.push(id); }
      });
      const rm = new RestartManager(server);
      this._origExit = process.exit;
      process.exit = () => {};
      await rm.initiateRestart();
      assert.deepStrictEqual(flushedSessions.sort(), ['s1', 's2']);
    });
  });
});
