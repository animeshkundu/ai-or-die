'use strict';

const assert = require('assert');
const WebSocket = require('ws');
const { ClaudeCodeWebServer } = require('../src/server');

async function startServer(options) {
  const server = new ClaudeCodeWebServer(Object.assign({
    port: 0,
    bindHost: '127.0.0.1',
  }, options));
  const httpServer = await server.start();
  return { server, port: httpServer.address().port };
}

function wsUrl(port, suffix) {
  return `ws://127.0.0.1:${port}${suffix || '/'}`;
}

function expectWebSocketOpen(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    let settled = false;

    const timer = setTimeout(() => {
      fail(new Error(`WebSocket connection timed out: ${url}`));
    }, 5000);

    function cleanup() {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      ws.removeListener('error', onError);
      ws.removeListener('close', onClose);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      ws.removeListener('close', onClose);
      ws.once('close', () => ws.removeListener('error', onError));
      try { ws.terminate(); } catch (_) { /* ignore */ }
      reject(err);
    }

    function onMessage(raw, isBinary) {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        fail(err);
        return;
      }
      if (msg.type !== 'connected') {
        fail(new Error(`expected connected frame, got ${msg.type}`));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ws);
    }

    function onError(err) {
      fail(err);
    }

    function onClose() {
      fail(new Error('WebSocket closed before connected frame'));
    }

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

function expectWebSocketRejected(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    let settled = false;

    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for WebSocket rejection: ${url}`));
    }, 5000);

    function cleanup() {
      clearTimeout(timer);
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
      ws.removeListener('close', onClose);
    }

    function pass(err) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ error: err });
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeListener('open', onOpen);
      ws.removeListener('close', onClose);
      ws.once('close', () => ws.removeListener('error', onError));
      try { ws.terminate(); } catch (_) { /* ignore */ }
      reject(err);
    }

    function onOpen() {
      try { ws.close(); } catch (_) { /* ignore */ }
      fail(new Error('Expected WebSocket handshake to be rejected, but it opened'));
    }

    function onError(err) {
      if (/Unexpected server response/.test(err.message)) {
        pass(err);
        return;
      }
      fail(err);
    }

    function onClose() {
      fail(new Error('WebSocket closed before a rejection error was reported'));
    }

    ws.on('open', onOpen);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

function closeWs(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch (_) { /* ignore */ }
      resolve();
    }, 2000);

    ws.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });

    try { ws.close(); } catch (_) { /* ignore */ }
  });
}

describe('WebSocket auth: Authorization header parity', function () {
  this.timeout(15000);

  const AUTH_TOKEN = 'ws-auth-header-secret';
  let authServer;
  let authPort;
  let noAuthServer;
  let noAuthPort;

  before(async function () {
    ({ server: authServer, port: authPort } = await startServer({ auth: AUTH_TOKEN }));
    ({ server: noAuthServer, port: noAuthPort } = await startServer({ noAuth: true }));
  });

  after(async function () {
    if (authServer) await authServer.close();
    if (noAuthServer) await noAuthServer.close();
  });

  it('accepts a bearer token in the Authorization header without a query token', async function () {
    const ws = await expectWebSocketOpen(wsUrl(authPort), {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    await closeWs(ws);
  });

  it('rejects a wrong Authorization header when no query token is present', async function () {
    const result = await expectWebSocketRejected(wsUrl(authPort), {
      headers: { Authorization: 'Bearer wrong-token' },
    });

    assert.match(result.error.message, /Unexpected server response: 401/);
  });

  it('still accepts the existing query-token authentication path', async function () {
    const ws = await expectWebSocketOpen(wsUrl(authPort, `/?token=${encodeURIComponent(AUTH_TOKEN)}`));
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    await closeWs(ws);
  });

  it('accepts an unauthenticated socket when auth is disabled', async function () {
    const ws = await expectWebSocketOpen(wsUrl(noAuthPort));
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    await closeWs(ws);
  });
});
