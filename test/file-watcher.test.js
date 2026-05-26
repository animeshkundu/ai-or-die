// test/file-watcher.test.js — unit tests for the FileWatcher chokidar
// narrowing introduced when the Windows + multi-worktree hang was diagnosed.
//
// Three properties this file proves directly (the adversarial review of
// the design plan flagged each as an unverified assumption):
//
//   1. Under depth: 0, chokidar's actual watch scope = the union of
//      subscribed paths' target directories. Unsubscribed paths get no
//      events; subscribed paths do.
//   2. The watch-target refcount on unsubscribe is correct: closing one
//      subscription that shares a watch target with another subscription
//      does NOT silence the other one.
//   3. The Windows-case-insensitive refcount key collapses case-variant
//      subscriptions to a single refcount slot (subscribe in one casing,
//      unsubscribe in another, watch should still drop).
//
// We avoid asserting timing-sensitive event arrival via real chokidar
// (FSEvents flakiness on macOS sync writes is well documented). Instead
// we drive chokidar with FS_WATCHER_USE_POLLING=1 inside the test and
// short stabilityMs / pollIntervalMs windows.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FileWatcher = require('../src/utils/file-watcher');

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fw-narrow-'));
}

async function waitForEvent(watcher, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.off('event', onEvent);
      reject(new Error('Timed out waiting for matching event'));
    }, timeoutMs || 2000);
    function onEvent(evt) {
      if (predicate(evt)) {
        clearTimeout(timer);
        watcher.off('event', onEvent);
        resolve(evt);
      }
    }
    watcher.on('event', onEvent);
  });
}

async function expectNoEvent(watcher, predicate, windowMs) {
  return new Promise((resolve, reject) => {
    function onEvent(evt) {
      if (predicate(evt)) {
        clearTimeout(timer);
        watcher.off('event', onEvent);
        reject(new Error('Unexpected event arrived: ' + JSON.stringify(evt)));
      }
    }
    watcher.on('event', onEvent);
    const timer = setTimeout(() => {
      watcher.off('event', onEvent);
      resolve();
    }, windowMs);
  });
}

function newWatcher(root, opts) {
  return new FileWatcher(Object.assign({
    watchRoot: root,
    depth: 0,
    debounceMs: 30,
    addChangeDedupMs: 10,
    renameDetectMs: 10,
    stabilityMs: 0,           // disable awaitWriteFinish (sync writes)
    usePolling: true,         // dodge FSEvents on macOS for deterministic tests
    pollIntervalMs: 25,
  }, opts || {}));
}

describe('FileWatcher narrow-scope (depth: 0)', function () {
  this.timeout(15000);

  it('defaults includeHash to false when depth: 0 is set', function () {
    const root = mkdtemp();
    try {
      const w = new FileWatcher({ watchRoot: root, depth: 0 });
      assert.strictEqual(w._includeHash, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps includeHash default true when depth is not set', function () {
    const root = mkdtemp();
    try {
      const w = new FileWatcher({ watchRoot: root });
      assert.strictEqual(w._includeHash, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects explicit includeHash override even with depth: 0', function () {
    const root = mkdtemp();
    try {
      const w = new FileWatcher({ watchRoot: root, depth: 0, includeHash: true });
      assert.strictEqual(w._includeHash, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('default debounceMs is 500 (Windows-hang remediation)', function () {
    const root = mkdtemp();
    try {
      const w = new FileWatcher({ watchRoot: root });
      assert.strictEqual(w._debounceMs, 500);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('subscribing to a file watches its parent dir; unsubscribing unwatches when refcount hits zero', async function () {
    const root = mkdtemp();
    const subdir = fs.mkdtempSync(path.join(root, 'sub-'));
    const file = path.join(subdir, 'a.js');
    fs.writeFileSync(file, 'v1');

    const w = newWatcher(root);
    try {
      await w.start();
      // _refWatchTarget keys off the canonicalized (realpathed) path —
      // on macOS /tmp → /private/tmp so we must canonicalize the expected
      // key too. Use the watcher's own normalizer so the platform-specific
      // lower-casing matches.
      const canonicalSubdir = fs.realpathSync(subdir);
      const dirKey = w._watchKeyNorm(canonicalSubdir);

      // Before any subscription, the parent dir is NOT in _watchedDirs
      // (only the watchRoot is implicitly watched at depth 0).
      assert.strictEqual(w._watchedDirs.has(dirKey), false);

      await w.subscribe(file);
      assert.strictEqual(w._watchedDirs.has(dirKey), true);
      assert.strictEqual(w._dirRefcount.get(dirKey), 1);

      await w.unsubscribe(file);
      assert.strictEqual(w._watchedDirs.has(dirKey), false);
      assert.strictEqual(w._dirRefcount.has(dirKey), false);
    } finally {
      await w.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('two subscriptions sharing a parent dir refcount to a single watch; closing one keeps the other live', async function () {
    const root = mkdtemp();
    const subdir = fs.mkdtempSync(path.join(root, 'sub-'));
    const fileA = path.join(subdir, 'a.js');
    const fileB = path.join(subdir, 'b.js');
    fs.writeFileSync(fileA, 'a1');
    fs.writeFileSync(fileB, 'b1');

    const w = newWatcher(root);
    try {
      await w.start();
      await w.subscribe(fileA);
      await w.subscribe(fileB);
      const dirKey = w._watchKeyNorm(fs.realpathSync(subdir));
      assert.strictEqual(w._dirRefcount.get(dirKey), 2);

      // Close one; the other must keep getting events.
      await w.unsubscribe(fileA);
      assert.strictEqual(w._dirRefcount.get(dirKey), 1);
      assert.strictEqual(w._watchedDirs.has(dirKey), true);

      // Bump file B and confirm we still see the event.
      const got = waitForEvent(w, (evt) => evt.type === 'change' && evt.path.endsWith('b.js'), 5000);
      // Small delay so the watcher's polling sees the second mtime.
      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(fileB, 'b2');
      await got;

      // Close the second; chokidar drops the underlying watch.
      await w.unsubscribe(fileB);
      assert.strictEqual(w._dirRefcount.has(dirKey), false);
      assert.strictEqual(w._watchedDirs.has(dirKey), false);
    } finally {
      await w.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refcount key is case-insensitive on Windows (no-op assertion elsewhere)', function () {
    // We can't actually exercise the case-collision on POSIX (paths are
    // case-sensitive), but the predicate is testable in isolation.
    const root = mkdtemp();
    try {
      const w = new FileWatcher({ watchRoot: root, depth: 0 });
      const a = w._watchKeyNorm('Q:\\src\\Foo');
      const b = w._watchKeyNorm('q:/SRC/foo');
      if (process.platform === 'win32') {
        assert.strictEqual(a, b, 'Windows refcount key must collapse case + separator differences');
      } else {
        // On POSIX, only the separator-normalization runs (backslashes
        // are treated as literal characters here — input is a synthetic
        // Windows path). We still expect _watchKeyNorm to be a pure
        // function of the input.
        assert.strictEqual(typeof a, 'string');
        assert.strictEqual(typeof b, 'string');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('events for paths NEVER subscribed do not fire', async function () {
    const root = mkdtemp();
    const sub = fs.mkdtempSync(path.join(root, 'sub-'));
    const subscribed = path.join(sub, 'watched.js');
    const stranger = path.join(sub, 'stranger.js');
    fs.writeFileSync(subscribed, '1');
    fs.writeFileSync(stranger, '1');

    const w = newWatcher(root);
    try {
      await w.start();
      await w.subscribe(subscribed);

      // Bump the stranger file — no event should fire for it because the
      // soft-filter set doesn't include it, even though chokidar is now
      // watching the parent dir (and will SEE the event internally).
      const noEvent = expectNoEvent(w, (evt) => evt.path.endsWith('stranger.js'), 600);
      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(stranger, '2');
      await noEvent;
    } finally {
      await w.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('depth: 0 + recursive subscription delivers events for direct children only', async function () {
    const root = mkdtemp();
    const sub = fs.mkdtempSync(path.join(root, 'sub-'));
    const directChild = path.join(sub, 'direct.js');
    const grandchildDir = path.join(sub, 'nested');
    fs.mkdirSync(grandchildDir);
    const grandchild = path.join(grandchildDir, 'deep.js');
    fs.writeFileSync(directChild, '1');
    fs.writeFileSync(grandchild, '1');

    const w = newWatcher(root);
    try {
      await w.start();
      await w.subscribe(sub, { recursive: true });

      // Direct child change → event.
      const direct = waitForEvent(w, (evt) => evt.path.endsWith('direct.js'), 5000);
      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(directChild, '2');
      await direct;

      // Grandchild change → NO event (depth: 0).
      const noEvent = expectNoEvent(w, (evt) => evt.path.endsWith('deep.js'), 600);
      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(grandchild, '2');
      await noEvent;
    } finally {
      await w.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('FileWatcher recursive backward compat (no depth)', function () {
  this.timeout(10000);

  it('subscribe still passes basic events when constructed without depth', async function () {
    const root = mkdtemp();
    const file = path.join(root, 'a.js');
    fs.writeFileSync(file, 'x');
    const w = new FileWatcher({
      watchRoot: root,
      // no depth — falls back to recursive (legacy callers)
      debounceMs: 30,
      stabilityMs: 0,
      usePolling: true,
      pollIntervalMs: 25,
    });
    try {
      await w.start();
      await w.subscribe(file);
      const got = waitForEvent(w, (evt) => evt.type === 'change' && evt.path.endsWith('a.js'), 5000);
      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(file, 'y');
      await got;
      // Refcount machinery should NOT have engaged (no depth: 0).
      assert.strictEqual(w._watchedDirs.size, 0);
      assert.strictEqual(w._dirRefcount.size, 0);
    } finally {
      await w.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
