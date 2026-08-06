'use strict';

// Regression guard for a Windows-only native crash.
//
// chokidar/libuv compare the filename reported by ReadDirectoryChangesW (always
// the LONG name) against the directory we asked to watch. Handing libuv a path
// in 8.3 short form makes that prefix compare fail and trips a native assertion
// that ABORTS the process, taking the whole test run with it:
//
//   Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72
//
// FileWatcher canonicalized with the pure-JS fs.realpathSync, which does NOT
// expand 8.3 short names (CLAUDE.md calls this out explicitly). It only
// surfaced on Windows CI, where os.tmpdir() is C:\Users\RUNNER~1\... — dev
// boxes whose TEMP is already a long path never reproduce it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { stripWindowsLongPathPrefix } = require('../src/utils/win-long-path');

const IS_WIN = process.platform === 'win32';

function shortPathOf(dir) {
  const script =
    '(New-Object -ComObject Scripting.FileSystemObject).GetFolder("' + dir + '").ShortPath';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

describe('file-watcher 8.3 short-path canonicalization (Windows)', function () {
  this.timeout(20000);

  let root;
  let longDir;

  before(function () {
    if (!IS_WIN) return this.skip();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-short-'));
    // A name >8 chars with no extension reliably gets an 8.3 alias.
    longDir = path.join(root, 'averylongdirectoryname');
    fs.mkdirSync(longDir);
  });

  after(function () {
    if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
  });

  it('the pure-JS realpathSync does NOT expand 8.3 — which is why .native is required', function () {
    let short;
    try { short = shortPathOf(longDir); } catch (_) { return this.skip(); }
    if (!short || short.toLowerCase() === longDir.toLowerCase()) {
      // 8.3 generation is disabled on this volume (fsutil 8dot3name). The bug
      // cannot occur here, so there is nothing to assert.
      return this.skip();
    }
    const viaJs = fs.realpathSync(short);
    const viaNative = stripWindowsLongPathPrefix(fs.realpathSync.native(short));

    assert.notStrictEqual(
      viaJs.toLowerCase(),
      longDir.toLowerCase(),
      'if pure-JS realpathSync ever starts expanding 8.3, this guard can be simplified'
    );
    assert.strictEqual(
      viaNative.toLowerCase(),
      longDir.toLowerCase(),
      'realpathSync.native must expand 8.3 short names'
    );
  });

  it('FileWatcher canonicalizes an 8.3 watchRoot to its long form', function () {
    let short;
    try { short = shortPathOf(longDir); } catch (_) { return this.skip(); }
    if (!short || short.toLowerCase() === longDir.toLowerCase()) return this.skip();

    const FileWatcher = require('../src/utils/file-watcher');
    const watcher = new FileWatcher({ watchRoot: short });
    try {
      assert.strictEqual(
        watcher._watchRoot.toLowerCase(),
        longDir.toLowerCase(),
        'watchRoot must be the long form before it reaches chokidar/libuv'
      );
    } finally {
      if (typeof watcher.close === 'function') { try { watcher.close(); } catch (_) { /* ignore */ } }
    }
  });
});
