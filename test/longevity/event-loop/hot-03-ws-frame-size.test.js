// test/longevity/event-loop/hot-03-ws-frame-size.test.js
//
// HOT-03 regression test — WebSocket binary frame parse without size guard
//
// Memo: docs/audits/hot-03-ws-frame-size.md
//
// What this proves on main HEAD (failing assertion = real bug):
//
//   The WebSocket message handler in src/server.js:2855–2884 calls
//   JSON.parse(message) with no application-level size check. The ws
//   library's protocol-layer maxPayload is 8 MB, so any frame up to
//   8 MB reaches our handler and gets parsed inline. JSON.parse of a
//   5 MB string blocks the event loop for tens-to-hundreds of ms.
//
// Repro: boot the real server on a port > 11000, connect a real ws
// client, send a 5 MB JSON message, then immediately send a small
// ping-style probe. Assert that the server responds to the oversize
// frame with a marker error code (`message_too_large`).
//
// On main:
//   • No server-side size check → JSON.parse runs unbounded.
//   • No `error/message_too_large` response is emitted.
//   ⇒ assertion fails.
//
// After the proposed fix (size guard + close 1009 — see memo §Proposed fix):
//   • Server checks Buffer.byteLength(message) > MAX_WS_MESSAGE_BYTES
//     before parsing.
//   • Replies with {type:'error', code:'message_too_large', ...}.
//   ⇒ assertion passes.

'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

const { ClaudeCodeWebServer } = require('../../../src/server');

function waitForOpen(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), timeoutMs);
    ws.once('open', () => { clearTimeout(t); resolve(); });
    ws.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// Buffer all message frames from connection time onwards. Frames may
// arrive between the WS 'open' event and a later .on('message', ...)
// listener attachment — buffering from t=0 closes that race.
function bufferMessages(ws) {
  const buf = [];
  const waiters = [];
  ws.on('message', (raw) => {
    let parsed;
    try { parsed = JSON.parse(raw.toString()); } catch (_) { return; }
    buf.push(parsed);
    // Snapshot+filter so a waiter promise-resolves at most once.
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.predicate(parsed)) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(parsed);
      }
    }
  });
  return {
    waitFor(predicate, timeoutMs = 4000) {
      // Replay buffered frames first.
      for (const m of buf) if (predicate(m)) return Promise.resolve(m);
      return new Promise((resolve, reject) => {
        const w = { predicate, resolve, reject, timer: null };
        w.timer = setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`timeout waiting for predicate-matching frame (${timeoutMs} ms)`));
        }, timeoutMs);
        waiters.push(w);
      });
    },
  };
}

describe('HOT-03: WebSocket binary frame parse without size guard', function () {
  this.timeout(30000);

  let server;
  let port;
  let prevSessionDir;
  let tmpSessionDir;

  beforeEach(async () => {
    // Isolate ~/.ai-or-die/sessions.json so the test doesn't clobber a
    // dev box's real session store.
    tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot03-ws-'));
    prevSessionDir = process.env.AI_OR_DIE_SESSION_DIR;
    process.env.AI_OR_DIE_SESSION_DIR = tmpSessionDir;

    // Random port > 11000 per CLAUDE.md memory (never 7777).
    port = 11000 + Math.floor(Math.random() * 30000);

    server = new ClaudeCodeWebServer({
      port,
      noAuth: true,
      // Folder mode off so start() doesn't expect a folder pick.
      folderMode: false,
      dev: false,
    });

    await server.start();
  });

  afterEach(async () => {
    try { await server.close(); } catch (_) {}
    if (prevSessionDir == null) delete process.env.AI_OR_DIE_SESSION_DIR;
    else process.env.AI_OR_DIE_SESSION_DIR = prevSessionDir;
    try { fs.rmSync(tmpSessionDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('rejects oversized WebSocket frames with a message_too_large error', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const mbox = bufferMessages(ws);
    await waitForOpen(ws);

    // Drain the initial {type:'connected', connectionId} frame.
    await mbox.waitFor((m) => m.type === 'connected', 5000);

    // Build a 5 MB JSON payload. Use a single large string field — that
    // is the cheapest shape for V8 to parse but still imposes ~5 MB of
    // buffer-→-string-→-object allocations.
    const FILLER = 'x'.repeat(5 * 1024 * 1024); // 5 MB
    const oversizeFrame = JSON.stringify({ type: 'input', data: FILLER });

    // Race conditions: server may either emit an error frame (preferred —
    // explicit, debuggable) OR close with ws-standard 1009 (acceptable —
    // RFC 6455 close code for "message too big"). The fix may pick either.
    const ERROR_DEADLINE_MS = 8000;
    const errorPromise = mbox
      .waitFor((m) => m.type === 'error' && m.code === 'message_too_large', ERROR_DEADLINE_MS)
      .then((m) => ({ kind: 'error_frame', frame: m }))
      .catch(() => null);
    const closePromise = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ERROR_DEADLINE_MS);
      ws.once('close', (code) => { clearTimeout(t); resolve({ kind: 'closed', code }); });
    });

    ws.send(oversizeFrame);

    const [errorOutcome, closeOutcome] = await Promise.all([errorPromise, closePromise]);
    const outcome = errorOutcome || closeOutcome;

    assert.ok(
      outcome != null,
      `${ERROR_DEADLINE_MS} ms elapsed without server-emitted ` +
      "{type:'error', code:'message_too_large'} response AND without " +
      'ws-standard 1009 close — no application-layer size guard on the ' +
      'WS message handler (see docs/audits/hot-03-ws-frame-size.md)'
    );

    if (outcome.kind === 'error_frame') {
      assert.strictEqual(outcome.frame.type, 'error');
      assert.strictEqual(outcome.frame.code, 'message_too_large',
        `expected error.code = 'message_too_large'; got ${outcome.frame.code}`);
    } else {
      assert.strictEqual(outcome.code, 1009,
        `expected ws-standard close 1009 ("message too big"); got ${outcome.code}`);
    }

    try { ws.terminate(); } catch (_) {}
  });
});
