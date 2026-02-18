'use strict';

/**
 * Integration test: actual supervisor restart round-trip.
 *
 * Starts bin/supervisor.js as a real child process, connects a WebSocket client,
 * triggers restart_server, and verifies the supervisor respawns the server and the
 * client can reconnect with sessions preserved.
 */

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const supervisorScript = path.join(__dirname, '..', 'bin', 'supervisor.js');

function waitForServerReady(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Server not ready on port ${port} within ${timeoutMs}ms`));
      }
      const http = require('http');
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        if (res.statusCode === 200) resolve();
        else setTimeout(check, 300);
      });
      req.on('error', () => setTimeout(check, 300));
      req.end();
    };
    check();
  });
}

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, 10000);
    ws.on('open', () => {
      clearTimeout(timeout);
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connected') {
        resolve({ ws, connectionId: msg.connectionId });
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function wsSend(ws, data) {
  ws.send(JSON.stringify(data));
}

function waitForMessage(ws, type, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch (_) { /* ignore non-JSON */ }
    };
    ws.on('message', handler);
  });
}

describe('Supervisor Integration', function () {
  this.timeout(60000);

  let supervisorProcess;
  const port = 49152 + Math.floor(Math.random() * 16383);

  afterEach(function (done) {
    if (supervisorProcess && !supervisorProcess.killed) {
      supervisorProcess.on('exit', () => done());
      supervisorProcess.kill('SIGTERM');
      // Hard kill fallback
      setTimeout(() => {
        try { supervisorProcess.kill('SIGKILL'); } catch (_) { /* ignore */ }
        done();
      }, 5000);
    } else {
      done();
    }
  });

  it('should start supervisor, accept connections, restart on exit code 75, and preserve sessions', async function () {
    // 1. Start the supervisor
    supervisorProcess = spawn(process.execPath, [
      supervisorScript,
      '--disable-auth', '--no-open', '--port', String(port)
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' }
    });

    let output = '';
    supervisorProcess.stdout.on('data', (d) => { output += d.toString(); });
    supervisorProcess.stderr.on('data', (d) => { output += d.toString(); });

    // 2. Wait for server to be ready
    await waitForServerReady(port);

    // 3. Connect WebSocket client
    const { ws } = await connectWs(port);

    // 4. Create a session
    wsSend(ws, { type: 'create_session', name: 'Integration Test', workingDir: process.cwd() });
    const created = await waitForMessage(ws, 'session_created');
    assert.ok(created.sessionId, 'session should have an ID');
    const sessionId = created.sessionId;

    // 5. Join the session
    wsSend(ws, { type: 'join_session', sessionId });
    const joined = await waitForMessage(ws, 'session_joined');
    assert.strictEqual(joined.sessionId, sessionId);

    // 6. Wait for server_restarting message, then send restart_server
    const restartPromise = waitForMessage(ws, 'server_restarting', 10000);
    wsSend(ws, { type: 'restart_server' });

    // 7. Verify we receive server_restarting
    const restartMsg = await restartPromise;
    assert.strictEqual(restartMsg.type, 'server_restarting');
    assert.strictEqual(restartMsg.reason, 'user_requested');

    // 8. WebSocket will close — wait for it
    await new Promise((resolve) => {
      ws.on('close', resolve);
      // Fallback if close doesn't fire
      setTimeout(resolve, 5000);
    });

    // 9. Wait for supervisor to respawn the server
    await waitForServerReady(port, 20000);

    // 10. Reconnect with a new WebSocket
    const { ws: ws2 } = await connectWs(port);

    // 11. Rejoin the same session
    wsSend(ws2, { type: 'join_session', sessionId });
    const rejoined = await waitForMessage(ws2, 'session_joined');
    assert.strictEqual(rejoined.sessionId, sessionId, 'should rejoin same session after restart');
    assert.strictEqual(rejoined.sessionName, 'Integration Test', 'session name should be preserved');

    // 12. Clean up
    ws2.close();
  });
});
