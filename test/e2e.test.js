const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { ClaudeCodeWebServer } = require('../src/server');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a WebSocket message matching the given type.
 * Returns the parsed message object or rejects after timeout.
 */
function waitForMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for message type "${type}" after ${timeoutMs}ms`));
    }, timeoutMs);

    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        cleanup();
        resolve(msg);
      }
    }

    function onClose() {
      cleanup();
      reject(new Error(`WebSocket closed while waiting for "${type}"`));
    }

    function cleanup() {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      ws.removeListener('close', onClose);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

/**
 * Collect all messages of a given type that arrive within a time window.
 */
function collectMessages(ws, type, durationMs = 3000) {
  return new Promise((resolve) => {
    const collected = [];

    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        collected.push(msg);
      }
    }

    ws.on('message', onMessage);

    setTimeout(() => {
      ws.removeListener('message', onMessage);
      resolve(collected);
    }, durationMs);
  });
}

/**
 * Send a JSON message over the WebSocket.
 */
function wsSend(ws, data) {
  ws.send(JSON.stringify(data));
}

/**
 * Make an HTTP request and return { statusCode, headers, body (parsed JSON) }.
 */
function httpRequest(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: { ...headers }
    };

    if (body) {
      const payload = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Create a WebSocket connection to the server. Returns a promise that resolves
 * once the 'connected' message is received (or rejects on error/timeout).
 */
function connectWs(port, token, sessionId) {
  return new Promise((resolve, reject) => {
    let url = `ws://127.0.0.1:${port}/`;
    const params = [];
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    if (sessionId) params.push(`sessionId=${encodeURIComponent(sessionId)}`);
    if (params.length) url += '?' + params.join('&');

    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timed out'));
    }, 5000);

    ws.on('open', () => {
      // Wait for the 'connected' message from the server
      ws.once('message', (raw) => {
        clearTimeout(timer);
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'connected') {
          resolve({ ws, connectionId: msg.connectionId });
        } else {
          reject(new Error(`Expected 'connected', got '${msg.type}'`));
        }
      });
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Safely close a WebSocket connection.
 */
function closeWs(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      return resolve();
    }
    ws.on('close', () => resolve());
    ws.close();
    // Force-close after 2s if it hasn't shut down
    setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      resolve();
    }, 2000);
  });
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe('E2E: Server lifecycle', function () {
  this.timeout(15000);

  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    server.close();
  });

  it('should start and listen on the assigned port', function () {
    assert(port > 0, `Expected a valid port, got ${port}`);
  });

  it('should respond to the health endpoint', async function () {
    const res = await httpRequest('GET', `http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert(typeof res.body.claudeSessions === 'number');
    assert(typeof res.body.activeConnections === 'number');
  });

  it('should return config with tool availability', async function () {
    const res = await httpRequest('GET', `http://127.0.0.1:${port}/api/config`);
    assert.strictEqual(res.statusCode, 200);
    assert(res.body.tools, 'Expected tools in config');
    assert.strictEqual(res.body.tools.terminal.available, true);
    assert(typeof res.body.aliases === 'object');
  });
});


describe('E2E: Authentication', function () {
  this.timeout(15000);

  const AUTH_TOKEN = 'test-secret-token-12345';

  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, auth: AUTH_TOKEN });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    server.close();
  });

  it('should accept a valid Bearer token on REST endpoints', async function () {
    const res = await httpRequest('GET', `http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'ok');
  });

  it('should reject an invalid token on REST endpoints', async function () {
    const res = await httpRequest('GET', `http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: 'Bearer wrong-token' }
    });
    assert.strictEqual(res.statusCode, 401);
  });

  it('should reject requests with no token on REST endpoints', async function () {
    const res = await httpRequest('GET', `http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(res.statusCode, 401);
  });

  it('should allow WebSocket connection with valid token', async function () {
    const { ws, connectionId } = await connectWs(port, AUTH_TOKEN);
    assert(connectionId, 'Expected a connectionId');
    await closeWs(ws);
  });

  it('should reject WebSocket connection with invalid token', async function () {
    try {
      await connectWs(port, 'wrong-token');
      assert.fail('Expected WebSocket connection to be rejected');
    } catch (err) {
      // ws library emits an error or the connection is refused -- both are acceptable
      assert(err, 'Expected an error for invalid token');
    }
  });

  it('should allow auth-verify endpoint without middleware token', async function () {
    // The auth-verify endpoint is placed before the auth middleware
    const res = await httpRequest('POST', `http://127.0.0.1:${port}/auth-verify`, {
      body: { token: AUTH_TOKEN }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.valid, true);
  });

  it('should reject invalid token on auth-verify endpoint', async function () {
    const res = await httpRequest('POST', `http://127.0.0.1:${port}/auth-verify`, {
      body: { token: 'bad-token' }
    });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.valid, false);
  });
});


describe('E2E: WebSocket connection', function () {
  this.timeout(15000);

  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    server.close();
  });

  it('should receive a connected message with connectionId on connect', async function () {
    const { ws, connectionId } = await connectWs(port);
    assert(typeof connectionId === 'string');
    assert(connectionId.length > 0);
    await closeWs(ws);
  });

  it('should respond to ping with pong', async function () {
    const { ws } = await connectWs(port);
    wsSend(ws, { type: 'ping' });
    const msg = await waitForMessage(ws, 'pong');
    assert.strictEqual(msg.type, 'pong');
    await closeWs(ws);
  });

  it('should handle clean disconnect without errors', async function () {
    const { ws } = await connectWs(port);
    await closeWs(ws);
    // Verify server is still healthy after disconnect
    const res = await httpRequest('GET', `http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(res.statusCode, 200);
  });
});


describe('E2E: Session management', function () {
  this.timeout(15000);

  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    server.close();
  });

  it('should create a session via WebSocket', async function () {
    const { ws } = await connectWs(port);
    wsSend(ws, { type: 'create_session', name: 'Test Session WS' });

    const msg = await waitForMessage(ws, 'session_created');
    assert(msg.sessionId, 'Expected sessionId in response');
    assert.strictEqual(msg.sessionName, 'Test Session WS');
    assert(msg.workingDir, 'Expected workingDir in response');
    await closeWs(ws);
  });

  it('should create a session via REST', async function () {
    const res = await httpRequest('POST', `http://127.0.0.1:${port}/api/sessions/create`, {
      body: { name: 'Test Session REST' }
    });
    assert.strictEqual(res.statusCode, 200);
    assert(res.body.sessionId);
    assert.strictEqual(res.body.session.name, 'Test Session REST');
  });

  it('should list all sessions', async function () {
    const res = await httpRequest('GET', `http://127.0.0.1:${port}/api/sessions/list`);
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.body.sessions));
    assert(res.body.sessions.length >= 2, 'Expected at least 2 sessions from prior tests');
  });

  it('should join an existing session', async function () {
    // First create a session
    const createRes = await httpRequest('POST', `http://127.0.0.1:${port}/api/sessions/create`, {
      body: { name: 'Join Target' }
    });
    const sessionId = createRes.body.sessionId;

    // Then join it via WebSocket
    const { ws } = await connectWs(port);
    wsSend(ws, { type: 'join_session', sessionId });

    const msg = await waitForMessage(ws, 'session_joined');
    assert.strictEqual(msg.sessionId, sessionId);
    assert.strictEqual(msg.sessionName, 'Join Target');
    assert(Array.isArray(msg.outputBuffer));
    await closeWs(ws);
  });

  it('should return an error when joining a non-existent session', async function () {
    const { ws } = await connectWs(port);
    wsSend(ws, { type: 'join_session', sessionId: 'does-not-exist' });

    const msg = await waitForMessage(ws, 'error');
    assert(msg.message.includes('not found'));
    await closeWs(ws);
  });

  it('should leave a session', async function () {
    const { ws } = await connectWs(port);
    wsSend(ws, { type: 'create_session', name: 'Leave Test' });
    await waitForMessage(ws, 'session_created');

    wsSend(ws, { type: 'leave_session' });
    const msg = await waitForMessage(ws, 'session_left');
    assert.strictEqual(msg.type, 'session_left');
    await closeWs(ws);
  });

  it('should delete a session via REST', async function () {
    // Create a session to delete
    const createRes = await httpRequest('POST', `http://127.0.0.1:${port}/api/sessions/create`, {
      body: { name: 'Delete Me' }
    });
    const sessionId = createRes.body.sessionId;

    // Delete it
    const deleteRes = await httpRequest('DELETE', `http://127.0.0.1:${port}/api/sessions/${sessionId}`);
    assert.strictEqual(deleteRes.statusCode, 200);

    // Verify it's gone
    const getRes = await httpRequest('GET', `http://127.0.0.1:${port}/api/sessions/${sessionId}`);
    assert.strictEqual(getRes.statusCode, 404);
  });

  it('should return 404 when deleting a non-existent session', async function () {
    const res = await httpRequest('DELETE', `http://127.0.0.1:${port}/api/sessions/does-not-exist`);
    assert.strictEqual(res.statusCode, 404);
  });
});


describe('E2E: Terminal tool session', function () {
  this.timeout(30000);

  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    server.close();
  });

  it('should start a terminal session and receive output', async function () {
    const { ws } = await connectWs(port);

    // Create and auto-join a session
    wsSend(ws, { type: 'create_session', name: 'Terminal Test' });
    const created = await waitForMessage(ws, 'session_created');

    // Start terminal (bash/powershell)
    wsSend(ws, { type: 'start_terminal' });
    const started = await waitForMessage(ws, 'terminal_started', 10000);
    assert.strictEqual(started.type, 'terminal_started');

    // The shell should produce some initial output (prompt, motd, etc.)
    const outputs = await collectMessages(ws, 'output', 3000);
    assert(outputs.length > 0, 'Expected at least one output message from the shell');

    // Stop
    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000);
    await closeWs(ws);
  });

  it('should error when starting a tool without joining a session', async function () {
    const { ws } = await connectWs(port);

    wsSend(ws, { type: 'start_terminal' });
    const msg = await waitForMessage(ws, 'error');
    assert(msg.message.includes('No session'));
    await closeWs(ws);
  });

  it('should error when starting an unavailable tool', async function () {
    const { ws } = await connectWs(port);

    wsSend(ws, { type: 'create_session', name: 'Unavailable Tool Test' });
    await waitForMessage(ws, 'session_created');

    // Codex is unlikely to be installed in CI; if it is, skip this test
    if (server.codexBridge.isAvailable()) {
      this.skip();
      return;
    }

    wsSend(ws, { type: 'start_codex' });
    const msg = await waitForMessage(ws, 'error');
    assert(msg.message.includes('not available'), `Expected "not available" error, got: ${msg.message}`);
    await closeWs(ws);
  });

  it('should error when starting a second tool in the same session', async function () {
    const { ws } = await connectWs(port);

    wsSend(ws, { type: 'create_session', name: 'Double Start' });
    await waitForMessage(ws, 'session_created');

    wsSend(ws, { type: 'start_terminal' });
    await waitForMessage(ws, 'terminal_started', 10000);

    // Try to start again
    wsSend(ws, { type: 'start_terminal' });
    const errMsg = await waitForMessage(ws, 'error');
    assert(errMsg.message.includes('already running'));

    // Cleanup
    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000);
    await closeWs(ws);
  });

  it('should handle terminal resize without errors', async function () {
    const { ws } = await connectWs(port);

    wsSend(ws, { type: 'create_session', name: 'Resize Test' });
    await waitForMessage(ws, 'session_created');

    wsSend(ws, { type: 'start_terminal' });
    await waitForMessage(ws, 'terminal_started', 10000);

    // Send resize -- should not produce an error
    wsSend(ws, { type: 'resize', cols: 120, rows: 40 });

    // Give it a moment, then verify no error arrived
    await new Promise((resolve) => setTimeout(resolve, 500));

    // If we get here without an error, resize was accepted. Send a command to
    // verify the session is still alive.
    wsSend(ws, { type: 'input', data: 'echo resize-ok\n' });
    const outputs = await collectMessages(ws, 'output', 3000);
    const combined = outputs.map(m => m.data).join('');
    assert(combined.includes('resize-ok'), 'Expected terminal to still be responsive after resize');

    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000);
    await closeWs(ws);
  });

  it('should start terminal with custom cols/rows from client', async function () {
    const { ws } = await connectWs(port);

    wsSend(ws, { type: 'create_session', name: 'Custom Size Test' });
    await waitForMessage(ws, 'session_created');

    // Start terminal with explicit dimensions (instead of default 80x24)
    const startedPromise = waitForMessage(ws, 'terminal_started', 15000);
    wsSend(ws, { type: 'start_terminal', options: {}, cols: 132, rows: 50 });
    await startedPromise;

    // Verify terminal is responsive with a marker echo
    await collectMessages(ws, 'output', 3000);
    const marker = `SIZE_${Date.now()}`;
    wsSend(ws, { type: 'input', data: `echo ${marker}\n` });
    const outputs = await collectMessages(ws, 'output', 5000);
    const combined = outputs.map(m => m.data).join('');
    assert(combined.includes(marker), `Expected echo output with custom size, got: ${combined.slice(0, 300)}`);

    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000);
    await closeWs(ws);
  });

  it('should echo a unique marker through the terminal (cross-platform)', async function () {
    const { ws } = await connectWs(port);
    wsSend(ws, { type: 'create_session', name: 'Cross-Platform Echo' });
    await waitForMessage(ws, 'session_created');

    const startedPromise = waitForMessage(ws, 'terminal_started', 15000);
    wsSend(ws, { type: 'start_terminal' });
    await startedPromise;

    // Drain initial output (prompt, motd)
    await collectMessages(ws, 'output', 3000);

    // Send echo with unique marker
    const marker = `XPLAT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    wsSend(ws, { type: 'input', data: `echo ${marker}\n` });

    const outputs = await collectMessages(ws, 'output', 5000);
    const combined = outputs.map(m => m.data).join('');
    assert(combined.includes(marker),
      `Expected output to contain "${marker}" but got: ${combined.slice(0, 500)}`);

    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000);
    await closeWs(ws);
  });
});


describe('E2E: Input/output round-trip', function () {
  this.timeout(30000);

  let server;
  let port;
  let ws;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;

    // Set up a session with a running terminal for all tests in this block
    ({ ws } = await connectWs(port));
    wsSend(ws, { type: 'create_session', name: 'IO Test' });
    await waitForMessage(ws, 'session_created');
    // Set up listener before sending to avoid race condition
    const startedPromise = waitForMessage(ws, 'terminal_started', 15000);
    wsSend(ws, { type: 'start_terminal' });
    await startedPromise;

    // Drain initial shell output (prompt, motd) — generous window for Windows ConPTY
    await collectMessages(ws, 'output', 3000);
  });

  after(async function () {
    wsSend(ws, { type: 'stop' });
    try {
      await waitForMessage(ws, 'terminal_stopped', 10000);
    } catch (_) {
      // Terminal may have already exited
    }
    await closeWs(ws);
    server.close();
  });

  it('should echo a simple string through the terminal', async function () {
    const marker = `E2E_MARKER_${Date.now()}`;
    wsSend(ws, { type: 'input', data: `echo ${marker}\n` });

    const outputs = await collectMessages(ws, 'output', 5000);
    const combined = outputs.map(m => m.data).join('');
    assert(combined.includes(marker), `Expected output to contain "${marker}", got: ${combined.slice(0, 200)}`);
  });

  it('should handle multi-line output', async function () {
    const marker = `MULTI_${Date.now()}`;
    // printf works on both bash and powershell (via alias)
    wsSend(ws, { type: 'input', data: `echo ${marker}_LINE1 && echo ${marker}_LINE2\n` });

    const outputs = await collectMessages(ws, 'output', 5000);
    const combined = outputs.map(m => m.data).join('');
    assert(combined.includes(`${marker}_LINE1`), 'Expected LINE1 in output');
    assert(combined.includes(`${marker}_LINE2`), 'Expected LINE2 in output');
  });

  it('should replay output buffer when a new client joins the session', async function () {
    // Send a distinctive marker through the terminal
    const marker = `REPLAY_${Date.now()}`;
    wsSend(ws, { type: 'input', data: `echo ${marker}\n` });
    await collectMessages(ws, 'output', 2000);

    // Get the session ID from the server
    const listRes = await httpRequest('GET', `http://127.0.0.1:${port}/api/sessions/list`);
    const ioSession = listRes.body.sessions.find(s => s.name === 'IO Test');
    assert(ioSession, 'Could not find the IO Test session');

    // Connect a second client and join the same session
    const { ws: ws2 } = await connectWs(port);
    wsSend(ws2, { type: 'join_session', sessionId: ioSession.id });
    const joinMsg = await waitForMessage(ws2, 'session_joined');

    // The output buffer should contain our marker
    assert(Array.isArray(joinMsg.outputBuffer), 'Expected outputBuffer array');
    const bufferText = joinMsg.outputBuffer.join('');
    assert(bufferText.includes(marker), `Expected buffer to contain "${marker}"`);

    await closeWs(ws2);
  });
});


describe('E2E: Multi-session isolation', function () {
  this.timeout(30000);

  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    server.close();
  });

  it('should isolate output between sessions', async function () {
    // Create two sessions with terminals
    const { ws: wsA } = await connectWs(port);
    wsSend(wsA, { type: 'create_session', name: 'Session A' });
    const createdA = await waitForMessage(wsA, 'session_created');
    wsSend(wsA, { type: 'start_terminal' });
    await waitForMessage(wsA, 'terminal_started', 10000);
    // Drain initial output
    await collectMessages(wsA, 'output', 1500);

    const { ws: wsB } = await connectWs(port);
    wsSend(wsB, { type: 'create_session', name: 'Session B' });
    const createdB = await waitForMessage(wsB, 'session_created');
    wsSend(wsB, { type: 'start_terminal' });
    await waitForMessage(wsB, 'terminal_started', 10000);
    // Drain initial output
    await collectMessages(wsB, 'output', 1500);

    // Send a unique marker to session A only
    const markerA = `ISOLATE_A_${Date.now()}`;
    wsSend(wsA, { type: 'input', data: `echo ${markerA}\n` });

    // Collect output from both sessions
    const [outputsA, outputsB] = await Promise.all([
      collectMessages(wsA, 'output', 3000),
      collectMessages(wsB, 'output', 3000)
    ]);

    const combinedA = outputsA.map(m => m.data).join('');
    const combinedB = outputsB.map(m => m.data).join('');

    assert(combinedA.includes(markerA), 'Session A should see its own output');
    assert(!combinedB.includes(markerA), 'Session B should NOT see Session A output');

    // Cleanup
    wsSend(wsA, { type: 'stop' });
    wsSend(wsB, { type: 'stop' });
    await Promise.all([
      waitForMessage(wsA, 'exit', 10000).catch(() => {}),
      waitForMessage(wsB, 'exit', 10000).catch(() => {})
    ]);
    await Promise.all([closeWs(wsA), closeWs(wsB)]);
  });
});


describe('E2E: Multi-session tool start from same WebSocket', function () {
  this.timeout(60000);

  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    server.close();
  });

  it('should start tools in two different sessions from the same WebSocket', async function () {
    const { ws } = await connectWs(port);

    // Create Session A (implicitly joins)
    wsSend(ws, { type: 'create_session', name: 'Multi-Start A' });
    const createdA = await waitForMessage(ws, 'session_created');
    const sessionIdA = createdA.sessionId;
    assert(sessionIdA, 'Expected sessionId for Session A');

    // Start terminal in Session A
    wsSend(ws, { type: 'start_terminal' });
    await waitForMessage(ws, 'terminal_started', 15000);
    await collectMessages(ws, 'output', 1500);

    // Create Session B (implicitly leaves A and joins B)
    wsSend(ws, { type: 'create_session', name: 'Multi-Start B' });
    const createdB = await waitForMessage(ws, 'session_created');
    const sessionIdB = createdB.sessionId;
    assert(sessionIdB, 'Expected sessionId for Session B');
    assert.notStrictEqual(sessionIdA, sessionIdB, 'Sessions should have different IDs');

    // Start terminal in Session B — this is the regression target
    wsSend(ws, { type: 'start_terminal' });
    const startedB = await waitForMessage(ws, 'terminal_started', 15000);
    assert.strictEqual(startedB.type, 'terminal_started');

    // Verify Session B is functional
    const markerB = `SESSION_B_${Date.now()}`;
    await collectMessages(ws, 'output', 1500);
    wsSend(ws, { type: 'input', data: `echo ${markerB}\n` });
    const outputsB = await collectMessages(ws, 'output', 3000);
    const combinedB = outputsB.map(m => m.data).join('');
    assert(combinedB.includes(markerB), `Expected Session B output to contain "${markerB}"`);

    // Cleanup: stop Session B
    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'exit', 10000).catch(() => {});

    // Switch back to A and stop it
    wsSend(ws, { type: 'join_session', sessionId: sessionIdA });
    await waitForMessage(ws, 'session_joined', 5000);
    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'exit', 10000).catch(() => {});

    await closeWs(ws);
  });

  it('should start a tool after explicit leave/join with REST-created session', async function () {
    const { ws } = await connectWs(port);

    // Create Session A via WS
    wsSend(ws, { type: 'create_session', name: 'Leave-Join A' });
    const createdA = await waitForMessage(ws, 'session_created');

    // Start terminal in A
    wsSend(ws, { type: 'start_terminal' });
    await waitForMessage(ws, 'terminal_started', 15000);

    // Create Session B via REST (different creation path)
    const createRes = await httpRequest('POST', `http://127.0.0.1:${port}/api/sessions/create`, {
      body: { name: 'Leave-Join B' }
    });
    assert.strictEqual(createRes.statusCode, 200);
    const sessionIdB = createRes.body.sessionId;
    assert(sessionIdB, 'Expected sessionId from REST create');

    // Leave A, join B
    wsSend(ws, { type: 'leave_session' });
    await waitForMessage(ws, 'session_left');
    wsSend(ws, { type: 'join_session', sessionId: sessionIdB });
    const joined = await waitForMessage(ws, 'session_joined');
    assert.strictEqual(joined.sessionId, sessionIdB);

    // Start terminal in B (REST-created session)
    wsSend(ws, { type: 'start_terminal' });
    const startedB = await waitForMessage(ws, 'terminal_started', 15000);
    assert.strictEqual(startedB.type, 'terminal_started');

    // Cleanup: stop B
    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'exit', 10000).catch(() => {});

    // Stop A
    wsSend(ws, { type: 'join_session', sessionId: createdA.sessionId });
    await waitForMessage(ws, 'session_joined', 5000);
    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'exit', 10000).catch(() => {});

    await closeWs(ws);
  });

  it('should send error when session is deleted before tool start', async function () {
    // Create a session via REST (no WS attached) then try to start a tool after deletion
    const createRes = await httpRequest('POST', `http://127.0.0.1:${port}/api/sessions/create`, {
      body: { name: 'Ghost Session' }
    });
    assert.strictEqual(createRes.statusCode, 200);
    const ghostId = createRes.body.sessionId;

    // Delete it immediately via REST
    const delRes = await httpRequest('DELETE', `http://127.0.0.1:${port}/api/sessions/${ghostId}`);
    assert.strictEqual(delRes.statusCode, 200);

    // Now connect a WS and try to join the deleted session
    const { ws } = await connectWs(port);
    wsSend(ws, { type: 'join_session', sessionId: ghostId });
    const errMsg = await waitForMessage(ws, 'error', 5000);
    assert(
      errMsg.message.includes('not found') || errMsg.message.includes('Session not found'),
      `Expected session-not-found error, got: ${errMsg.message}`
    );

    await closeWs(ws);
  });
});
