'use strict';

// HTTPS auto-upgrade: when the server runs with --https, the single listening
// port serves TLS normally AND redirects plaintext HTTP requests to https (so a
// user who reaches http://host:PORT is upgraded instead of getting an opaque
// TLS-handshake error). Verified end to end: plaintext HTTP -> 307, real HTTPS
// still works, and wss:// upgrades still complete through the sniffer.

const assert = require('assert');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const { ClaudeCodeWebServer } = require('../src/server');

function httpGet(opts) {
  return new Promise((resolve, reject) => {
    const req = http.get(opts, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
  });
}

// http GET with an explicit (possibly hostile) Host header.
function httpGetWithHost(hostHeader, port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        res.resume();
        resolve({ statusCode: res.statusCode, headers: res.headers });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
    req.end();
  });
}

function httpsGet(opts) {
  return new Promise((resolve, reject) => {
    const req = https.get(Object.assign({ rejectUnauthorized: false }, opts), (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('https timeout')));
  });
}

describe('https auto-upgrade: http on the tls port redirects to https', function () {
  this.timeout(30000);

  let server;
  let port;
  let tmpDir;
  let certPath;
  let keyPath;

  before(async function () {
    // Throwaway self-signed cert written to a temp dir (NOT ~/.ai-or-die) so the
    // test never touches the user's real cert cache.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'https-upgrade-'));
    const pems = selfsigned.generate(
      [{ name: 'commonName', value: 'test-localhost' }],
      {
        keySize: 2048,
        days: 1,
        algorithm: 'sha256',
        extensions: [{
          name: 'subjectAltName',
          altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }],
        }],
      }
    );
    certPath = path.join(tmpDir, 'test.cert');
    keyPath = path.join(tmpDir, 'test.key');
    fs.writeFileSync(certPath, pems.cert);
    fs.writeFileSync(keyPath, pems.private);

    server = new ClaudeCodeWebServer({
      port: 0,
      noAuth: true,
      https: true,
      cert: certPath,
      key: keyPath,
    });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    try { server.close(); } catch (_) { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  it('redirects a plaintext HTTP request to https on the same port (307)', async function () {
    const res = await httpGet({ host: '127.0.0.1', port, path: '/api/config' });
    assert.strictEqual(res.statusCode, 307, `expected 307, got ${res.statusCode}`);
    assert.strictEqual(
      res.headers.location,
      `https://127.0.0.1:${port}/api/config`,
      `unexpected Location: ${res.headers.location}`
    );
  });

  it('preserves the request path + query in the redirect', async function () {
    const res = await httpGet({ host: '127.0.0.1', port, path: '/foo/bar?x=1&y=2' });
    assert.strictEqual(res.statusCode, 307);
    assert.strictEqual(res.headers.location, `https://127.0.0.1:${port}/foo/bar?x=1&y=2`);
  });

  it('does not honor a hostile Host header (no open redirect)', async function () {
    const res = await httpGetWithHost('user:pass@evil.com', port);
    assert.strictEqual(res.statusCode, 307);
    assert.ok(!/evil\.com/.test(res.headers.location || ''),
      `open redirect leaked off-origin: ${res.headers.location}`);
    assert.ok((res.headers.location || '').startsWith(`https://localhost:${port}`),
      `expected localhost fallback, got: ${res.headers.location}`);
  });

  it('still serves real HTTPS on the same port', async function () {
    const res = await httpsGet({ host: '127.0.0.1', port, path: '/api/config' });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert(body.voiceInput, 'expected a real config response over TLS');
  });

  it('still completes a wss:// WebSocket upgrade over TLS', async function () {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/`, { rejectUnauthorized: false });
    const connected = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('wss connect timeout')), 5000);
      ws.on('open', () => {
        ws.once('message', (raw) => {
          clearTimeout(t);
          try { resolve(JSON.parse(raw.toString())); } catch (e) { reject(e); }
        });
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });
    assert.strictEqual(connected.type, 'connected', 'expected the connected frame over wss');
    ws.close();
  });
});
