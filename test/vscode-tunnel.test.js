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
      });

      await manager.stop('test-session');
      assert.strictEqual(manager.tunnels.has('test-session'), false);
    });
  });

  describe('stopAll', function () {
    it('should stop all tunnels', async function () {
      manager.tunnels.set('s1', { status: 'running', process: null, stopping: false });
      manager.tunnels.set('s2', { status: 'running', process: null, stopping: false });

      await manager.stopAll();
      assert.strictEqual(manager.tunnels.size, 0);
    });
  });

  describe('event callback', function () {
    it('should emit events via onEvent callback', async function () {
      const events = [];
      manager.onEvent = (sessionId, event) => {
        events.push({ sessionId, ...event });
      };

      // Force not found to trigger error event path
      manager._command = null;
      manager._commandChecked = true;
      manager._available = false;

      await manager.start('test-session', '/tmp');

      // No event emitted for not_found — it returns immediately
      // But a status event was emitted for 'starting'
      // Check that at least the starting event fired
      const startingEvent = events.find(e => e.type === 'vscode_tunnel_status' && e.status === 'starting');
      assert(startingEvent, 'Expected a starting status event');
      assert.strictEqual(startingEvent.sessionId, 'test-session');
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
