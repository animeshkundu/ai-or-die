const assert = require('assert');
const { VSCodeTunnelManager } = require('../src/vscode-tunnel');

describe('VSCodeTunnelManager', function () {
  this.timeout(15000);

  let manager;

  beforeEach(function () {
    manager = new VSCodeTunnelManager({ dev: false });
  });

  afterEach(async function () {
    await manager.stopAll();
  });

  describe('constructor', function () {
    it('should initialize with empty tunnels map', function () {
      assert(manager.tunnels instanceof Map);
      assert.strictEqual(manager.tunnels.size, 0);
    });

    it('should have default max tunnels of 5', function () {
      assert.strictEqual(manager.maxTunnels, 5);
    });

    it('should respect MAX_VSCODE_TUNNELS env var', function () {
      const original = process.env.MAX_VSCODE_TUNNELS;
      try {
        process.env.MAX_VSCODE_TUNNELS = '3';
        const custom = new VSCodeTunnelManager();
        assert.strictEqual(custom.maxTunnels, 3);
      } finally {
        if (original === undefined) {
          delete process.env.MAX_VSCODE_TUNNELS;
        } else {
          process.env.MAX_VSCODE_TUNNELS = original;
        }
      }
    });
  });

  describe('isAvailable', function () {
    it('should return a boolean', async function () {
      const result = await manager.isAvailable();
      assert(typeof result === 'boolean');
    });

    it('isAvailableSync should return boolean after init', async function () {
      await manager._initPromise;
      const result = manager.isAvailableSync();
      assert(typeof result === 'boolean');
    });
  });

  describe('getStatus', function () {
    it('should return stopped status for unknown session', function () {
      const status = manager.getStatus('nonexistent');
      assert.strictEqual(status.status, 'stopped');
      assert.strictEqual(status.url, null);
    });
  });

  describe('start', function () {
    it('should return error when CLI not found', async function () {
      // Force command to null
      manager._command = null;
      manager._commandChecked = true;
      manager._available = false;

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'not_found');
      assert(typeof result.message === 'string');
      assert(result.message.includes('VS Code CLI not found'));
    });

    it('should reject duplicate tunnel for same session', async function () {
      // Simulate an active tunnel
      manager.tunnels.set('test-session', { status: 'running', url: 'https://vscode.dev/tunnel/test' });

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(result.success, false);
      assert(result.error.includes('already active'));
    });

    it('should enforce max tunnel limit', async function () {
      // Fill up to the limit
      manager._command = 'fake';
      manager._commandChecked = true;
      manager._available = true;
      manager.maxTunnels = 2;

      manager.tunnels.set('s1', { status: 'running' });
      manager.tunnels.set('s2', { status: 'running' });

      const result = await manager.start('s3', '/tmp');
      assert.strictEqual(result.success, false);
      assert(result.error.includes('Maximum tunnel limit'));
    });
  });

  describe('stop', function () {
    it('should return success for unknown session', async function () {
      const result = await manager.stop('nonexistent');
      assert.strictEqual(result.success, true);
    });

    it('should clean up tunnel state after stop', async function () {
      manager.tunnels.set('test-session', {
        status: 'running',
        process: null,
        stopping: false,
        _stabilityTimer: null,
        _restartDelayTimer: null,
        _restartDelayResolve: null,
      });

      await manager.stop('test-session');
      assert.strictEqual(manager.tunnels.has('test-session'), false);
    });
  });

  describe('stopAll', function () {
    it('should stop all tunnels', async function () {
      manager.tunnels.set('s1', { status: 'running', process: null, stopping: false, _stabilityTimer: null, _restartDelayTimer: null, _restartDelayResolve: null });
      manager.tunnels.set('s2', { status: 'running', process: null, stopping: false, _stabilityTimer: null, _restartDelayTimer: null, _restartDelayResolve: null });

      await manager.stopAll();
      assert.strictEqual(manager.tunnels.size, 0);
    });
  });

  describe('event callback', function () {
    it('should not emit events when CLI is not found', async function () {
      const events = [];
      manager.onEvent = (sessionId, event) => {
        events.push({ sessionId, ...event });
      };

      // Force not found — start() returns early before emitting any events
      manager._command = null;
      manager._commandChecked = true;
      manager._available = false;

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'not_found');

      // No events emitted because start() returns before creating tunnel state
      assert.strictEqual(events.length, 0, 'Expected no events when CLI not found');
    });

    it('should invoke onEvent with correct sessionId', function () {
      const events = [];
      manager.onEvent = (sessionId, event) => {
        events.push({ sessionId, ...event });
      };

      // Manually call _emitEvent to verify the callback works
      manager._emitEvent('test-session', 'vscode_tunnel_status', { status: 'starting' });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].sessionId, 'test-session');
      assert.strictEqual(events[0].type, 'vscode_tunnel_status');
      assert.strictEqual(events[0].status, 'starting');
    });
  });

  describe('authentication flow', function () {
    it('should call _login when not authenticated', async function () {
      manager._command = 'fake';
      manager._commandChecked = true;
      manager._available = true;

      let loginCalled = false;
      let spawnCalled = false;

      // Stub _checkAuth to return false (not authenticated)
      manager._checkAuth = async () => false;
      // Stub _login to return true (login succeeded)
      manager._login = async () => { loginCalled = true; return true; };
      // Stub _spawn to no-op
      manager._spawn = async () => { spawnCalled = true; };

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(loginCalled, true, '_login should have been called');
      assert.strictEqual(spawnCalled, true, '_spawn should have been called after login');
      assert.strictEqual(result.success, true);
    });

    it('should return error when login fails', async function () {
      manager._command = 'fake';
      manager._commandChecked = true;
      manager._available = true;

      const events = [];
      manager.onEvent = (sessionId, event) => { events.push(event); };

      // Stub _checkAuth to return false (not authenticated)
      manager._checkAuth = async () => false;
      // Stub _login to return false (login failed)
      manager._login = async () => false;

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(result.success, false);
      assert(result.error.includes('Authentication failed'));
      // Should have emitted an error event
      const errorEvent = events.find(e => e.type === 'vscode_tunnel_error');
      assert(errorEvent, 'Should emit vscode_tunnel_error event');
    });

    it('should skip _login when already authenticated', async function () {
      manager._command = 'fake';
      manager._commandChecked = true;
      manager._available = true;

      let loginCalled = false;

      // Stub _checkAuth to return true (already authenticated)
      manager._checkAuth = async () => true;
      manager._login = async () => { loginCalled = true; return true; };
      manager._spawn = async () => {};

      await manager.start('test-session', '/tmp');
      assert.strictEqual(loginCalled, false, '_login should NOT have been called');
    });
  });

  describe('clearAvailabilityCache', function () {
    it('should reset state and re-run discovery', async function () {
      // Set initial state
      manager._command = '/usr/bin/code';
      manager._commandChecked = true;
      manager._available = true;

      manager.clearAvailabilityCache();

      // Should have reset state
      assert.strictEqual(manager._command, null);
      assert.strictEqual(manager._commandChecked, false);
      assert.strictEqual(manager._available, false);

      // Wait for re-discovery to complete
      await manager._initPromise;
      assert.strictEqual(manager._commandChecked, true);
    });
  });

  describe('_installInstructions', function () {
    it('should return platform-specific instructions', function () {
      const instructions = manager._installInstructions();
      assert(typeof instructions === 'string');
      assert(instructions.includes('code.visualstudio.com'));
    });
  });
});
