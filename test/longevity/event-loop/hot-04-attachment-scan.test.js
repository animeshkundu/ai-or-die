// test/longevity/event-loop/hot-04-attachment-scan.test.js
//
// HOT-04 regression test — attachment dir scan on every upload
//
// Memo: docs/audits/hot-04-attachment-scan.md
//
// What this proves on main HEAD (failing assertion = real bug):
//
//   _attachmentDirBytes (src/server.js:553-574) does readdirSync +
//   statSync-per-entry on every call. The upload handler calls it on
//   every POST to /api/files/upload that targets a .claude-attachments/
//   dir. No caching — N files → N statSyncs every time. On a slow share
//   (network home, SMB/NFS) each statSync is a round-trip, so a
//   1000-file dir → 5-20 seconds of pure sync I/O per upload.
//
// Repro: instantiate the server, preload a tmp .claude-attachments dir
// with 500 small files, wrap fs.statSync with a 1ms busy-wait (network
// share proxy) that counts calls, call _attachmentDirBytes 10 times,
// measure call count and event-loop max lag.
//
// On main:
//   • statSync called 500 * 10 = 5000 times (no cache).
//   • h.max ≥ 500ms (10 × 500ms busy-wait, bunched).
//   ⇒ both assertions fail.
//
// After the proposed fix (cached (bytes, mtimeMs) pair, refresh only on
// mtime advance — see memo §Proposed fix):
//   • statSync called ≤ 1000 (first scan populates + 10 dir-stats).
//     The fix may also fold the dir-stat into the upload path, in which
//     case ≤ 500 + 10 = 510.
//   • h.max < 50ms (no bunched I/O on the hot path after cache warmup).
//   ⇒ both assertions pass.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const { ClaudeCodeWebServer } = require('../../../src/server');

function busyWait(ms) {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) { /* spin */ }
}

describe('HOT-04: attachment dir scan on every upload (event-loop hot path)', function () {
  this.timeout(60000);

  let server;
  let tmpRoot;
  let attachmentsDir;
  let origStatSync;
  let statCount;
  let prevSessionDir;
  let tmpSessionDir;

  beforeEach(() => {
    // Isolate session store.
    tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot04-sess-'));
    prevSessionDir = process.env.AI_OR_DIE_SESSION_DIR;
    process.env.AI_OR_DIE_SESSION_DIR = tmpSessionDir;

    // Construct without starting — _attachmentDirBytes is an instance
    // method that doesn't need the http server to be running.
    server = new ClaudeCodeWebServer({
      port: 11000 + Math.floor(Math.random() * 30000),
      noAuth: true,
      folderMode: false,
      dev: false,
    });

    // Preload a .claude-attachments/ with 500 small files. Each file is
    // 32 bytes; the per-file SIZE doesn't matter for the test — only the
    // PER-FILE STAT COST does (which is what the fix eliminates).
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hot04-att-')));
    attachmentsDir = path.join(tmpRoot, '.claude-attachments');
    fs.mkdirSync(attachmentsDir);
    const data = Buffer.alloc(32, 'x');
    for (let i = 0; i < 500; i++) {
      fs.writeFileSync(path.join(attachmentsDir, `f${i}.bin`), data);
    }

    // Stub fs.statSync — only for paths inside our tmp dir. Pages of
    // mocha internals, node module loads, etc. must pass through.
    statCount = 0;
    origStatSync = fs.statSync;
    fs.statSync = function patchedStatSync(p, ...rest) {
      if (typeof p === 'string' && p.startsWith(tmpRoot)) {
        statCount++;
        busyWait(1); // network-share RTT proxy
      }
      return origStatSync.call(this, p, ...rest);
    };
  });

  afterEach(() => {
    fs.statSync = origStatSync;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    if (prevSessionDir == null) delete process.env.AI_OR_DIE_SESSION_DIR;
    else process.env.AI_OR_DIE_SESSION_DIR = prevSessionDir;
    try { fs.rmSync(tmpSessionDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('caps statSync calls under repeated _attachmentDirBytes invocations on an unchanged dir', () => {
    // Sanity: a single call on a 500-file dir is 1 readdir + 500 stats.
    // After warmup, subsequent calls on an unchanged dir should be 0
    // additional stats (cached) OR at most 1 dir-stat for freshness
    // check.
    statCount = 0;
    for (let i = 0; i < 10; i++) {
      const bytes = server._attachmentDirBytes(attachmentsDir);
      assert.ok(bytes > 0, `call ${i + 1}: expected positive byte count`);
    }
    // On main (no cache): 10 × 500 = 5000 calls.
    // After fix (cache + mtime guard): first call ~500 to populate;
    // subsequent 9 calls add at most 9 dir-stats (or 0 if eager-update
    // path is used). Slack: ≤ 1000 covers both implementations.
    assert.ok(
      statCount <= 1000,
      `fs.statSync called ${statCount} times across 10 unchanged-dir scans; ` +
      'expected ≤ 1000 (per-session attachment-dir byte cache not in place — ' +
      'see docs/audits/hot-04-attachment-scan.md)'
    );
  });

  it('keeps event-loop max lag under 50ms across post-warmup _attachmentDirBytes calls', async () => {
    // Warmup call to populate any cache the fix introduces. Excluded
    // from the histogram measurement so the fix isn't penalised for
    // its first-touch population cost (a one-shot per process restart).
    server._attachmentDirBytes(attachmentsDir);

    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();

    const yieldNext = () => new Promise((r) => setImmediate(r));
    try {
      for (let i = 0; i < 9; i++) {
        server._attachmentDirBytes(attachmentsDir);
        await yieldNext();
      }
    } finally {
      h.disable();
    }

    const maxMs = h.max / 1e6;
    const meanMs = h.mean / 1e6;

    // After warmup:
    //   main: still 500ms per call (no cache) → max ≥ 500ms.
    //   fix:  ~0ms per call (cache hit) → max < 50ms.
    assert.ok(
      maxMs < 50,
      `post-warmup event-loop max lag = ${maxMs.toFixed(2)} ms ` +
      `(mean ${meanMs.toFixed(2)} ms); expected < 50 ms — ` +
      'attachment-dir scan still O(N) per call on the hot path ' +
      '(see docs/audits/hot-04-attachment-scan.md)'
    );
  });
});
