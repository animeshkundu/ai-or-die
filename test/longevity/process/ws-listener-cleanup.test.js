// test/longevity/process/ws-listener-cleanup.test.js
//
// PROC-03 regression test — WebSocket listener cleanup on close.
//
// Memo: docs/audits/proc-ws-listener-cleanup.md
//
// What this proves on main HEAD (failing assertion = unrefactored gap):
//
//   src/server.js:2855–2898 attaches three event listeners on each
//   incoming WebSocket (`message`, `close`, `error`) via `ws.on(...)`.
//   The cleanup path in `cleanupWebSocketConnection` (line 3828) drops
//   the wsInfo from the Map but never explicitly drops the listeners —
//   it relies on GC after Map deletion. Today there is no observed leak,
//   but the pattern departs from the explicit-teardown discipline used
//   for PTY listeners (`_ptyDisposables`, base-bridge.js) and fs-watch
//   sessions (`_cleanupFsWatchSession`, server.js). Defense-in-depth.
//
// Repro: spin up a real ClaudeCodeWebServer on a random port > 11000,
// open a real WebSocket client, let `handleWebSocketConnection` attach
// listeners, then call `cleanupWebSocketConnection(wsId)` directly and
// inspect `ws.listenerCount(...)` on the server-side WS reference.
//
// On main: listenerCount('message') stays ≥ 1 after cleanup. Assertion
// fails.
//
// After fix (one `wsInfo.ws.removeAllListeners()` line in
// `cleanupWebSocketConnection`): listenerCount drops to 0. Assertion
// passes.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

// node-pty may not build on every CI runner — gracefully skip if so.
let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../../../src/server'));
} catch (_) { /* suite will be skipped */ }

// Port floor per CLAUDE.md user memory: tests must use ports > 11000.
// We pick a random high port and let the OS confirm via port:0 — server
// supports it. The literal range 11001-65535 is just a sanity boundary.
function pickPort() {
  return 11000 + 1 + Math.floor(Math.random() * 50000);
}

function waitForConnected(ws, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS connected timeout')), timeoutMs);
    const onMsg = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          clearTimeout(timer);
          ws.removeListener('message', onMsg);
          resolve(msg.connectionId);
        }
      } catch (_) { /* ignore non-JSON */ }
    };
    ws.on('message', onMsg);
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

(ClaudeCodeWebServer ? describe : describe.skip)('PROC-03: WebSocket listener cleanup (defense-in-depth)', function () {
  this.timeout(15000);

  let server, port, tmpDir, origCwd;

  before(async function () {
    // Isolated tmpdir + session-store path so the test does not clobber
    // ~/.ai-or-die/sessions.json on the host machine.
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-03-ws-cleanup-'));
    tmpDir = fs.realpathSync(raw);
    const sessionStoreDir = path.join(tmpDir, '.session-store');
    fs.mkdirSync(sessionStoreDir, { recursive: true });

    origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      // port:0 → OS assigns; we read it after .start() returns. Falls
      // safely above 11000 in practice on every platform we run on; if
      // ever in doubt we pick our own port via pickPort() and retry.
      server = new ClaudeCodeWebServer({
        port: 0,
        noAuth: true,
        sessionStoreOptions: { storageDir: sessionStoreDir },
      });
      const httpServer = await server.start();
      port = httpServer.address().port;
      // Sanity — flag if for any reason we landed in the protected range.
      // We do NOT abort: port:0 is a kernel pick, not a literal binding.
      if (port <= 11000) {
        // Re-bind on a literal port > 11000 to honor the convention.
        await server.close();
        const newPort = pickPort();
        server = new ClaudeCodeWebServer({
          port: newPort,
          noAuth: true,
          sessionStoreOptions: { storageDir: sessionStoreDir },
        });
        await server.start();
        port = newPort;
      }
    } finally {
      process.chdir(origCwd);
    }
  });

  after(async function () {
    if (server) {
      try { await server.close(); } catch (_) {}
    }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('cleanupWebSocketConnection drops every ws.on(...) handler attached by handleWebSocketConnection', async function () {
    // 1. Open a real WS client — exercises the real handshake path so
    // handleWebSocketConnection runs and attaches its three listeners.
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const wsId = await waitForConnected(client);

    // 2. Look up the server-side wsInfo. The Map entry is keyed by the
    // wsId the server generated and broadcast via the 'connected'
    // message, so we can locate the same wsInfo deterministically.
    const wsInfo = server.webSocketConnections.get(wsId);
    assert.ok(wsInfo, 'server should have a wsInfo entry for the live connection');
    const serverWs = wsInfo.ws;
    assert.ok(serverWs, 'wsInfo.ws should be the server-side WebSocket reference');

    // 3. Sanity-check baseline: handleWebSocketConnection attached
    // message/close/error. Each should have at least one listener.
    // (If this assertion ever fails, the production attachment path
    // changed and the rest of this test is meaningless — fail loud.)
    assert.ok(
      serverWs.listenerCount('message') >= 1,
      'pre-cleanup: expected ≥ 1 message listener (production code attaches one in handleWebSocketConnection)'
    );
    assert.ok(
      serverWs.listenerCount('close') >= 1,
      'pre-cleanup: expected ≥ 1 close listener (production code attaches one in handleWebSocketConnection)'
    );
    assert.ok(
      serverWs.listenerCount('error') >= 1,
      'pre-cleanup: expected ≥ 1 error listener (production code attaches one in handleWebSocketConnection)'
    );

    // 4. Drive the cleanup path directly. We don't close the client first
    // because we need to inspect listenerCount AFTER cleanup runs but
    // BEFORE the underlying ws is torn down by the close handshake —
    // otherwise GC + the ws library's own internal teardown muddles the
    // signal we're trying to measure (cleanup's own listener drop).
    server.cleanupWebSocketConnection(wsId);

    // 5. THE assertion this test exists for. Pre-fix this fails (GC
    // hasn't run; listenerCount is unchanged from pre-cleanup).
    // Post-fix (`ws.removeAllListeners()` inside cleanupWebSocketConnection)
    // these are zero immediately.
    assert.strictEqual(
      serverWs.listenerCount('message'), 0,
      'PROC-03: cleanupWebSocketConnection must drop the message listener — ' +
      'see docs/audits/proc-ws-listener-cleanup.md'
    );
    assert.strictEqual(
      serverWs.listenerCount('close'), 0,
      'PROC-03: cleanupWebSocketConnection must drop the close listener — ' +
      'see docs/audits/proc-ws-listener-cleanup.md'
    );
    assert.strictEqual(
      serverWs.listenerCount('error'), 0,
      'PROC-03: cleanupWebSocketConnection must drop the error listener — ' +
      'see docs/audits/proc-ws-listener-cleanup.md'
    );

    // 6. The Map entry itself must also be gone (sanity — already
    // tested by fs-watch-cleanup.test.js's sister assertions, but
    // verifying it here costs nothing).
    assert.strictEqual(
      server.webSocketConnections.has(wsId), false,
      'wsInfo Map entry should be deleted by cleanup'
    );

    // 7. Tidy up the client side. Cleanup ran server-side; the client
    // socket is unaware until the kernel notices the FIN — close it
    // explicitly so the test does not leak its end of the connection.
    try { client.close(); } catch (_) {}
    await new Promise((resolve) => {
      // Give the client up to 1s to observe the close; don't block the
      // test on it (it's already torn down server-side).
      const t = setTimeout(resolve, 1000);
      client.once('close', () => { clearTimeout(t); resolve(); });
    });
  });

  it('cleanupWebSocketConnection is idempotent and never throws on double-call', function () {
    // Mirrors the safety-net we depend on in production: cleanup is
    // invoked from BOTH ws.on('close') and ws.on('error'), so it can
    // legitimately run twice for the same wsId in rapid succession.
    // The second call must return early on `!wsInfo` and never throw.
    const fakeWsId = 'nonexistent-wsid-' + Date.now();
    assert.doesNotThrow(() => server.cleanupWebSocketConnection(fakeWsId));
    assert.doesNotThrow(() => server.cleanupWebSocketConnection(fakeWsId));
  });
});
