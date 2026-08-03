'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
  }
  kill() {
    this.exitCode = 0;
    this.emit('exit', 0);
  }
}

describe('VS Code tunnel stdout retention probe', function () {
  this.timeout(10000);

  let originalSpawn;
  let modulePath;
  let VSCodeTunnelManager;
  let children;

  before(function () {
    children = [];
    modulePath = require.resolve('../../../src/vscode-tunnel');
    originalSpawn = childProcess.spawn;
    childProcess.spawn = () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    };
    delete require.cache[modulePath];
    ({ VSCodeTunnelManager } = require('../../../src/vscode-tunnel'));
  });

  after(function () {
    childProcess.spawn = originalSpawn;
    delete require.cache[modulePath];
  });

  it('retains every active VS Code server stdout chunk in its readiness closure', async function () {
    const manager = new VSCodeTunnelManager();
    const sessionId = 'stdout-retention';
    const tunnel = {
      serverProcess: null,
      tunnelProcess: null,
      _loginProcess: null,
      localPort: 19199,
      connectionToken: 'token',
      localUrl: null,
      publicUrl: null,
      tunnelId: 'stdout-retention',
      status: 'starting',
      sessionId,
      workingDir: process.cwd(),
      retryCount: 0,
      stopping: false,
      _lastSpawnTime: null,
      _totalRestarts: 0,
      _stabilityTimer: null,
      _restartDelayTimer: null,
      _restartDelayResolve: null,
      _whichDied: null,
      _serverOutputBytes: 0,
      _loginOutputBytes: 0,
    };
    manager._command = 'fake-code';
    manager.tunnels.set(sessionId, tunnel);

    const start = manager._spawnServer(sessionId);
    const child = children[0];
    child.stdout.emit('data', Buffer.from('Web UI available at http://localhost:19199\n'));
    assert.strictEqual(await start, true);

    const chunk = 'x'.repeat(64 * 1024);
    for (let index = 0; index < 16; index++) child.stdout.emit('data', Buffer.from(chunk));

    assert.ok(
      tunnel._serverOutputBytes > 1024 * 1024,
      `readiness closure retained ${tunnel._serverOutputBytes} bytes of post-ready stdout`
    );
    assert.strictEqual(
      child.stdout.listenerCount('data'),
      1,
      'the active server stdout listener still closes over the accumulated outputBuffer'
    );

    tunnel.stopping = true;
    child.emit('exit', 0);
    assert.strictEqual(tunnel._serverOutputBytes, 0,
      'diagnostics report only the live child closure, not historical stdout');
    manager._cleanupTunnel(sessionId);
  });
});
