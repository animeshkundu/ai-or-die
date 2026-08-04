// Regression: FileWatcher.hasSubscription() must find subscriptions whose
// stored key was CANONICALIZED, even when the incoming path is not canonical.
//
// The bug: subscribe() stores `_canonicalize(absPath)`, but hasSubscription()
// compared with `path.resolve(absPath)` only. Whenever canonicalization was not
// the identity the lookup missed and the watcher delivered NOTHING — no error,
// no warning, just silence.
//
// Where it actually bit: Windows 8.3 short paths. A GitHub Windows runner's TEMP
// is C:\Users\RUNNER~1\AppData\Local\Temp, which canonicalizes to
// C:\Users\runneradmin\..., so every event was dropped and HOT-02 failed with
// "expected >= 20 flush events; got 0". A developer box whose TEMP is already
// long-form canonicalizes to itself, so it passed locally — which is exactly
// why this needs a test that does not depend on the host's path shape.
//
// These tests force the divergence by stubbing _canonicalize, so they reproduce
// the defect identically on Linux, macOS and Windows.

const assert = require('assert');
const path = require('path');
const FileWatcher = require('../src/utils/file-watcher');

describe('FileWatcher subscription canonicalization', () => {
  const SHORT = path.resolve(path.join('C:', 'Users', 'RUNNER~1', 'work', 'a.txt'));
  const LONG = path.resolve(path.join('C:', 'Users', 'runneradmin', 'work', 'a.txt'));

  function makeWatcher() {
    const w = new FileWatcher({ watchRoot: path.resolve('.'), includeHash: false });
    // Stand in for realpathSync.native expanding an 8.3 short name.
    w._canonicalize = (p) => (path.resolve(p) === SHORT ? LONG : path.resolve(p));
    return w;
  }

  it('matches an exact subscription when the incoming path is not canonical', () => {
    const w = makeWatcher();
    w._subscriptions.add(w._canonicalize(SHORT)); // stored canonical (LONG)
    assert.strictEqual(
      w.hasSubscription(SHORT), true,
      'the non-canonical form the watcher receives must still match'
    );
    assert.strictEqual(
      w.hasSubscription(LONG), true,
      'the canonical form must match too'
    );
  });

  it('matches a recursive subscription through canonicalization', () => {
    const w = makeWatcher();
    const shortDir = path.dirname(SHORT);
    const longDir = path.dirname(LONG);
    w._canonicalize = (p) => (path.resolve(p) === shortDir ? longDir
      : path.resolve(p) === SHORT ? LONG : path.resolve(p));
    w._dirSubscriptions.add(longDir + path.sep);
    assert.strictEqual(
      w.hasSubscription(SHORT), true,
      'a descendant given in short form must match a canonical dir subscription'
    );
  });

  it('still rejects genuinely unsubscribed paths', () => {
    const w = makeWatcher();
    w._subscriptions.add(w._canonicalize(SHORT));
    assert.strictEqual(
      w.hasSubscription(path.resolve(path.join('C:', 'elsewhere', 'b.txt'))), false,
      'canonicalizing the lookup must not turn a miss into a hit'
    );
  });

  it('does not canonicalize when the cheap lexical compare already matches', () => {
    // Guards the hot path: hasSubscription runs on EVERY chokidar event, and
    // HOT-02 exists to keep synchronous I/O off it. An already-canonical path
    // must cost zero realpath calls.
    const w = makeWatcher();
    const plain = path.resolve(path.join('C:', 'plain', 'c.txt'));
    w._subscriptions.add(plain);
    let canonCalls = 0;
    w._canonicalize = (p) => { canonCalls++; return path.resolve(p); };
    assert.strictEqual(w.hasSubscription(plain), true);
    assert.strictEqual(canonCalls, 0, 'a lexical hit must not trigger canonicalization');
  });

  it('memoizes canonicalization so a repeatedly-rejected path re-stats once', () => {
    const w = makeWatcher();
    w._subscriptions.add(LONG);
    let canonCalls = 0;
    w._canonicalize = (p) => { canonCalls++; return path.resolve(p); };
    const miss = path.resolve(path.join('C:', 'noisy', 'd.txt'));
    for (let i = 0; i < 25; i++) w.hasSubscription(miss);
    assert.strictEqual(canonCalls, 1, `expected 1 canonicalization, got ${canonCalls}`);
  });
});
