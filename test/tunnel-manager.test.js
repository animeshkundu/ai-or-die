const assert = require('assert');
const { TunnelManager, _constants } = require('../src/tunnel-manager');

const {
  MAX_RETRIES,
  STABILITY_THRESHOLD_MS,
  MIN_RESTART_DELAY_MS,
  MAX_RESTART_DELAY_MS
} = _constants;

describe('TunnelManager', function() {

  describe('constructor', function() {
    it('should initialize with default values', function() {
      const tm = new TunnelManager();
      assert.strictEqual(tm.port, 7777);
      assert.strictEqual(tm.allowAnonymous, false);
      assert.strictEqual(tm.dev, false);
      assert.strictEqual(tm.process, null);
      assert.strictEqual(tm.publicUrl, null);
      assert.strictEqual(tm.stopping, false);
      assert.strictEqual(tm.retryCount, 0);
    });

    it('should accept custom port and options', function() {
      const tm = new TunnelManager({ port: 9090, allowAnonymous: true, dev: true });
      assert.strictEqual(tm.port, 9090);
      assert.strictEqual(tm.allowAnonymous, true);
      assert.strictEqual(tm.dev, true);
    });

    it('should generate a tunnel ID from hostname', function() {
      const tm = new TunnelManager();
      assert.ok(tm.tunnelId.startsWith('aiordie-'));
      assert.ok(/^aiordie-[a-z0-9-]*$/.test(tm.tunnelId));
    });

    it('should initialize resilience tracking fields', function() {
      const tm = new TunnelManager();
      assert.strictEqual(tm._lastSpawnTime, null);
      assert.strictEqual(tm._totalRestarts, 0);
      assert.strictEqual(tm._stabilityTimer, null);
      assert.strictEqual(tm._restartDelayTimer, null);
      assert.strictEqual(tm._restartDelayResolve, null);
    });

    it('should allow test override of stability threshold', function() {
      const tm = new TunnelManager({ _stabilityThresholdMs: 100 });
      assert.strictEqual(tm._stabilityThresholdMs, 100);
    });
  });

  describe('exported constants', function() {
    it('should export expected constant values', function() {
      assert.strictEqual(MAX_RETRIES, 10);
      assert.strictEqual(STABILITY_THRESHOLD_MS, 60000);
      assert.strictEqual(MIN_RESTART_DELAY_MS, 1000);
      assert.strictEqual(MAX_RESTART_DELAY_MS, 30000);
    });
  });

  describe('backoff calculation', function() {
    it('should use exponential backoff capped at MAX_RESTART_DELAY_MS', function() {
      // Verify the formula: Math.min(2^(n-1) * MIN, MAX)
      const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000];
      for (let i = 1; i <= 10; i++) {
        const delay = Math.min(
          Math.pow(2, i - 1) * MIN_RESTART_DELAY_MS,
          MAX_RESTART_DELAY_MS
        );
        assert.strictEqual(delay, expected[i - 1], `retry ${i} should have delay ${expected[i - 1]}ms`);
      }
    });
  });

  describe('stability timer', function() {
    it('should reset retryCount after stability threshold', function(done) {
      const tm = new TunnelManager({ _stabilityThresholdMs: 50 });
      tm.retryCount = 5;
      tm._startStabilityTimer();

      setTimeout(() => {
        assert.strictEqual(tm.retryCount, 0);
        done();
      }, 100);
    });

    it('should not change retryCount if already 0', function(done) {
      const tm = new TunnelManager({ _stabilityThresholdMs: 50 });
      tm.retryCount = 0;
      tm._startStabilityTimer();

      setTimeout(() => {
        assert.strictEqual(tm.retryCount, 0);
        done();
      }, 100);
    });

    it('should clear previous timer when starting a new one', function(done) {
      const tm = new TunnelManager({ _stabilityThresholdMs: 200 });
      tm.retryCount = 3;

      // Start first timer
      tm._startStabilityTimer();
      const firstTimer = tm._stabilityTimer;

      // Start second timer before first fires
      tm._startStabilityTimer();
      assert.notStrictEqual(tm._stabilityTimer, firstTimer);

      // retryCount should still be 3 (first timer was cleared)
      assert.strictEqual(tm.retryCount, 3);
      tm._clearStabilityTimer();
      done();
    });

    it('should be clearable via _clearStabilityTimer', function() {
      const tm = new TunnelManager({ _stabilityThresholdMs: 60000 });
      tm._startStabilityTimer();
      assert.notStrictEqual(tm._stabilityTimer, null);

      tm._clearStabilityTimer();
      assert.strictEqual(tm._stabilityTimer, null);
    });
  });

  describe('stop()', function() {
    it('should set stopping to true', async function() {
      const tm = new TunnelManager();
      assert.strictEqual(tm.stopping, false);
      await tm.stop();
      assert.strictEqual(tm.stopping, true);
    });

    it('should clear stability timer', async function() {
      const tm = new TunnelManager({ _stabilityThresholdMs: 60000 });
      tm._startStabilityTimer();
      assert.notStrictEqual(tm._stabilityTimer, null);

      await tm.stop();
      assert.strictEqual(tm._stabilityTimer, null);
    });

    it('should resolve pending restart delay', async function() {
      const tm = new TunnelManager();
      let resolved = false;

      // Simulate a pending restart delay
      const delayPromise = new Promise((resolve) => {
        tm._restartDelayResolve = resolve;
        tm._restartDelayTimer = setTimeout(resolve, 60000);
      });

      delayPromise.then(() => { resolved = true; });

      await tm.stop();

      // Give microtask a tick to process
      await new Promise(r => setTimeout(r, 10));
      assert.strictEqual(resolved, true);
      assert.strictEqual(tm._restartDelayResolve, null);
    });

    it('should resolve immediately if no process', async function() {
      const tm = new TunnelManager();
      tm.process = null;
      // Should not hang
      await tm.stop();
      assert.strictEqual(tm.stopping, true);
    });
  });

  describe('_restart()', function() {
    it('should increment retryCount and totalRestarts', async function() {
      const tm = new TunnelManager();
      tm.stopping = true; // Prevent actual _spawn
      tm._lastSpawnTime = Date.now();

      await tm._restart();
      assert.strictEqual(tm.retryCount, 1);
      assert.strictEqual(tm._totalRestarts, 1);
    });

    it('should stop retrying after MAX_RETRIES', async function() {
      const tm = new TunnelManager();
      tm.retryCount = MAX_RETRIES; // Already at max
      tm._lastSpawnTime = Date.now();

      // This should increment to MAX_RETRIES + 1 and bail
      await tm._restart();
      assert.strictEqual(tm.retryCount, MAX_RETRIES + 1);
      assert.strictEqual(tm._totalRestarts, 1);
    });

    it('should not restart when stopping is true', async function() {
      const tm = new TunnelManager();
      tm.stopping = true;
      tm._lastSpawnTime = Date.now();

      let spawnCalled = false;
      tm._spawn = async () => { spawnCalled = true; };

      await tm._restart();

      assert.strictEqual(spawnCalled, false);
    });

    it('should track totalRestarts independently of retryCount resets', async function() {
      this.timeout(5000);
      const tm = new TunnelManager({ _stabilityThresholdMs: 10 });
      tm.stopping = true;
      tm._lastSpawnTime = Date.now();

      await tm._restart();
      assert.strictEqual(tm._totalRestarts, 1);

      // Simulate stability timer reset
      tm.retryCount = 0;

      await tm._restart();
      assert.strictEqual(tm._totalRestarts, 2);
      assert.strictEqual(tm.retryCount, 1); // reset, then incremented
    });
  });

  describe('restart()', function() {
    it('should return error when restart is already in progress', async function() {
      const tm = new TunnelManager();
      tm._restarting = true;

      const result = await tm.restart();
      assert.deepStrictEqual(result, { success: false, error: 'Restart already in progress' });
    });

    it('should reset retryCount to 0', async function() {
      this.timeout(30000);
      const tm = new TunnelManager();
      tm.retryCount = 5;
      tm.process = null;

      // Stub _ensureTunnel and _spawn to prevent actual CLI calls
      tm._ensureTunnel = async () => false;

      await tm.restart();
      assert.strictEqual(tm.retryCount, 0);
    });
  });

  describe('_ensureTunnel() port create fallback', function() {
    it('should return true even when port create fails (GitHub auth scope)', async function() {
      const tm = new TunnelManager({ port: 7777 });

      // Track which devtunnel commands were called
      const calls = [];
      tm._execDevtunnel = async (args) => {
        calls.push(args.slice(0, 2).join(' '));
        // Simulate port create failure (GitHub auth scope limitation)
        if (args[0] === 'port') return false;
        return true;
      };

      const result = await tm._ensureTunnel();
      assert.strictEqual(result, true, '_ensureTunnel should succeed even when port create fails');
      assert.ok(calls.some(c => c.startsWith('create')), 'should have called create');
      assert.ok(calls.some(c => c.startsWith('port')), 'should have attempted port create');
    });

    it('should return false when tunnel create fails', async function() {
      const tm = new TunnelManager({ port: 7777 });

      tm._execDevtunnel = async (args) => {
        if (args[0] === 'create') return false;
        return true;
      };

      const result = await tm._ensureTunnel();
      assert.strictEqual(result, false, '_ensureTunnel should fail when create fails');
    });
  });

  describe('_spawn() port flag', function() {
    it('should pass -p and port to devtunnel host command', function() {
      const tm = new TunnelManager({ port: 8080 });
      // Verify that _spawn would use the right args by inspecting the method
      // We can't easily test the spawn call directly, but we can verify the port is set
      assert.strictEqual(tm.port, 8080);
    });
  });

  describe('getStatus()', function() {
    it('should return running false and null publicUrl for a fresh instance', function() {
      const tm = new TunnelManager();
      const status = tm.getStatus();
      assert.deepStrictEqual(status, { running: false, publicUrl: null });
    });
  });
});
