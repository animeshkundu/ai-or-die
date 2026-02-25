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

  // ── Constructor ────────────────────────────────────────────

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

    it('should discover both code and devtunnel CLIs during init', async function () {
      await manager._initPromise;
      assert.strictEqual(manager._commandChecked, true);
      assert.strictEqual(manager._devtunnelChecked, true);
    });

    it('should initialize _reservedPorts as empty Set', function () {
      assert(manager._reservedPorts instanceof Set);
      assert.strictEqual(manager._reservedPorts.size, 0);
    });
  });

  // ── isAvailable ────────────────────────────────────────────

  describe('isAvailable', function () {
    it('should return a boolean', async function () {
      const result = await manager.isAvailable();
      assert(typeof result === 'boolean');
    });

    it('should return true only when both code AND devtunnel are available', async function () {
      await manager._initPromise;

      // Both available
      manager._available = true;
      manager._devtunnelAvailable = true;
      assert.strictEqual(await manager.isAvailable(), true);

      // Only code available
      manager._available = true;
      manager._devtunnelAvailable = false;
      assert.strictEqual(await manager.isAvailable(), false);

      // Only devtunnel available
      manager._available = false;
      manager._devtunnelAvailable = true;
      assert.strictEqual(await manager.isAvailable(), false);

      // Neither available
      manager._available = false;
      manager._devtunnelAvailable = false;
      assert.strictEqual(await manager.isAvailable(), false);
    });
  });

  // ── isAvailableSync ────────────────────────────────────────

  describe('isAvailableSync', function () {
    it('should return boolean after init completes', async function () {
      await manager._initPromise;
      const result = manager.isAvailableSync();
      assert(typeof result === 'boolean');
    });

    it('should return true only when both CLIs are cached as available', async function () {
      await manager._initPromise;

      manager._available = true;
      manager._devtunnelAvailable = true;
      assert.strictEqual(manager.isAvailableSync(), true);

      manager._available = true;
      manager._devtunnelAvailable = false;
      assert.strictEqual(manager.isAvailableSync(), false);

      manager._available = false;
      manager._devtunnelAvailable = true;
      assert.strictEqual(manager.isAvailableSync(), false);
    });
  });

  // ── Port Allocation ────────────────────────────────────────

  describe('_allocatePort', function () {
    it('should allocate from base port 9100', function () {
      const port = manager._allocatePort();
      assert.strictEqual(port, 9100);
    });

    it('should allocate sequential ports skipping reserved', function () {
      manager._reservedPorts.add(9100);
      assert.strictEqual(manager._allocatePort(), 9101);
    });

    it('should skip multiple reserved ports', function () {
      manager._reservedPorts.add(9100);
      manager._reservedPorts.add(9101);
      manager._reservedPorts.add(9102);
      assert.strictEqual(manager._allocatePort(), 9103);
    });

    it('should return null when all ports are exhausted', function () {
      // Reserve all 100 ports in the range (9100-9199)
      for (let p = 9100; p < 9200; p++) {
        manager._reservedPorts.add(p);
      }
      assert.strictEqual(manager._allocatePort(), null);
    });
  });

  // ── Token Generation ───────────────────────────────────────

  describe('_generateToken', function () {
    it('should produce a 64-char hex string', function () {
      const token = manager._generateToken();
      assert.strictEqual(typeof token, 'string');
      assert.strictEqual(token.length, 64);
      assert(/^[0-9a-f]{64}$/.test(token), 'Token should be lowercase hex');
    });

    it('should produce unique tokens on successive calls', function () {
      const a = manager._generateToken();
      const b = manager._generateToken();
      assert.notStrictEqual(a, b);
    });
  });

  // ── start ──────────────────────────────────────────────────

  describe('start', function () {
    it('should return error when VS Code CLI not found', async function () {
      manager._command = null;
      manager._commandChecked = true;
      manager._available = false;
      manager._devtunnelCommand = 'fake-devtunnel';
      manager._devtunnelChecked = true;
      manager._devtunnelAvailable = true;

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'not_found');
      assert(typeof result.message === 'string');
      assert(result.message.includes('VS Code CLI not found'));
    });

    it('should return error when devtunnel CLI not found', async function () {
      manager._command = 'fake-code';
      manager._commandChecked = true;
      manager._available = true;
      manager._devtunnelCommand = null;
      manager._devtunnelChecked = true;
      manager._devtunnelAvailable = false;

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'not_found');
      assert(typeof result.message === 'string');
      assert(result.message.includes('devtunnel'));
    });

    it('should reject duplicate tunnel for same session', async function () {
      manager.tunnels.set('test-session', {
        status: 'running',
        serverProcess: null,
        tunnelProcess: null,
        localUrl: 'http://localhost:9100/?tkn=abc',
        publicUrl: 'https://test.devtunnels.ms/?tkn=abc',
      });

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(result.success, false);
      assert(result.error.includes('already active'));
    });

    it('should enforce max tunnel limit', async function () {
      manager._command = 'fake-code';
      manager._commandChecked = true;
      manager._available = true;
      manager._devtunnelCommand = 'fake-devtunnel';
      manager._devtunnelChecked = true;
      manager._devtunnelAvailable = true;
      manager.maxTunnels = 2;

      manager.tunnels.set('s1', { status: 'running' });
      manager.tunnels.set('s2', { status: 'running' });

      const result = await manager.start('s3', '/tmp');
      assert.strictEqual(result.success, false);
      assert(result.error.includes('Maximum tunnel limit'));
    });

    it('should count degraded tunnels toward the active limit', async function () {
      manager._command = 'fake-code';
      manager._commandChecked = true;
      manager._available = true;
      manager._devtunnelCommand = 'fake-devtunnel';
      manager._devtunnelChecked = true;
      manager._devtunnelAvailable = true;
      manager.maxTunnels = 2;

      manager.tunnels.set('s1', { status: 'running' });
      manager.tunnels.set('s2', { status: 'degraded' });

      const result = await manager.start('s3', '/tmp');
      assert.strictEqual(result.success, false);
      assert(result.error.includes('Maximum tunnel limit'));
    });

    it('should call _loginDevtunnel when not authenticated', async function () {
      manager._command = 'fake-code';
      manager._commandChecked = true;
      manager._available = true;
      manager._devtunnelCommand = 'fake-devtunnel';
      manager._devtunnelChecked = true;
      manager._devtunnelAvailable = true;

      let authChecked = false;
      let loginCalled = false;
      let serverSpawned = false;

      manager._checkDevtunnelAuth = async () => { authChecked = true; return false; };
      manager._loginDevtunnel = async () => { loginCalled = true; return true; };
      manager._spawnServer = async () => { serverSpawned = true; return true; };
      manager._waitForPort = async () => true;
      manager._ensureDevtunnel = async () => true;
      manager._spawnTunnel = async () => {};

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(authChecked, true, '_checkDevtunnelAuth should have been called');
      assert.strictEqual(loginCalled, true, '_loginDevtunnel should have been called');
      assert.strictEqual(serverSpawned, true, '_spawnServer should have been called after login');
      assert.strictEqual(result.success, true);
    });

    it('should return error when devtunnel login fails', async function () {
      manager._command = 'fake-code';
      manager._commandChecked = true;
      manager._available = true;
      manager._devtunnelCommand = 'fake-devtunnel';
      manager._devtunnelChecked = true;
      manager._devtunnelAvailable = true;

      const events = [];
      manager.onEvent = (sessionId, event) => { events.push(event); };

      manager._checkDevtunnelAuth = async () => false;
      manager._loginDevtunnel = async () => false;

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(result.success, false);
      assert(result.error.includes('Authentication failed'));

      const errorEvent = events.find(e => e.type === 'vscode_tunnel_error');
      assert(errorEvent, 'Should emit vscode_tunnel_error event');
    });

    it('should skip login when already authenticated', async function () {
      manager._command = 'fake-code';
      manager._commandChecked = true;
      manager._available = true;
      manager._devtunnelCommand = 'fake-devtunnel';
      manager._devtunnelChecked = true;
      manager._devtunnelAvailable = true;

      let loginCalled = false;

      manager._checkDevtunnelAuth = async () => true;
      manager._loginDevtunnel = async () => { loginCalled = true; return true; };
      manager._spawnServer = async () => true;
      manager._waitForPort = async () => true;
      manager._ensureDevtunnel = async () => true;
      manager._spawnTunnel = async () => {};

      await manager.start('test-session', '/tmp');
      assert.strictEqual(loginCalled, false, '_loginDevtunnel should NOT have been called');
    });
  });

  // ── stop ───────────────────────────────────────────────────

  describe('stop', function () {
    it('should return success for unknown session', async function () {
      const result = await manager.stop('nonexistent');
      assert.strictEqual(result.success, true);
    });

    it('should clean up tunnel state after stop', async function () {
      manager.tunnels.set('test-session', {
        status: 'running',
        serverProcess: null,
        tunnelProcess: null,
        _loginProcess: null,
        localPort: 9100,
        connectionToken: 'abc',
        localUrl: 'http://localhost:9100/?tkn=abc',
        publicUrl: 'https://test.devtunnels.ms/?tkn=abc',
        tunnelId: 'aiordie-vscode-test',
        stopping: false,
        _stabilityTimer: null,
        _restartDelayTimer: null,
        _restartDelayResolve: null,
      });
      manager._reservedPorts.add(9100);

      await manager.stop('test-session');
      assert.strictEqual(manager.tunnels.has('test-session'), false);
    });

    it('should release the reserved port after stop', async function () {
      manager.tunnels.set('test-session', {
        status: 'running',
        serverProcess: null,
        tunnelProcess: null,
        _loginProcess: null,
        localPort: 9105,
        connectionToken: 'abc',
        localUrl: null,
        publicUrl: null,
        tunnelId: 'aiordie-vscode-test',
        stopping: false,
        _stabilityTimer: null,
        _restartDelayTimer: null,
        _restartDelayResolve: null,
      });
      manager._reservedPorts.add(9105);

      await manager.stop('test-session');
      assert.strictEqual(manager._reservedPorts.has(9105), false);
    });

    it('should emit stopped status event', async function () {
      const events = [];
      manager.onEvent = (sessionId, event) => { events.push({ sessionId, ...event }); };

      manager.tunnels.set('test-session', {
        status: 'running',
        serverProcess: null,
        tunnelProcess: null,
        _loginProcess: null,
        localPort: 9100,
        connectionToken: 'abc',
        localUrl: null,
        publicUrl: null,
        tunnelId: 'aiordie-vscode-test',
        stopping: false,
        _stabilityTimer: null,
        _restartDelayTimer: null,
        _restartDelayResolve: null,
      });

      await manager.stop('test-session');

      const stoppedEvent = events.find(e => e.type === 'vscode_tunnel_status' && e.status === 'stopped');
      assert(stoppedEvent, 'Should emit vscode_tunnel_status with status stopped');
      assert.strictEqual(stoppedEvent.sessionId, 'test-session');
    });

    it('should abort pending restart delay', async function () {
      let resolveWasCalled = false;
      const timer = setTimeout(() => {}, 60000);
      manager.tunnels.set('test-session', {
        status: 'restarting',
        serverProcess: null,
        tunnelProcess: null,
        _loginProcess: null,
        localPort: 9100,
        connectionToken: 'abc',
        localUrl: null,
        publicUrl: null,
        tunnelId: 'aiordie-vscode-test',
        stopping: false,
        _stabilityTimer: null,
        _restartDelayTimer: timer,
        _restartDelayResolve: () => { resolveWasCalled = true; },
      });

      await manager.stop('test-session');
      assert.strictEqual(resolveWasCalled, true, 'Pending restart delay should be resolved');
    });
  });

  // ── stopAll ────────────────────────────────────────────────

  describe('stopAll', function () {
    it('should stop all tunnels', async function () {
      manager.tunnels.set('s1', {
        status: 'running',
        serverProcess: null,
        tunnelProcess: null,
        _loginProcess: null,
        localPort: 9100,
        stopping: false,
        _stabilityTimer: null,
        _restartDelayTimer: null,
        _restartDelayResolve: null,
      });
      manager.tunnels.set('s2', {
        status: 'running',
        serverProcess: null,
        tunnelProcess: null,
        _loginProcess: null,
        localPort: 9101,
        stopping: false,
        _stabilityTimer: null,
        _restartDelayTimer: null,
        _restartDelayResolve: null,
      });

      await manager.stopAll();
      assert.strictEqual(manager.tunnels.size, 0);
    });
  });

  // ── getStatus ──────────────────────────────────────────────

  describe('getStatus', function () {
    it('should return stopped status for unknown session', function () {
      const status = manager.getStatus('nonexistent');
      assert.strictEqual(status.status, 'stopped');
      assert.strictEqual(status.url, null);
      assert.strictEqual(status.localUrl, null);
      assert.strictEqual(status.publicUrl, null);
    });

    it('should return localUrl, publicUrl, and url fields', function () {
      manager.tunnels.set('test-session', {
        status: 'running',
        localUrl: 'http://localhost:9100/?tkn=abc',
        publicUrl: 'https://test.devtunnels.ms/?tkn=abc',
        serverProcess: { pid: 1234 },
        tunnelProcess: { pid: 5678 },
      });

      const status = manager.getStatus('test-session');
      assert.strictEqual(status.status, 'running');
      assert.strictEqual(status.localUrl, 'http://localhost:9100/?tkn=abc');
      assert.strictEqual(status.publicUrl, 'https://test.devtunnels.ms/?tkn=abc');
      assert.strictEqual(status.url, 'https://test.devtunnels.ms/?tkn=abc');
      assert.strictEqual(status.pid, 1234);
      assert.strictEqual(status.tunnelPid, 5678);
    });

    it('should fall back url to localUrl when publicUrl is null', function () {
      manager.tunnels.set('test-session', {
        status: 'degraded',
        localUrl: 'http://localhost:9100/?tkn=abc',
        publicUrl: null,
        serverProcess: { pid: 1234 },
        tunnelProcess: null,
      });

      const status = manager.getStatus('test-session');
      assert.strictEqual(status.url, 'http://localhost:9100/?tkn=abc');
      assert.strictEqual(status.publicUrl, null);
      assert.strictEqual(status.tunnelPid, null);
    });

    it('should return null pids when processes are absent', function () {
      manager.tunnels.set('test-session', {
        status: 'starting',
        localUrl: null,
        publicUrl: null,
        serverProcess: null,
        tunnelProcess: null,
      });

      const status = manager.getStatus('test-session');
      assert.strictEqual(status.pid, null);
      assert.strictEqual(status.tunnelPid, null);
    });
  });

  // ── _activeCount ───────────────────────────────────────────

  describe('_activeCount', function () {
    it('should count running, starting, and degraded tunnels', function () {
      manager.tunnels.set('s1', { status: 'running' });
      manager.tunnels.set('s2', { status: 'starting' });
      manager.tunnels.set('s3', { status: 'degraded' });
      manager.tunnels.set('s4', { status: 'error' });
      manager.tunnels.set('s5', { status: 'stopped' });

      assert.strictEqual(manager._activeCount(), 3);
    });
  });

  // ── event callback ─────────────────────────────────────────

  describe('event callback', function () {
    it('should not emit events when CLI is not found', async function () {
      const events = [];
      manager.onEvent = (sessionId, event) => {
        events.push({ sessionId, ...event });
      };

      manager._command = null;
      manager._commandChecked = true;
      manager._available = false;
      manager._devtunnelChecked = true;

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'not_found');

      assert.strictEqual(events.length, 0, 'Expected no events when CLI not found');
    });

    it('should invoke onEvent with correct sessionId', function () {
      const events = [];
      manager.onEvent = (sessionId, event) => {
        events.push({ sessionId, ...event });
      };

      manager._emitEvent('test-session', 'vscode_tunnel_status', { status: 'starting' });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].sessionId, 'test-session');
      assert.strictEqual(events[0].type, 'vscode_tunnel_status');
      assert.strictEqual(events[0].status, 'starting');
    });
  });

  // ── clearAvailabilityCache ─────────────────────────────────

  describe('clearAvailabilityCache', function () {
    it('should reset both code and devtunnel discovery state', async function () {
      // Set initial state for both CLIs
      manager._command = '/usr/bin/code';
      manager._commandChecked = true;
      manager._available = true;
      manager._devtunnelCommand = '/usr/bin/devtunnel';
      manager._devtunnelChecked = true;
      manager._devtunnelAvailable = true;

      manager.clearAvailabilityCache();

      // Code CLI state should be reset
      assert.strictEqual(manager._command, null);
      assert.strictEqual(manager._commandChecked, false);
      assert.strictEqual(manager._available, false);

      // devtunnel CLI state should be reset
      assert.strictEqual(manager._devtunnelCommand, null);
      assert.strictEqual(manager._devtunnelChecked, false);
      assert.strictEqual(manager._devtunnelAvailable, false);

      // Wait for re-discovery to complete
      await manager._initPromise;
      assert.strictEqual(manager._commandChecked, true);
      assert.strictEqual(manager._devtunnelChecked, true);
    });
  });

  // ── _ensureDevtunnel port create fallback ────────────────────

  describe('_ensureDevtunnel port create fallback', function () {
    it('should return true even when port create fails (GitHub auth scope)', async function () {
      manager._devtunnelCommand = 'fake-devtunnel';

      const calls = [];
      manager._execDevtunnel = async (args, sessionId) => {
        calls.push(args.slice(0, 2).join(' '));
        // Simulate port create failure (GitHub auth scope limitation)
        if (args[0] === 'port') return false;
        return true;
      };

      // Set up a minimal tunnel state
      manager.tunnels.set('test-session', {
        tunnelId: 'aiordie-vscode-test',
        localPort: 9100,
        stopping: false,
      });

      const result = await manager._ensureDevtunnel('test-session');
      assert.strictEqual(result, true, '_ensureDevtunnel should succeed even when port create fails');
      assert.ok(calls.some(c => c.startsWith('create')), 'should have called create');
      assert.ok(calls.some(c => c.startsWith('port')), 'should have attempted port create');
    });

    it('should return false when tunnel create fails', async function () {
      manager._devtunnelCommand = 'fake-devtunnel';

      manager._execDevtunnel = async (args) => {
        if (args[0] === 'create') return false;
        return true;
      };

      manager.tunnels.set('test-session', {
        tunnelId: 'aiordie-vscode-test',
        localPort: 9100,
        stopping: false,
      });

      const result = await manager._ensureDevtunnel('test-session');
      assert.strictEqual(result, false, '_ensureDevtunnel should fail when create fails');
    });
  });

  // ── _installInstructions ───────────────────────────────────

  describe('_installInstructions', function () {
    it('should return platform-specific instructions for VS Code', function () {
      const instructions = manager._installInstructions();
      assert(typeof instructions === 'string');
      assert(instructions.includes('code.visualstudio.com'));
    });
  });

  // ── _devtunnelInstallInstructions ──────────────────────────

  describe('_devtunnelInstallInstructions', function () {
    it('should return instructions for devtunnel CLI', function () {
      const instructions = manager._devtunnelInstallInstructions();
      assert(typeof instructions === 'string');
      assert(instructions.includes('devtunnel'));
    });
  });
});
