// test/fs-watch-cleanup.test.js
//
// Regression test for the PR #99 fs-watch leak. The server kept an entry
// in `_fsWatchSessions` for every open SSE EventSource, but only removed
// it when the SSE itself closed via req.on('close'). If the parent
// session was DELETEd, EVICTEDd (>7d), or the server shut down, the
// chokidar watcher carried on — each leaking ~10 inotify watches plus
// an open TCP connection, eventually exhausting the per-process FD limit
// on Windows-primary production (the server appeared to hang on browser
// refresh because EMFILE blocked new accept()s).
//
// Tests:
//   1. DELETE /api/sessions/:id cleans up the watcher entry.
//   2. _cleanupFsWatchSession is idempotent.
//   3. _voiceUploadCounts.delete fires on DELETE.
//   4. server.close() cleans up all live watchers.
//   5. Eviction-sweep path cleans up the watcher entry.
//   6. Race guard: opening a watcher for a non-existent sessionId bails
//      without leaving an orphan map entry.
//
// Windows-first: tmp dir canonicalized via fs.realpathSync to match the
// server's baseFolder canonicalization (see CLAUDE.md rule #3).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../src/server'));
} catch (e) {
  // node-pty not available locally — suite will be skipped.
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from file-browser-api.test.js — kept inline so this
// file stays self-contained and can move/run in isolation)
// ---------------------------------------------------------------------------

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port: port, path: urlPath, method: method, headers: {},
    };
    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed;
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { parsed = JSON.parse(raw.toString('utf-8')); } catch { parsed = raw.toString('utf-8'); }
        } else {
          parsed = raw;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(payload);
    }
    req.end();
  });
}

function encodeParam(val) { return encodeURIComponent(val); }

/** Open SSE, wait for {type:'start'}, return the live request handle. */
function openSseAndWaitForStart(port, sessionId, watchRoot, timeoutMs) {
  timeoutMs = timeoutMs || 3000;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: port,
      path: `/api/files/watch?session=${encodeParam(sessionId)}&path=${encodeParam(watchRoot)}`,
      method: 'GET', headers: { 'Accept': 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body; try { body = JSON.parse(raw); } catch (_) { body = raw; }
          resolve({ status: res.statusCode, body, request: req, events: [] });
        });
        return;
      }
      let buf = '';
      const events = [];
      let started = false;
      const t = setTimeout(() => {
        if (!started) {
          try { req.destroy(); } catch (_) {}
          reject(new Error('SSE start timeout after ' + timeoutMs + 'ms'));
        }
      }, timeoutMs);
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        buf += chunk;
        let sep;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLines = frame.split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.replace(/^data:\s?/, ''));
          if (!dataLines.length) continue;
          try {
            const evt = JSON.parse(dataLines.join('\n'));
            events.push(evt);
            if (evt.type === 'start' && !started) {
              started = true;
              clearTimeout(t);
              resolve({ status: 200, request: req, response: res, events: events });
            }
          } catch (_) {}
        }
      });
      res.on('error', (err) => { if (!started) { clearTimeout(t); reject(err); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

(ClaudeCodeWebServer ? describe : describe.skip)('fs-watch session cleanup (PR #99 leak)', function () {
  this.timeout(30000);

  let server, port, tmpDir;

  // Drive chokidar in polling mode for deterministic tests — same config
  // the watcher tests in file-browser-api.test.js use. Without these,
  // FSEvents/inotify timing makes the watcher's `start` event race the
  // SSE handshake on slower CI runners.
  const _origStability = process.env.FS_WATCHER_STABILITY_MS;
  const _origPolling = process.env.FS_WATCHER_USE_POLLING;

  before(async function () {
    this.timeout(30000);
    process.env.FS_WATCHER_STABILITY_MS = '0';
    process.env.FS_WATCHER_USE_POLLING = '1';

    // Canonicalize the tmp path — Windows + macOS both have non-canonical
    // tmp roots that the server's baseFolder canonicalization will resolve
    // to a different string, breaking validatePath comparisons.
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-watch-clean-'));
    tmpDir = fs.realpathSync(raw);

    // Isolated session-store path so the test does NOT clobber the user's
    // real ~/.ai-or-die/sessions.json (which existing watcher tests in
    // file-browser-api.test.js happen to accidentally write to — a
    // separate issue, but not one this test should reproduce).
    const sessionStoreDir = path.join(tmpDir, '.session-store');
    fs.mkdirSync(sessionStoreDir, { recursive: true });

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    server = new ClaudeCodeWebServer({
      port: 0,
      noAuth: true,
      sessionStoreOptions: { storageDir: sessionStoreDir },
    });
    const httpServer = await server.start();
    port = httpServer.address().port;
    process.chdir(origCwd);
  });

  after(async function () {
    if (server) {
      try { await server.close(); } catch (_) {}
    }
    if (_origStability === undefined) delete process.env.FS_WATCHER_STABILITY_MS;
    else process.env.FS_WATCHER_STABILITY_MS = _origStability;
    if (_origPolling === undefined) delete process.env.FS_WATCHER_USE_POLLING;
    else process.env.FS_WATCHER_USE_POLLING = _origPolling;
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // Clean watcher state between tests so a leaked counter from one
  // assertion does not poison the next.
  beforeEach(async function () {
    if (server && server._activeWatchersByIp) server._activeWatchersByIp.clear();
    if (server && server._fsWatchSessions) {
      const closes = [];
      for (const entry of server._fsWatchSessions.values()) {
        if (entry && entry.watcher && typeof entry.watcher.close === 'function') {
          closes.push(entry.watcher.close().catch(() => {}));
        }
        try { entry.cleanup && entry.cleanup('test-reset'); } catch (_) {}
      }
      server._fsWatchSessions.clear();
      await Promise.all(closes);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // Test 1: DELETE /api/sessions/:id closes the watcher + drops the entry
  // ───────────────────────────────────────────────────────────────────
  it('DELETE /api/sessions/:id cleans up the fs-watch entry (leak regression)', async function () {
    const created = await request(port, 'POST', '/api/sessions/create', {
      name: 'leak-test', workingDir: tmpDir,
    });
    assert.strictEqual(created.status, 200, 'expected 200 on session create');
    const sessionId = created.body.sessionId;

    const sse = await openSseAndWaitForStart(port, sessionId, tmpDir);
    assert.strictEqual(sse.status, 200, 'expected SSE to start (race guard pass)');

    // Pre-condition: entry registered, watcher live.
    const entryBefore = server._fsWatchSessions.get(sessionId);
    assert.ok(entryBefore, '_fsWatchSessions should have an entry for the session');
    assert.ok(entryBefore.watcher, 'entry should carry a chokidar watcher reference');
    const watcherRef = entryBefore.watcher;
    assert.strictEqual(watcherRef._isClosed, false, 'watcher must be live before DELETE');

    // DELETE the session via REST.
    const del = await request(port, 'DELETE', '/api/sessions/' + sessionId);
    assert.strictEqual(del.status, 200, 'expected 200 on delete');

    // Post-condition: entry gone, watcher closed.
    assert.strictEqual(server._fsWatchSessions.has(sessionId), false,
      '_fsWatchSessions must not contain the entry after DELETE (this is the leak)');
    // Give chokidar a tick to flip _closed (close() is async fire-and-forget).
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(watcherRef._isClosed, true,
      'chokidar watcher must be closed after DELETE — otherwise inotify watches leak');

    // SSE request handle should be ended.
    try { sse.request.destroy(); } catch (_) {}
  });

  // ───────────────────────────────────────────────────────────────────
  // Test 2: idempotency — second call is a no-op
  // ───────────────────────────────────────────────────────────────────
  it('_cleanupFsWatchSession is idempotent (second call returns false)', async function () {
    const created = await request(port, 'POST', '/api/sessions/create', {
      name: 'idem-test', workingDir: tmpDir,
    });
    const sessionId = created.body.sessionId;
    const sse = await openSseAndWaitForStart(port, sessionId, tmpDir);
    assert.strictEqual(sse.status, 200);

    const first = server._cleanupFsWatchSession(sessionId, 'unit-test-first');
    assert.strictEqual(first, true, 'first cleanup should return true (entry existed)');

    const second = server._cleanupFsWatchSession(sessionId, 'unit-test-second');
    assert.strictEqual(second, false, 'second cleanup should return false (already cleaned)');

    // Unknown session id never inserted → also false.
    const ghost = server._cleanupFsWatchSession('ghost-' + Date.now(), 'unit-test-ghost');
    assert.strictEqual(ghost, false);

    try { sse.request.destroy(); } catch (_) {}
    // Tidy the orphan session so it doesn't bleed into other tests.
    await request(port, 'DELETE', '/api/sessions/' + sessionId);
  });

  // ───────────────────────────────────────────────────────────────────
  // Test 3: _voiceUploadCounts also drops on DELETE
  // ───────────────────────────────────────────────────────────────────
  it('DELETE /api/sessions/:id clears _voiceUploadCounts (smaller cousin leak)', async function () {
    const created = await request(port, 'POST', '/api/sessions/create', {
      name: 'voice-test', workingDir: tmpDir,
    });
    const sessionId = created.body.sessionId;

    // Populate the voice-upload bucket directly (the rate-limiter helper
    // is internal; we just need the Map entry).
    server._voiceUploadCounts.set(sessionId, [Date.now(), Date.now()]);
    assert.strictEqual(server._voiceUploadCounts.has(sessionId), true,
      'pre-condition: voice bucket present');

    const del = await request(port, 'DELETE', '/api/sessions/' + sessionId);
    assert.strictEqual(del.status, 200);

    assert.strictEqual(server._voiceUploadCounts.has(sessionId), false,
      '_voiceUploadCounts must be cleared on session delete');
  });

  // ───────────────────────────────────────────────────────────────────
  // Test 4: server.close() cleans up all live watchers
  //
  // Spawn a SECOND server (separate port) so closing it does not
  // tear down the shared `server` instance used by every other test.
  // ───────────────────────────────────────────────────────────────────
  it('server.close() tears down every live fs-watch entry', async function () {
    const tmp2Raw = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-watch-close-'));
    const tmp2 = fs.realpathSync(tmp2Raw);
    const sessionStoreDir2 = path.join(tmp2, '.session-store');
    fs.mkdirSync(sessionStoreDir2, { recursive: true });

    const origCwd = process.cwd();
    process.chdir(tmp2);
    const srv2 = new ClaudeCodeWebServer({
      port: 0,
      noAuth: true,
      sessionStoreOptions: { storageDir: sessionStoreDir2 },
    });
    const httpServer2 = await srv2.start();
    const port2 = httpServer2.address().port;
    process.chdir(origCwd);

    try {
      const s1 = await request(port2, 'POST', '/api/sessions/create', { name: 'close-A', workingDir: tmp2 });
      const s2 = await request(port2, 'POST', '/api/sessions/create', { name: 'close-B', workingDir: tmp2 });
      const sid1 = s1.body.sessionId;
      const sid2 = s2.body.sessionId;

      const sse1 = await openSseAndWaitForStart(port2, sid1, tmp2);
      const sse2 = await openSseAndWaitForStart(port2, sid2, tmp2);
      assert.strictEqual(sse1.status, 200);
      assert.strictEqual(sse2.status, 200);
      const w1 = srv2._fsWatchSessions.get(sid1).watcher;
      const w2 = srv2._fsWatchSessions.get(sid2).watcher;
      assert.strictEqual(w1._isClosed, false);
      assert.strictEqual(w2._isClosed, false);

      // Close the server. Both watchers must shut down + the map empty.
      await srv2.close();

      assert.strictEqual(srv2._fsWatchSessions.size, 0,
        'close() must empty _fsWatchSessions (leak: server-shutdown leaves watchers)');
      // Give chokidar a tick to flip _closed.
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(w1._isClosed, true, 'watcher 1 must be closed by server.close()');
      assert.strictEqual(w2._isClosed, true, 'watcher 2 must be closed by server.close()');

      try { sse1.request.destroy(); } catch (_) {}
      try { sse2.request.destroy(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // Test 5: eviction-sweep path also cleans the watcher entry
  //
  // The 7-day eviction timer fires every 5 min — too slow for a test.
  // Inline the same cleanup contract the timer body uses (verifying the
  // load-bearing call: _cleanupFsWatchSession + _voiceUploadCounts.delete
  // BEFORE claudeSessions.delete).
  // ───────────────────────────────────────────────────────────────────
  it('eviction-equivalent cleanup also closes the watcher + clears voice map', async function () {
    const created = await request(port, 'POST', '/api/sessions/create', {
      name: 'evict-test', workingDir: tmpDir,
    });
    const sessionId = created.body.sessionId;
    const sse = await openSseAndWaitForStart(port, sessionId, tmpDir);
    assert.strictEqual(sse.status, 200);
    server._voiceUploadCounts.set(sessionId, [Date.now()]);

    const watcherRef = server._fsWatchSessions.get(sessionId).watcher;
    assert.strictEqual(watcherRef._isClosed, false);

    // Simulate the timer body — the same cleanup contract DELETE uses.
    server._cleanupFsWatchSession(sessionId, 'session_evicted');
    server._voiceUploadCounts.delete(sessionId);
    server.claudeSessions.delete(sessionId);

    assert.strictEqual(server._fsWatchSessions.has(sessionId), false,
      'eviction cleanup must drop the fs-watch entry');
    assert.strictEqual(server._voiceUploadCounts.has(sessionId), false,
      'eviction cleanup must drop the voice-upload bucket');
    assert.strictEqual(server.claudeSessions.has(sessionId), false,
      'eviction cleanup must drop the session itself');

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(watcherRef._isClosed, true,
      'chokidar watcher must close on eviction (same leak as DELETE)');

    try { sse.request.destroy(); } catch (_) {}
  });

  // ───────────────────────────────────────────────────────────────────
  // Test 6: race guard — watcher opens for a non-existent session bail
  //
  // This guarantees the invariant that EVERY entry in _fsWatchSessions
  // corresponds to a live claudeSession, so cleanup-on-delete actually
  // covers all watchers.
  //
  // Load-bearing assertions:
  //   - no orphan map entry (the leak vector)
  //   - per-IP counter is NOT stranded (the cap-exhaustion vector)
  //   - the request received 200-SSE then an {type:'end', reason:
  //     'session_missing'} (proves the guard path executed, not some
  //     other early exit)
  // ───────────────────────────────────────────────────────────────────
  it('race guard: SSE for unknown sessionId leaves no orphan entry or counter drift', async function () {
    const ghostId = 'never-created-' + Date.now();
    // Pre-condition: not in claudeSessions.
    assert.strictEqual(server.claudeSessions.has(ghostId), false);
    const ipBefore = (server._activeWatchersByIp &&
      (server._activeWatchersByIp.get('127.0.0.1') ||
       server._activeWatchersByIp.get('::ffff:127.0.0.1') ||
       server._activeWatchersByIp.get('::1') || 0)) || 0;

    // Open SSE directly so we can drain the body and witness the
    // {type:'end', reason:'session_missing'} the guard sends BEFORE
    // ending the response. This is the load-bearing proof that the
    // guard path (and only that path) ran.
    const sseEndedWithReason = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: port,
        path: `/api/files/watch?session=${encodeParam(ghostId)}&path=${encodeParam(tmpDir)}`,
        method: 'GET', headers: { 'Accept': 'text/event-stream' },
      }, (res) => {
        if (res.statusCode !== 200) {
          resolve({ status: res.statusCode, reason: null });
          return;
        }
        let buf = '';
        const events = [];
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          buf += chunk;
          let sep;
          while ((sep = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLines = frame.split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.replace(/^data:\s?/, ''));
            if (!dataLines.length) continue;
            try { events.push(JSON.parse(dataLines.join('\n'))); } catch (_) {}
          }
        });
        res.on('end', () => {
          const end = events.find((e) => e.type === 'end');
          resolve({ status: 200, reason: end && end.reason, events: events });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });

    // 1. No orphan entry in _fsWatchSessions (the leak vector).
    assert.strictEqual(server._fsWatchSessions.has(ghostId), false,
      'orphan watcher must NOT be registered (race guard breach)');

    // 2. The guard fired — we got {type:'end', reason:'session_missing'}.
    //    Without the guard, the SSE would emit {type:'start'} instead.
    assert.strictEqual(sseEndedWithReason.status, 200,
      'route should reach SSE 200 before the guard fires');
    assert.strictEqual(sseEndedWithReason.reason, 'session_missing',
      'guard path must emit end-event with reason=session_missing; got ' +
      JSON.stringify(sseEndedWithReason));

    // 3. Per-IP counter must not leak (otherwise a few orphan opens
    //    eat all 5 slots and legitimate clients can't open watchers).
    const ipAfter = (server._activeWatchersByIp &&
      (server._activeWatchersByIp.get('127.0.0.1') ||
       server._activeWatchersByIp.get('::ffff:127.0.0.1') ||
       server._activeWatchersByIp.get('::1') || 0)) || 0;
    assert.strictEqual(ipAfter, ipBefore,
      'per-IP watcher counter leaked on race-guard path: ' +
      ipBefore + ' → ' + ipAfter);
  });
});
