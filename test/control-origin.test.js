'use strict';

// Control-plane Origin allowlist (defense-in-depth atop Bearer/token auth on the
// control routes + WS). The gate pins to the server's OWN public origins (its
// devtunnel / mesh URL) plus loopback / private-LAN / AIORDIE_ALLOWED_ORIGINS. It
// must NOT trust a bare *.ts.net / *.devtunnels.ms suffix (shared multi-tenant
// domains any attacker can provision under) nor the client-supplied Host header
// (a DNS-rebinding bypass). These tests lock in that threat model.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { ClaudeCodeWebServer, _isAllowedOrigin } = require('../src/server');

const AUTH_TOKEN = 'control-origin-test-token';
// The server's own pinned public origin (as the tunnel/mesh manager would report).
const PINNED_ORIGIN = 'https://myhost-7777.devtunnels.ms';

function withAllowedOrigins(value, fn) {
  const oldValue = process.env.AIORDIE_ALLOWED_ORIGINS;
  if (value == null) delete process.env.AIORDIE_ALLOWED_ORIGINS;
  else process.env.AIORDIE_ALLOWED_ORIGINS = value;
  try {
    return fn();
  } finally {
    if (oldValue == null) delete process.env.AIORDIE_ALLOWED_ORIGINS;
    else process.env.AIORDIE_ALLOWED_ORIGINS = oldValue;
  }
}

function jsonRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers = Object.assign({}, options.headers || {});
    let payload = null;
    if (Object.prototype.hasOwnProperty.call(options, 'body')) {
      payload = String(options.body);
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers,
      agent: false,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = raw; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Resolves the connected ws on success. On a rejected handshake it rejects with
// the definitive `Unexpected server response: <code>` error the ws client emits —
// a connection TIMEOUT is treated as a distinct failure (NOT a pass), so a server
// that accepts-then-hangs cannot masquerade as "rejected".
function connectWs(port, options = {}) {
  return new Promise((resolve, reject) => {
    const token = options.token == null ? AUTH_TOKEN : options.token;
    const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
    const headers = {};
    if (Object.prototype.hasOwnProperty.call(options, 'origin')) headers.Origin = options.origin;

    const ws = new WebSocket(url, { headers });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch (_) {}
      reject(new Error('WebSocket handshake timed out (server accepted-then-hung, not a clean reject)'));
    }, 5000);

    function settle(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); } catch (_) {}
        reject(err);
      } else {
        resolve(value);
      }
    }

    ws.on('unexpected-response', (_req, res) => {
      settle(new Error(`Unexpected server response: ${res.statusCode}`));
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (err) { return settle(err); }
      if (msg.type === 'connected') settle(null, ws);
    });
    ws.on('error', (err) => settle(err));
    ws.on('close', (code) => settle(new Error(`WebSocket closed before connected (${code})`)));
  });
}

function closeWs(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    try { ws.close(); } catch (_) { return resolve(); }
    setTimeout(() => {
      try { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); } catch (_) {}
      resolve();
    }, 2000);
  });
}

describe('control Origin allowlist helper', function () {
  it('pins to the server\'s own origins and rejects shared-suffix / rebinding / foreign-LAN bypasses', function () {
    withAllowedOrigins(null, () => {
      // The server's live trusted set (what _trustedControlOrigins() returns).
      const trusted = [PINNED_ORIGIN, 'https://mybox.tail-scale.ts.net'];
      // The server's OWN interface addresses (what _ownLanHostnames() returns).
      const ownHosts = new Set(['localhost', '127.0.0.1', '::1', '10.0.0.5', '192.168.1.10', 'fe80::dead']);
      const cases = [
        // (1) No Origin header -> allow (hook / curl / native, server-to-server).
        { name: 'no origin', origin: undefined, expected: true },
        // (2) The server's OWN pinned public origins -> allow (exact match).
        { name: 'own devtunnel origin', origin: PINNED_ORIGIN, expected: true },
        { name: 'own mesh origin', origin: 'https://mybox.tail-scale.ts.net', expected: true },
        { name: 'own origin, trailing FQDN dot', origin: 'https://myhost-7777.devtunnels.ms.', expected: true },
        // CRITICAL #1 — a DIFFERENT tenant under the same shared suffix must be REJECTED.
        { name: 'cross-tenant devtunnel (attacker-provisioned)', origin: 'https://attacker-9999.devtunnels.ms', expected: false },
        { name: 'cross-tenant tailscale', origin: 'https://attacker.ts.net', expected: false },
        { name: 'empty-label .ts.net', origin: 'https://.ts.net', expected: false },
        { name: 'suffix-smuggle host', origin: 'https://evil.devtunnels.ms.attacker.com', expected: false },
        // CRITICAL #2 — Host header is no longer consulted; a rebinding origin is rejected.
        { name: 'DNS-rebinding origin (host no longer trusted)', origin: 'http://evil.com', expected: false },
        // (3) loopback -> allow (literal, always).
        { name: 'localhost', origin: 'http://localhost:3000', expected: true },
        { name: '127.0.0.1', origin: 'http://127.0.0.1:3000', expected: true },
        { name: '[::1]', origin: 'http://[::1]:3000', expected: true },
        // IMPORTANT #2 — the server's OWN LAN IPs are allowed (same-host access)...
        { name: 'own LAN IPv4 (10.0.0.5)', origin: 'http://10.0.0.5:3000', expected: true },
        { name: 'own LAN IPv4 (192.168.1.10)', origin: 'http://192.168.1.10:3000', expected: true },
        { name: 'own LAN IPv6', origin: 'http://[fe80::dead]:3000', expected: true },
        // ...but a DIFFERENT LAN IP an attacker hosts on the same Wi-Fi is REJECTED
        // (no more blanket RFC-1918 trust).
        { name: 'FOREIGN LAN 10.1.2.3 (attacker on same L2)', origin: 'http://10.1.2.3:3000', expected: false },
        { name: 'FOREIGN LAN 172.16.0.1', origin: 'http://172.16.0.1:3000', expected: false },
        { name: 'FOREIGN LAN 192.168.99.99', origin: 'http://192.168.99.99:3000', expected: false },
        { name: 'FOREIGN link-local 169.254.10.20', origin: 'http://169.254.10.20:3000', expected: false },
        // Foreign public origins -> reject.
        { name: 'foreign public origin', origin: 'https://evil.com', expected: false },
        // Malformed / not-an-Origin values -> reject.
        { name: 'userinfo is not a valid Origin', origin: 'https://evil.com@myhost-7777.devtunnels.ms', expected: false },
        { name: 'path is not a valid Origin', origin: 'https://localhost/path', expected: false },
        { name: 'query is not a valid Origin', origin: 'https://localhost?x=1', expected: false },
        { name: 'malformed origin', origin: 'not a url', expected: false },
        { name: 'null origin string', origin: 'null', expected: false },
      ];

      for (const testCase of cases) {
        assert.strictEqual(
          _isAllowedOrigin(testCase.origin, trusted, ownHosts),
          testCase.expected,
          testCase.name
        );
      }

      // Multi-value Origin header array is rejected (length !== 1).
      assert.strictEqual(_isAllowedOrigin(['https://a.com', 'https://b.com'], trusted, ownHosts), false, 'array origin');
      // Empty trusted set: a would-be tunnel origin is rejected until the URL is known.
      assert.strictEqual(_isAllowedOrigin(PINNED_ORIGIN, [], ownHosts), false, 'empty trusted set denies tunnel origin');
      // No ownHosts + no trusted set: only loopback literals + env survive.
      assert.strictEqual(_isAllowedOrigin('http://10.0.0.5:3000', [], undefined), false, 'no ownHosts denies LAN');
    });
  });

  it('reads AIORDIE_ALLOWED_ORIGINS on each call', function () {
    withAllowedOrigins('https://allowed.example:9443, hostonly.example, hostport.example:8080', () => {
      assert.strictEqual(_isAllowedOrigin('https://allowed.example:9443', [], new Set()), true);
      assert.strictEqual(_isAllowedOrigin('https://allowed.example:9444', [], new Set()), false);
      assert.strictEqual(_isAllowedOrigin('https://hostonly.example:9444', [], new Set()), true);
      assert.strictEqual(_isAllowedOrigin('https://hostport.example:8080', [], new Set()), true);
      assert.strictEqual(_isAllowedOrigin('https://hostport.example:9444', [], new Set()), false);
    });
  });
});

describe('control Origin gate on HTTP and WebSocket', function () {
  this.timeout(15000);

  let server;
  let port;
  let tempDir;

  before(async function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiordie-control-origin-'));
    server = new ClaudeCodeWebServer({
      port: 0,
      auth: AUTH_TOKEN,
      sessionStoreOptions: { storageDir: tempDir },
    });
    // Simulate the tunnel having come up: the server now knows its own public
    // origin, exactly as tunnelManager.publicUrl would report it.
    server.setTunnelManager({ publicUrl: PINNED_ORIGIN });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(async function () {
    if (server) await server.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lets a control POST from the server\'s OWN pinned Origin past the gate', async function () {
    const res = await jsonRequest(`http://127.0.0.1:${port}/api/control/sessions/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        Origin: PINNED_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'pinned-origin-ok' }),
    });
    assert.notStrictEqual(res.status, 403, 'own pinned origin must not be origin-forbidden');
    assert.ok(!res.body || !res.body.error || res.body.error.code !== 'ORIGIN_FORBIDDEN');
  });

  it('blocks a cross-tenant .devtunnels.ms Origin on a mutating POST (403)', async function () {
    const res = await jsonRequest(`http://127.0.0.1:${port}/api/control/sessions/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        Origin: 'https://attacker-9999.devtunnels.ms',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'blocked-origin' }),
    });
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(res.body, {
      error: {
        code: 'ORIGIN_FORBIDDEN',
        message: 'Origin is not allowed for this control request',
      },
    });
  });

  it('gates control GET reads too: no-Origin passes, foreign Origin is 403', async function () {
    // no-Origin POST reaches the router (auth + origin passed; session missing -> 404).
    const post = await jsonRequest(`http://127.0.0.1:${port}/api/control/sessions/nope/message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'no-origin-ok' }),
    });
    assert.strictEqual(post.status, 404);
    assert.strictEqual(post.body.error.code, 'SESSION_NOT_FOUND');

    // no-Origin GET reaches the router (server-to-server read).
    const getNoOrigin = await jsonRequest(`http://127.0.0.1:${port}/api/control/sessions`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    assert.strictEqual(getNoOrigin.status, 200);
    assert.ok(Array.isArray(getNoOrigin.body.sessions));

    // Foreign-Origin GET is now origin-gated (403) — closes the cross-origin
    // read/exfil channel for terminal output / history / pending decisions.
    const getForeign = await jsonRequest(`http://127.0.0.1:${port}/api/control/sessions`, {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        Origin: 'https://evil.com',
      },
    });
    assert.strictEqual(getForeign.status, 403);
    assert.strictEqual(getForeign.body.error.code, 'ORIGIN_FORBIDDEN');
  });

  it('rejects a WebSocket upgrade from a foreign Origin (definitive handshake reject, not timeout)', async function () {
    await assert.rejects(
      () => connectWs(port, { origin: 'https://attacker-9999.devtunnels.ms' }),
      /Unexpected server response: 40[13]|closed before connected|socket hang up|ECONNRESET/i
    );
  });

  it('accepts WebSocket upgrades with no Origin or the server\'s own pinned Origin', async function () {
    const noOrigin = await connectWs(port);
    await closeWs(noOrigin);

    const allowedOrigin = await connectWs(port, { origin: PINNED_ORIGIN });
    await closeWs(allowedOrigin);
  });
});
