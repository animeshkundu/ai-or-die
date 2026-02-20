'use strict';

/**
 * Integration test: supervisor restart round-trip using a mock child server.
 *
 * Uses SUPERVISOR_CHILD_SCRIPT env to point the real supervisor at a lightweight
 * mock server (~50 lines, no PTY/bridges/timers) that shuts down in <100ms.
 * Sessions persist across restarts via a temp JSON file.
 *
 * Cleanup uses IPC (supervisor.send({ type: 'shutdown' })) which works on both
 * Linux and Windows without SIGTERM propagation issues.
 *
 * Expected duration: ~3-5 seconds.
 */

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const supervisorScript = path.join(__dirname, '..', 'bin', 'supervisor.js');
const mockServerScript = path.join(__dirname, 'fixtures', 'mock-supervised-server.js');

function waitForServerReady(port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Server not ready on port ${port} within ${timeoutMs}ms`));
      }
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        if (res.statusCode === 200) resolve();
        else setTimeout(check, 200);
      });
      req.on('error', () => setTimeout(check, 200));
      req.end();
    };
    check();
  });
}

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('WS connect timeout')); }, 5000);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connected') {
        clearTimeout(timeout);
        resolve({ ws, connectionId: msg.connectionId });
      }
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function wsSend(ws, data) { ws.send(JSON.stringify(data)); }

function waitForMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

describe('Supervisor Integration', function () {
  this.timeout(20000);

  let supervisorProcess;
  const port = 49152 + Math.floor(Math.random() * 16383);
  let sessionFile;

  beforeEach(function () {
    sessionFile = path.join(os.tmpdir(), `mock-sessions-${Date.now()}.json`);
  });

  afterEach(async function () {
    if (supervisorProcess && !supervisorProcess.killed) {
      // Try graceful IPC shutdown. Use callback form so Windows async
      // ERR_IPC_CHANNEL_CLOSED is routed to the callback, not thrown from setImmediate.
      try {
        if (supervisorProcess.connected) {
          supervisorProcess.send({ type: 'shutdown' }, () => { /* swallow IPC errors */ });
        }
      } catch (_) { /* ignore synchronous errors */ }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          // Kill the entire process tree — not just the supervisor
          try {
            if (process.platform === 'win32') {
              require('child_process').execSync(
                `taskkill /pid ${supervisorProcess.pid} /T /F`, { stdio: 'ignore' }
              );
            } else {
              process.kill(-supervisorProcess.pid, 'SIGKILL');
            }
          } catch (_) { /* already dead */ }
          resolve();
        }, 2000);
        supervisorProcess.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    try { fs.unlinkSync(sessionFile); } catch (_) { /* ignore */ }
  });

  it('should start supervisor, accept connections, restart on exit code 75, and preserve sessions', async function () {
    // 1. Start the supervisor with the mock child server
    supervisorProcess = spawn(process.execPath, [
      supervisorScript, '--port', String(port)
    ], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SUPERVISOR_CHILD_SCRIPT: mockServerScript,
        MOCK_SESSION_FILE: sessionFile
      }
    });

    let output = '';
    supervisorProcess.stdout.on('data', (d) => { output += d.toString(); });
    supervisorProcess.stderr.on('data', (d) => { output += d.toString(); });

    // 2. Wait for mock server to be ready
    await waitForServerReady(port);

    // 3. Connect WebSocket
    const { ws } = await connectWs(port);

    // 4. Create a session
    wsSend(ws, { type: 'create_session', name: 'Integration Test', workingDir: '/tmp' });
    const created = await waitForMessage(ws, 'session_created');
    assert.ok(created.sessionId, 'session should have an ID');
    const sessionId = created.sessionId;

    // 5. Join the session
    wsSend(ws, { type: 'join_session', sessionId });
    const joined = await waitForMessage(ws, 'session_joined');
    assert.strictEqual(joined.sessionId, sessionId);

    // 6. Trigger restart — expect server_restarting message
    const restartPromise = waitForMessage(ws, 'server_restarting');
    wsSend(ws, { type: 'restart_server' });
    const restartMsg = await restartPromise;
    assert.strictEqual(restartMsg.type, 'server_restarting');
    assert.strictEqual(restartMsg.reason, 'user_requested');

    // 7. Wait for WebSocket to close (mock server exits with 75)
    await new Promise((resolve) => {
      ws.on('close', resolve);
      setTimeout(resolve, 3000);
    });

    // 8. Wait for supervisor to respawn the mock server
    await waitForServerReady(port, 10000);

    // 9. Reconnect with a new WebSocket
    const { ws: ws2 } = await connectWs(port);

    // 10. Rejoin the same session — should be preserved via MOCK_SESSION_FILE
    wsSend(ws2, { type: 'join_session', sessionId });
    const rejoined = await waitForMessage(ws2, 'session_joined');
    assert.strictEqual(rejoined.sessionId, sessionId, 'should rejoin same session after restart');
    assert.strictEqual(rejoined.sessionName, 'Integration Test', 'session name should be preserved');

    // 11. Verify supervisor logged the restart
    assert.ok(output.includes('Restart requested'), 'supervisor should log restart');

    ws2.close();
  });
});
