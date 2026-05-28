'use strict';

/**
 * Shared HTTP/WS helpers for workloads.
 *
 * Kept tiny on purpose — workloads should not pull in test/e2e.test.js (which
 * brings mocha-specific scaffolding). Just the primitives.
 */

const http = require('http');
const WebSocket = require('ws');

function httpRequest(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = opts.body;
    const payload = body == null ? null
      : typeof body === 'string' || Buffer.isBuffer(body) ? body
      : JSON.stringify(body);
    const headers = { ...(opts.headers || {}) };
    if (payload != null) {
      headers['Content-Length'] = Buffer.byteLength(payload);
      if (typeof body === 'object' && !Buffer.isBuffer(body)) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      }
    }
    const req = http.request({
      method,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsedBody = data;
        try { parsedBody = JSON.parse(data); } catch (_) { /* keep raw */ }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsedBody });
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs || 10_000, () => req.destroy(new Error('http timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Open a WS and resolve once the 'connected' message arrives. */
function openWs(wsUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeoutMs = opts.timeoutMs || 5000;
    let settled = false;

    // Always keep a no-throw error listener so the ws module never raises an
    // uncaughtException when terminate() races a still-handshaking socket.
    const noopError = () => {};
    ws.on('error', noopError);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeListener('error', noopError);
      ws.removeListener('error', onError);
      ws.removeListener('message', onMessage);
      fn(arg);
    };

    const onError = (err) => finish(reject, err);
    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (_) { msg = { type: 'unknown' }; }
      if (msg.type !== 'connected') {
        // Re-attach noop so terminate() races don't propagate.
        ws.on('error', () => {});
        try { ws.terminate(); } catch (_) { /* ignore */ }
        return finish(reject, new Error(`expected 'connected', got '${msg.type}'`));
      }
      finish(resolve, { ws, connectionId: msg.connectionId });
    };
    const timer = setTimeout(() => {
      // Re-attach noop so terminate()/destroy() during handshake is swallowed.
      ws.on('error', () => {});
      try { ws.terminate(); } catch (_) { /* ignore */ }
      finish(reject, new Error('ws connect timeout'));
    }, timeoutMs);

    ws.once('error', onError);
    ws.once('message', onMessage);
  });
}

/** Best-effort close. Resolves once 'close' fires or after `forceMs`. */
function closeWs(ws, forceMs = 1000) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    // Keep a swallow-error handler so terminate() never throws upward.
    ws.on('error', () => {});
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    ws.once('close', finish);
    try { ws.close(); } catch (_) { /* ignore */ }
    setTimeout(() => {
      try { ws.terminate(); } catch (_) { /* ignore */ }
      finish();
    }, forceMs);
  });
}

function wsSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const data = typeof payload === 'string' || Buffer.isBuffer(payload)
    ? payload
    : JSON.stringify(payload);
  try { ws.send(data); return true; } catch (_) { return false; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { httpRequest, openWs, closeWs, wsSend, sleep, WebSocket };
