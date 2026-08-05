'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FileWatcher = require('../src/utils/file-watcher');
const { stripWindowsLongPathPrefix } = require('../src/utils/win-long-path');

const canonicalizeForWatch = FileWatcher.canonicalizeForWatch;

function withNativeResult(result, fn) {
  const original = fs.realpathSync.native;
  fs.realpathSync.native = () => result;
  try {
    return fn();
  } finally {
    fs.realpathSync.native = original;
  }
}

describe('FileWatcher Windows long-path canonicalization', function () {
  const cases = [
    ['extended drive path', '\\\\?\\C:\\Users\\me', 'C:\\Users\\me'],
    ['extended UNC path', '\\\\?\\UNC\\server\\share\\project', '\\\\server\\share\\project'],
    ['drive path', 'C:\\plain', 'C:\\plain'],
    ['forward-slash drive path', 'C:/plain/dir', 'C:/plain/dir'],
    ['drive trailing separator', 'C:\\plain\\dir\\', 'C:\\plain\\dir\\'],
    ['extended drive trailing separator', '\\\\?\\C:\\dir\\', 'C:\\dir\\'],
    ['POSIX path', '/tmp/x', '/tmp/x'],
    ['bare extended prefix', '\\\\?\\', ''],
    ['bare extended UNC prefix', '\\\\?\\UNC\\', '\\\\'],
    ['bare extended UNC marker', '\\\\?\\UNC', 'UNC'],
  ];

  for (const [name, nativeResult, expected] of cases) {
    it(`maps ${name} without normalizing the remainder`, function () {
      assert.strictEqual(stripWindowsLongPathPrefix(nativeResult), expected);
    });
  }

  it('uses the shared mapping through the exported watcher canonicalizer', function () {
    const actual = withNativeResult(
      '\\\\?\\UNC\\server\\share\\project',
      () => canonicalizeForWatch('\\\\server\\share\\project')
    );
    assert.strictEqual(actual, '\\\\server\\share\\project');
  });

  it('expands an 8.3-shaped path through realpathSync.native on every platform', function () {
    const expanded = withNativeResult(
      '\\\\?\\C:\\Users\\RUNNERADMIN\\proj',
      () => canonicalizeForWatch('C:\\Users\\RUNNER~1\\proj')
    );
    assert.strictEqual(expanded, 'C:\\Users\\RUNNERADMIN\\proj');
  });

  it('matches a UNC descendant registered through subscribe on Windows', async function () {
    if (process.platform !== 'win32') return this.skip();

    const watcher = new FileWatcher({
      watchRoot: os.tmpdir(),
      includeHash: false,
      debounceMs: 0,
    });
    watcher._watcher = {
      add() {},
      unwatch() {},
      async close() {},
    };

    const share = '\\\\server\\share\\project';
    const descendant = `${share}\\src\\index.js`;
    const original = fs.realpathSync.native;
    fs.realpathSync.native = (input) => (
      path.resolve(input) === path.resolve(share)
        ? '\\\\?\\UNC\\server\\share\\project'
        : original(input)
    );

    try {
      await watcher.subscribe(share, { recursive: true });
    } finally {
      fs.realpathSync.native = original;
    }

    try {
      assert.strictEqual(watcher.hasSubscription(descendant), true);
      const eventPromise = new Promise((resolve) => watcher.once('event', resolve));
      watcher._onChokidar('change', descendant, { mtimeMs: 1, ino: 1 });
      const event = await eventPromise;
      assert.strictEqual(event.path, descendant.replace(/\\/g, '/'));
    } finally {
      await watcher.close();
    }
  });
});
