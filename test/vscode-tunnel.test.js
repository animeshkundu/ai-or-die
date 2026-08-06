const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

    it('should stop a prior degraded attempt before retrying the same session', async function () {
      manager.tunnels.set('test-session', {
        status: 'degraded',
        localPort: 9100,
        serverProcess: null,
        tunnelProcess: null,
      });
      manager._reservedPorts.add(9100);
      let stopped = false;
      manager.stop = async (sessionId) => {
        stopped = true;
        manager._cleanupTunnel(sessionId);
        return { success: true };
      };
      manager._command = null;
      manager._commandChecked = true;
      manager._available = false;
      manager._devtunnelChecked = true;
      manager._devtunnelAvailable = true;

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(stopped, true);
      assert.strictEqual(result.error, 'not_found');
      assert.strictEqual(manager._reservedPorts.has(9100), false);
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

      let authChecks = 0;
      manager._checkDevtunnelAuth = async () => {
        authChecked = true;
        authChecks++;
        return authChecks > 1;
      };
      manager._loginDevtunnel = async () => { loginCalled = true; return true; };
      manager._spawnServer = async () => { serverSpawned = true; return true; };
      manager._waitForPort = async () => true;
      manager._ensureDevtunnel = async () => true;
      manager._spawnTunnel = async (sessionId) => {
        const tunnel = manager.tunnels.get(sessionId);
        tunnel.publicUrl = 'https://test.devtunnels.ms/?tkn=test';
        return { ok: true, url: tunnel.publicUrl };
      };

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
      assert.strictEqual(result.error, 'auth_required');
      assert(result.message.includes('devtunnel user login'));

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
      manager._spawnTunnel = async (sessionId) => {
        const tunnel = manager.tunnels.get(sessionId);
        tunnel.publicUrl = 'https://test.devtunnels.ms/?tkn=test';
        return { ok: true, url: tunnel.publicUrl };
      };

      await manager.start('test-session', '/tmp');
      assert.strictEqual(loginCalled, false, '_loginDevtunnel should NOT have been called');
    });

    it('should retain local access but return failure when hosting has no public URL', async function () {
      manager._command = 'fake-code';
      manager._commandChecked = true;
      manager._available = true;
      manager._devtunnelCommand = 'fake-devtunnel';
      manager._devtunnelChecked = true;
      manager._devtunnelAvailable = true;
      manager._checkDevtunnelAuth = async () => true;
      manager._spawnServer = async (sessionId) => {
        const { EventEmitter } = require('events');
        const tunnel = manager.tunnels.get(sessionId);
        tunnel.localUrl = `http://localhost:${tunnel.localPort}/?tkn=${tunnel.connectionToken}`;
        tunnel.serverProcess = new EventEmitter();
        tunnel.serverProcess.exitCode = null;
        tunnel.serverProcess.kill = () => {
          tunnel.serverProcess.exitCode = 0;
          tunnel.serverProcess.emit('exit', 0);
        };
        return true;
      };
      manager._waitForPort = async () => true;
      manager._ensureDevtunnel = async () => ({ ok: true });
      manager._spawnTunnel = async () => ({
        ok: false,
        error: 'network_unreachable',
        message: 'Dev Tunnel could not reach the tunnel service.',
      });

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'network_unreachable');
      assert(result.localUrl.startsWith('http://localhost:'));
      assert(result.message.includes('only from the machine running this server'));
      assert.strictEqual(manager.tunnels.get('test-session').status, 'degraded');
      assert(manager.tunnels.get('test-session').serverProcess, 'local server remains running');
    });

    it('does not publish a tunnel when the local VS Code port never becomes reachable', async function () {
      manager._command = 'fake-code';
      manager._commandChecked = true;
      manager._available = true;
      manager._devtunnelCommand = 'fake-devtunnel';
      manager._devtunnelChecked = true;
      manager._devtunnelAvailable = true;
      manager._checkDevtunnelAuth = async () => true;
      manager._spawnServer = async (sessionId) => {
        manager.tunnels.get(sessionId).serverProcess = { pid: 123 };
        return true;
      };
      manager._waitForPort = async () => false;
      let devtunnelStarted = false;
      manager._ensureDevtunnel = async () => {
        devtunnelStarted = true;
        return { ok: true };
      };
      manager._killProcess = async () => {};

      const result = await manager.start('test-session', '/tmp');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'server_start_failed');
      assert.strictEqual(devtunnelStarted, false);
      assert.strictEqual(manager.tunnels.has('test-session'), false);
      assert.strictEqual(manager._reservedPorts.size, 0);
    });
  });

  describe('devtunnel authentication', function () {
    it('fails closed for exit-zero logged-out and malformed responses', async function () {
      const cases = [
        '{"status":"Not logged in"}',
        'Not logged in.',
        'GitHub token refresh failed.',
        '',
        '{bad json',
      ];
      for (const stdout of cases) {
        manager._devtunnelCommand = 'fake-devtunnel';
        manager._execDevtunnelProbe = async () => ({ ok: true, stdout, stderr: '', error: null });
        assert.strictEqual(await manager._checkDevtunnelAuth(), false, stdout || '<empty>');
      }
    });

    it('accepts only structured positive identity evidence', async function () {
      manager._devtunnelCommand = 'fake-devtunnel';
      manager._execDevtunnelProbe = async () => ({
        ok: true,
        stdout: '{"status":"Logged in","user":{"name":"octocat"},"provider":"GitHub"}',
        stderr: '',
        error: null,
      });
      assert.strictEqual(await manager._checkDevtunnelAuth(), true);
      assert.strictEqual(manager._authProvider, 'github');
    });

    it('falls back to positive text identity for a CLI without --json', async function () {
      manager._devtunnelCommand = 'fake-devtunnel';
      let calls = 0;
      manager._execDevtunnelProbe = async () => {
        calls++;
        if (calls === 1) return { ok: false, stdout: '', stderr: 'Unknown option --json', error: new Error('old CLI') };
        return { ok: true, stdout: 'Logged in as octocat using GitHub.', stderr: '', error: null };
      };
      assert.strictEqual(await manager._checkDevtunnelAuth(), true);
      assert.strictEqual(calls, 2);
    });

    it('distinguishes an old CLI that cannot provide identity', async function () {
      manager._devtunnelCommand = 'fake-devtunnel';
      let calls = 0;
      manager._execDevtunnelProbe = async () => {
        calls++;
        if (calls === 1) return { ok: false, stdout: '', stderr: 'Unknown option --json', error: new Error('old CLI') };
        return { ok: true, stdout: '', stderr: '', error: null };
      };
      assert.strictEqual(await manager._checkDevtunnelAuth(), false);
      assert.strictEqual(manager._lastAuthCheck.error, 'cli_too_old');
      assert(manager._lastAuthCheck.message.includes('Update devtunnel'));
    });

    it('bounds a hung authentication probe', async function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtunnel-probe-'));
      const command = path.join(dir, process.platform === 'win32' ? 'hang.cmd' : 'hang.sh');
      fs.writeFileSync(
        command,
        process.platform === 'win32'
          ? '@echo off\r\n:loop\r\ngoto loop\r\n'
          : '#!/bin/sh\nwhile :; do :; done\n',
        { mode: 0o700 }
      );
      manager._devtunnelCommand = command;
      manager._probeTimeoutMs = 50;
      const startedAt = Date.now();
      const result = await manager._execDevtunnelProbe(['user', 'show', '--json']);
      const elapsed = Date.now() - startedAt;
      fs.rmSync(dir, { recursive: true, force: true });
      assert.strictEqual(result.ok, false);
      assert(elapsed < 2000, `probe took ${elapsed}ms`);
    });
  });

  describe('devtunnel failures', function () {
    it('classifies actionable creation, port, auth, network, and local-port failures', function () {
      assert.strictEqual(manager._classifyDevtunnelFailure('', 'tunnel_create', 1).error, 'tunnel_create_failed');
      assert.strictEqual(manager._classifyDevtunnelFailure('', 'port_create', 1).error, 'port_create_failed');
      assert.strictEqual(manager._classifyDevtunnelFailure('Request not permitted. Unauthorized tunnel creation access.', 'host', 3).error, 'auth_required');
      assert.strictEqual(manager._classifyDevtunnelFailure('DNS name resolution failed', 'host', 1).error, 'network_unreachable');
      assert.strictEqual(manager._classifyDevtunnelFailure('EADDRINUSE', 'host', 1).error, 'local_port_conflict');
      assert.strictEqual(manager._classifyDevtunnelFailure('unknown option --allow-anonymous', 'host', 1).error, 'cli_too_old');
    });

    describe('VS Code server spawn', function () {
      function fakeChild() {
        const { EventEmitter } = require('events');
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.exitCode = null;
        child.kill = () => {
          setImmediate(() => {
            child.exitCode = 0;
            child.emit('exit', 0);
          });
        };
        return child;
      }

      it('does not let an EADDRINUSE retry exit clobber the replacement process', async function () {
        const first = fakeChild();
        const second = fakeChild();
        const children = [first, second];
        manager._spawnProcess = () => children.shift();
        let restarts = 0;
        manager._restart = async () => { restarts++; };
        manager._command = process.platform === 'win32' ? 'code.exe' : '/usr/bin/code';
        manager.tunnels.set('test-session', {
          sessionId: 'test-session',
          workingDir: '/tmp',
          localPort: 9100,
          connectionToken: 'token',
          status: 'starting',
          stopping: false,
          retryCount: 0,
        });
        manager._reservedPorts.add(9100);

        const pending = manager._spawnServer('test-session');
        first.stderr.emit('data', Buffer.from('EADDRINUSE: address already in use'));
        await new Promise((resolve) => setImmediate(resolve));
        first.stderr.emit('data', Buffer.from('EADDRINUSE: trailing duplicate diagnostic'));
        second.stdout.emit('data', Buffer.from('Web UI available at http://localhost:9101'));
        assert.strictEqual(await pending, true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(manager.tunnels.get('test-session').serverProcess, second);
        assert.strictEqual(restarts, 0);
      });

      it('uses verbatim argv when launching a Windows command script through cmd.exe', function () {
        let captured;
        manager._isCommandScript = () => true;
        manager._spawnProcess = (command, args, options) => {
          captured = { command, args, options };
          return {};
        };
        manager._spawnCommand('C:\\Program Files\\Code\\code.cmd', ['serve-web', '--port', '9100'], {});
        assert.strictEqual(captured.options.windowsVerbatimArguments, true);
        assert(captured.args[3].includes('"C:\\Program Files\\Code\\code.cmd"'));
      });

      it('wraps the cmd.exe line so /s does not strip the program quotes', function () {
        manager._isCommandScript = () => true;
        const line = manager._cmdLine('C:\\Program Files\\Code\\code.cmd', [
          'serve-web',
          '--port',
          '9100',
          '--server-data-dir',
          'C:\\Users\\Ada Lovelace\\data',
        ]);
        // cmd.exe /s removes the first and last character when both are quotes,
        // so the surviving line must still quote the program path itself.
        assert.strictEqual(line[0], '"');
        assert.strictEqual(line[line.length - 1], '"');
        const stripped = line.slice(1, -1);
        assert(stripped.startsWith('"C:\\Program Files\\Code\\code.cmd"'));
        // Plain tokens stay unquoted so batch wrappers comparing %1 still match.
        assert(stripped.includes(' serve-web --port 9100 '));
        assert(stripped.endsWith('"C:\\Users\\Ada Lovelace\\data"'));
      });
    });

    it('returns captured stderr when host exits before producing a URL', async function () {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      manager._spawnProcess = () => child;
      manager._devtunnelCommand = 'fake-devtunnel';
      manager.tunnels.set('test-session', {
        sessionId: 'test-session',
        tunnelId: 'test',
        connectionToken: 'token',
        status: 'starting',
        stopping: false,
      });
      const pending = manager._spawnTunnel('test-session');
      child.stderr.emit('data', Buffer.from('Tunnel service error: Request not permitted. Unauthorized tunnel creation access.'));
      child.emit('exit', 3);
      const failure = await pending;
      assert.strictEqual(failure.error, 'auth_required');
      assert(failure.stderrTail.includes('Request not permitted'));
      assert(failure.message.includes('devtunnel user login'));
    });

    it('recognizes a public URL split across stdout chunks', async function () {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      manager._spawnProcess = () => child;
      manager._devtunnelCommand = 'fake-devtunnel';
      manager.tunnels.set('test-session', {
        sessionId: 'test-session',
        tunnelId: 'test',
        connectionToken: 'token',
        localUrl: 'http://localhost:9100/?tkn=token',
        status: 'starting',
        stopping: false,
        retryCount: 0,
      });

      const pending = manager._spawnTunnel('test-session');
      child.stdout.emit('data', Buffer.from('Connect via https://split.dev'));
      child.stdout.emit('data', Buffer.from('tunnels.ms'));
      const result = await pending;

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.url, 'https://split.devtunnels.ms?tkn=token');
    });

    it('returns url_timeout instead of silently resolving when no URL appears', async function () {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { child.emit('exit', null); };
      manager._spawnProcess = () => child;
      manager._urlTimeoutMs = 20;
      manager._devtunnelCommand = 'fake-devtunnel';
      manager.tunnels.set('test-session', {
        sessionId: 'test-session',
        tunnelId: 'test',
        connectionToken: 'token',
        status: 'starting',
        stopping: false,
      });

      const failure = await manager._spawnTunnel('test-session');
      assert.strictEqual(failure.ok, false);
      assert.strictEqual(failure.error, 'url_timeout');
    });
  });

  describe('restart failures', function () {
    function restartState(serverProcess) {
      return {
        serverProcess,
        tunnelProcess: null,
        _loginProcess: null,
        localPort: 9100,
        connectionToken: 'token',
        localUrl: 'http://localhost:9100/?tkn=token',
        publicUrl: null,
        tunnelId: 'aiordie-vscode-test',
        status: 'degraded',
        sessionId: 'test-session',
        workingDir: '/tmp',
        retryCount: 0,
        stopping: false,
        _lastSpawnTime: Date.now(),
        _totalRestarts: 0,
        _stabilityTimer: null,
        _restartDelayTimer: null,
        _restartDelayResolve: null,
        _whichDied: null,
      };
    }

    async function releaseRestartDelay(tunnel, pending) {
      assert(tunnel._restartDelayResolve, 'restart delay was not installed');
      clearTimeout(tunnel._restartDelayTimer);
      tunnel._restartDelayResolve();
      await pending;
    }

    it('surfaces a tunnel restart failure and keeps usable local access', async function () {
      const serverProcess = new EventEmitter();
      serverProcess.exitCode = null;
      serverProcess.kill = () => {
        serverProcess.exitCode = 0;
        setImmediate(() => serverProcess.emit('exit', 0));
      };
      const tunnel = restartState(serverProcess);
      tunnel._whichDied = 'tunnel';
      manager.tunnels.set('test-session', tunnel);
      manager._reservedPorts.add(9100);
      manager._ensureDevtunnel = async () => ({ ok: true });
      manager._spawnTunnel = async () => ({
        ok: false,
        error: 'network_unreachable',
        message: 'Dev Tunnel could not reach the tunnel service.',
      });
      const events = [];
      manager.onEvent = (_sessionId, event) => events.push(event);

      const pending = manager._restart('test-session');
      await releaseRestartDelay(tunnel, pending);

      assert.strictEqual(tunnel.status, 'degraded');
      assert.strictEqual(tunnel.serverProcess, serverProcess);
      assert.strictEqual(manager._reservedPorts.has(9100), true);
      const failure = events.find((event) => event.type === 'vscode_tunnel_error');
      assert(failure, 'restart failure was not surfaced');
      assert.strictEqual(failure.error, 'network_unreachable');
      assert.strictEqual(failure.localUrl, tunnel.localUrl);
      assert(failure.message.includes('only from the machine running this server'));
    });

    it('surfaces a server restart failure and releases the reserved port', async function () {
      const tunnel = restartState(null);
      tunnel._whichDied = 'server';
      manager.tunnels.set('test-session', tunnel);
      manager._reservedPorts.add(9100);
      manager._spawnServer = async () => {
        tunnel._serverFailure = {
          error: 'server_start_failed',
          message: 'VS Code Server could not restart.',
        };
        return false;
      };
      const events = [];
      manager.onEvent = (_sessionId, event) => events.push(event);

      const pending = manager._restart('test-session');
      await releaseRestartDelay(tunnel, pending);

      assert.strictEqual(manager.tunnels.has('test-session'), false);
      assert.strictEqual(manager._reservedPorts.has(9100), false);
      const failure = events.find((event) => event.type === 'vscode_tunnel_error');
      assert(failure, 'server restart failure was not surfaced');
      assert.strictEqual(failure.error, 'server_start_failed');
      assert.strictEqual(failure.fatal, true);
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
