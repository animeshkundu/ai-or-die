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
// and assert (a) call-count is bounded over the burst, (b) post-warmup
// calls don't re-trigger the O(N) per-entry scan.
//
// On main:
//   • statSync called 500 * 10 = 5000 times (no cache).
//   ⇒ both assertions fail.
//
// After the fix (cached (bytes, mtimeMs) pair, refresh only on mtime
// advance — HOT-09):
//   • statSync called ≤ 1000 across 10 calls (first scan populates +
//     subsequent dir-freshness stats only).
//   • Post-warmup calls each do ONE dir-stat (no O(N) per-entry scan).
//   ⇒ both assertions pass.
//
// Note on CI shape: the earlier version of the second assertion measured
// `perf_hooks.monitorEventLoopDelay h.max < 50ms`. On macOS GitHub
// Actions shared runners, a single real fs.statSync can take 30-80ms
// under disk contention — pushing h.max over 50ms even though the FIX
// works exactly as designed (only 1 stat per call, no O(N) scan).
// That's CI-noise, not regression. The current shape (call-count
// post-warmup) catches the actual contract being violated with zero
// CI-environment sensitivity. See HOT-04-fixup commit message.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

  it('post-warmup _attachmentDirBytes calls do not re-trigger the O(N) file-stat scan (CI-robust)', async () => {
    // Warmup call to populate the cache. Excluded from the measurement.
    server._attachmentDirBytes(attachmentsDir);

    // Reset the statSync counter so we only measure post-warmup calls.
    statCount = 0;

    const yieldNext = () => new Promise((r) => setImmediate(r));
    for (let i = 0; i < 9; i++) {
      server._attachmentDirBytes(attachmentsDir);
      await yieldNext();
    }

    // HOT-09 fix contract: each post-warmup call does exactly ONE
    // fs.statSync — the dir freshness check. The O(N) per-entry scan is
    // skipped. With 9 calls, expect ≤ 9 statSyncs on the tmp dir.
    //
    // On main without HOT-09: each call would do 1 readdirSync + 500
    // per-entry statSyncs → 4500+ statSyncs after warmup. We allow some
    // slack (≤ 20) to tolerate any auxiliary stats the implementation
    // might add (e.g. dir-existence pre-check) without flakiness.
    //
    // Why this assertion shape instead of event-loop max-lag:
    //   The earlier version of this test asserted
    //   `perf_hooks.monitorEventLoopDelay h.max < 50ms` across 9
    //   post-warmup calls. On macOS shared CI runners (GitHub Actions
    //   darwin), a single real fs.statSync can take 30-80ms under disk
    //   contention — pushing h.max over 50ms even though the FIX works
    //   exactly as designed (only 1 stat per call, no O(N) scan).
    //   That's CI-noise, not regression. The call-count assertion catches
    //   the actual contract being violated (O(N) scan returning) with
    //   zero CI-environment sensitivity.
    assert.ok(
      statCount <= 20,
      `fs.statSync called ${statCount} times across 9 post-warmup calls; ` +
      'expected ≤ 20 (per-call dir-freshness stat only; O(N) per-entry scan ' +
      'should be skipped — see docs/audits/hot-04-attachment-scan.md)'
    );

    // Sanity: each call returns a positive byte count (cache lookups are
    // returning the actual cached bytes, not 0 or undefined).
    const bytes = server._attachmentDirBytes(attachmentsDir);
    assert.ok(bytes > 0, `post-warmup call returned ${bytes}; expected positive`);
  });
});
