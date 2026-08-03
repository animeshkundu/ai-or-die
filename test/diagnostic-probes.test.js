'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');
const { deleteSnapshotFile } = require('../src/diagnostic-probes');

function request(port, method, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (_) { /* preserve text */ }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('diagnostic memory probes', function () {
  this.timeout(60000);

  const token = 'diagnostic-test-token-123456789';
  let server;
  let tmpRoot;
  let port;

  async function startWithEnv(env) {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aod-diag-test-'));
    const previous = {};
    for (const [key, value] of Object.entries(env)) {
      previous[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value === '$TMP' ? tmpRoot : value;
    }
    try {
      server = new ClaudeCodeWebServer({
        port: 0,
        noAuth: true,
        stt: false,
        stickyNotes: false,
        keepalive: false,
        sessionStoreOptions: { storageDir: path.join(tmpRoot, 'sessions') },
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const listener = await server.start();
    port = listener.address().port;
  }

  afterEach(async function () {
    if (server) {
      try { await server.close(); } catch (_) {}
    }
    server = null;
    if (tmpRoot) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
    }
    tmpRoot = null;
  });

  it('does not register privileged routes when the enable flag is absent', async function () {
    await startWithEnv({
      AOD_DIAG_ENABLED: undefined,
      AOD_DIAG_TOKEN: token,
      AOD_DIAG_DISABLE_PERSISTENCE: '1',
    });
    const response = await request(port, 'GET', '/api/_diag/counters', {
      headers: { 'x-aod-diag-token': token },
    });
    assert.strictEqual(response.statusCode, 404);
    await server.saveSessionsToDisk(true);
    assert.strictEqual(
      server.sessionStore._diagnostics.save_calls,
      1,
      'the persistence seam must be inert when diagnostics are not registered',
    );
  });

  it('does not register privileged routes when the token is absent', async function () {
    await startWithEnv({
      AOD_DIAG_ENABLED: '1',
      AOD_DIAG_TOKEN: undefined,
    });
    const response = await request(port, 'GET', '/api/_diag/counters');
    assert.strictEqual(response.statusCode, 404);
    await server.saveSessionsToDisk(true);
    assert.strictEqual(server.sessionStore._diagnostics.last_serialized_bytes, 0);
  });

  it('requires a dedicated snapshot directory without disabling other counters', async function () {
    await startWithEnv({
      AOD_DIAG_ENABLED: '1',
      AOD_DIAG_TOKEN: token,
      AOD_DIAG_SNAPSHOT_DIR: undefined,
    });
    const headers = { 'x-aod-diag-token': token };
    const counters = await request(port, 'GET', '/api/_diag/counters', { headers });
    assert.strictEqual(counters.statusCode, 200);
    const snapshot = await request(port, 'POST', '/api/_diag/heapsnapshot', {
      headers,
      body: {},
    });
    assert.strictEqual(snapshot.statusCode, 503);
  });

  it('keeps the persistence suppression seam diagnostic-only', async function () {
    await startWithEnv({
      AOD_DIAG_ENABLED: '1',
      AOD_DIAG_TOKEN: token,
      AOD_DIAG_DISABLE_PERSISTENCE: '1',
    });
    const created = await request(port, 'POST', '/api/sessions/create', {
      body: { name: 'persistence-disabled-probe', workingDir: process.cwd() },
    });
    assert.strictEqual(created.statusCode, 200);
    const counters = await request(port, 'GET', '/api/_diag/counters', {
      headers: { 'x-aod-diag-token': token },
    });
    assert.strictEqual(counters.body.persistence.writes_disabled, true);
    assert.strictEqual(counters.body.persistence.auto_save_ticks, 0);
    assert.strictEqual(counters.body.persistence.save_calls, 0);
  });

  it('deletes a snapshot that would exceed the aggregate artifact byte cap', async function () {
    await startWithEnv({
      AOD_DIAG_ENABLED: '1',
      AOD_DIAG_TOKEN: token,
      AOD_DIAG_SNAPSHOT_DIR: '$TMP',
      AOD_DIAG_SNAPSHOT_BYTES_CAP: '1',
    });
    const response = await request(port, 'POST', '/api/_diag/heapsnapshot', {
      headers: { 'x-aod-diag-token': token },
      body: {},
    });
    assert.strictEqual(response.statusCode, 413);
    assert.strictEqual(
      fs.readdirSync(tmpRoot).some((name) => name.endsWith('.heapsnapshot')),
      false,
    );
  });

  it('surfaces an over-cap snapshot cleanup failure after bounded retries', function () {
    let attempts = 0;
    assert.throws(() => deleteSnapshotFile('/locked.heapsnapshot', {
      unlinkSync() {
        attempts++;
        const error = new Error('locked');
        error.code = 'EBUSY';
        throw error;
      },
      existsSync() { return true; },
    }), (error) => error.code === 'EBUSY');
    assert.strictEqual(attempts, 3);
  });

  it('requires the diagnostic token and exposes ownership counters without changing /api/diagnostics', async function () {
    await startWithEnv({
      AOD_DIAG_ENABLED: '1',
      AOD_DIAG_TOKEN: token,
      AOD_DIAG_SNAPSHOT_DIR: '$TMP',
    });

    const unauthorized = await request(port, 'GET', '/api/_diag/counters', {
      headers: { 'x-aod-diag-token': 'wrong-token-value' },
    });
    assert.strictEqual(unauthorized.statusCode, 401);

    const headers = { 'x-aod-diag-token': token };
    const before = await request(port, 'GET', '/api/_diag/counters', { headers });
    assert.strictEqual(before.statusCode, 200);
    assert.strictEqual(before.body.process.pid, process.pid);
    assert(Array.isArray(before.body.process.heap_spaces));
    assert.strictEqual(before.body.sessions.output_buffers.backing_slots, 0);

    const created = await request(port, 'POST', '/api/sessions/create', {
      body: { name: 'diagnostic-buffer-probe', workingDir: process.cwd() },
    });
    assert.strictEqual(created.statusCode, 200);

    const after = await request(port, 'GET', '/api/_diag/counters', { headers });
    assert.strictEqual(after.statusCode, 200);
    assert.strictEqual(after.body.sessions.total, before.body.sessions.total + 1);
    assert.strictEqual(after.body.sessions.output_buffers.backing_slots, 1000);
    assert(after.body.persistence.save_calls >= 1);

    const ordinary = await request(port, 'GET', '/api/diagnostics');
    assert.strictEqual(ordinary.statusCode, 200);
    assert.strictEqual(ordinary.body.heap_spaces, undefined);
    assert.strictEqual(ordinary.body.snapshot, undefined);
    const ordinaryPost = await request(port, 'POST', '/api/diagnostics');
    assert.strictEqual(ordinaryPost.statusCode, 404);

    const gc = await request(port, 'POST', '/api/_diag/gc', { headers });
    assert.strictEqual(gc.statusCode, typeof global.gc === 'function' ? 200 : 501);

    const traversal = await request(port, 'POST', '/api/_diag/heapsnapshot', {
      headers,
      body: { directory: path.dirname(tmpRoot) },
    });
    assert.strictEqual(traversal.statusCode, 403);

    if (process.platform !== 'win32') {
      const escape = path.join(tmpRoot, 'escape-link');
      fs.symlinkSync(path.dirname(tmpRoot), escape, 'dir');
      const symlinkTraversal = await request(port, 'POST', '/api/_diag/heapsnapshot', {
        headers,
        body: { directory: escape },
      });
      assert.strictEqual(symlinkTraversal.statusCode, 403);
    }
  });
});
