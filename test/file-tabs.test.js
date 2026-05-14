// test/file-tabs.test.js — pure-JS helpers exposed by file-tabs.js.
//
// DOM/UI paths (TabManager constructor, openFile, closeTab, drag-reorder,
// keyboard shortcuts) are exercised by the Playwright e2e suite (task #11).
// This file covers the testable seam: the storage key + identity + serialise/
// deserialise helpers that round-trip the open-tabs state through localStorage.

'use strict';

const path = require('path');
const assert = require('assert');

const modulePath = path.join(__dirname, '..', 'src', 'public', 'file-tabs.js');
delete require.cache[require.resolve(modulePath)];

const ft = require(modulePath);

describe('file-tabs.js (pure helpers)', function () {
  describe('exports under Node', function () {
    it('exposes storageKey, basenameOf, tabKey, serializeState, deserializeState', function () {
      assert.strictEqual(typeof ft.storageKey, 'function');
      assert.strictEqual(typeof ft.basenameOf, 'function');
      assert.strictEqual(typeof ft.tabKey, 'function');
      assert.strictEqual(typeof ft.serializeState, 'function');
      assert.strictEqual(typeof ft.deserializeState, 'function');
    });

    it('exposes STORAGE_PREFIX and STORAGE_VERSION constants', function () {
      assert.strictEqual(typeof ft.STORAGE_PREFIX, 'string');
      assert.ok(ft.STORAGE_PREFIX.length > 0);
      assert.strictEqual(typeof ft.STORAGE_VERSION, 'number');
      assert.ok(ft.STORAGE_VERSION >= 1);
    });

    // Full module surface (including the DOM-bound TabManager class) is
    // exposed under Node by design — matches file-browser.js convention.
    // DOM/UI paths exercised by Playwright e2e (#11).
  });

  describe('storageKey', function () {
    it('namespaces by sessionKey', function () {
      assert.strictEqual(ft.storageKey('session-abc'), ft.STORAGE_PREFIX + 'session-abc');
      assert.strictEqual(ft.storageKey('default'), ft.STORAGE_PREFIX + 'default');
    });
    it('falls back to default sessionKey when missing/null/empty', function () {
      assert.strictEqual(ft.storageKey(''), ft.STORAGE_PREFIX + 'default');
      assert.strictEqual(ft.storageKey(null), ft.STORAGE_PREFIX + 'default');
      assert.strictEqual(ft.storageKey(undefined), ft.STORAGE_PREFIX + 'default');
    });
  });

  describe('basenameOf', function () {
    it('extracts the basename from Unix paths', function () {
      assert.strictEqual(ft.basenameOf('/a/b/foo.js'), 'foo.js');
      assert.strictEqual(ft.basenameOf('foo.js'), 'foo.js');
    });
    it('extracts the basename from Windows paths', function () {
      assert.strictEqual(ft.basenameOf('C:\\a\\b\\foo.js'), 'foo.js');
    });
    it('falls back to the input when the path ends with a separator', function () {
      assert.strictEqual(ft.basenameOf('/a/b/'), '/a/b/');
    });
    it('returns empty string for null / undefined / empty', function () {
      assert.strictEqual(ft.basenameOf(null), '');
      assert.strictEqual(ft.basenameOf(undefined), '');
      assert.strictEqual(ft.basenameOf(''), '');
    });
  });

  describe('tabKey', function () {
    it('combines mode and path with a stable separator', function () {
      assert.strictEqual(ft.tabKey('/a/b.js', 'preview'), 'preview:/a/b.js');
      assert.strictEqual(ft.tabKey('/a/b.js', 'editor'), 'editor:/a/b.js');
    });
    it('treats different modes as different identities for the same path', function () {
      assert.notStrictEqual(
        ft.tabKey('/a/b.js', 'preview'),
        ft.tabKey('/a/b.js', 'editor')
      );
    });
  });

  describe('serializeState', function () {
    it('persists path + mode but drops transient fields', function () {
      var state = ft.serializeState([
        { id: 't_1', path: '/a/b.js', mode: 'preview', name: 'b.js', dirty: false, contentEl: {}, panel: {} },
        { id: 't_2', path: '/c/d.js', mode: 'editor',  name: 'd.js', dirty: true,  contentEl: {}, panel: {} },
      ], 1);
      assert.deepStrictEqual(state, {
        version: ft.STORAGE_VERSION,
        tabs: [
          { path: '/a/b.js', mode: 'preview' },
          { path: '/c/d.js', mode: 'editor' },
        ],
        activeIndex: 1,
      });
    });

    it('clamps activeIndex to a valid range', function () {
      var state = ft.serializeState(
        [{ path: '/a', mode: 'preview' }],
        99
      );
      assert.strictEqual(state.activeIndex, 0);
    });

    it('returns activeIndex -1 when there are no tabs', function () {
      assert.strictEqual(ft.serializeState([], 0).activeIndex, -1);
      assert.strictEqual(ft.serializeState([], -1).activeIndex, -1);
    });

    it('handles missing/null tabs argument', function () {
      var s = ft.serializeState(null, 0);
      assert.deepStrictEqual(s.tabs, []);
      assert.strictEqual(s.activeIndex, -1);
    });
  });

  describe('deserializeState', function () {
    it('round-trips a valid serialized state', function () {
      var src = ft.serializeState([
        { path: '/a/b.js', mode: 'preview' },
        { path: '/c/d.js', mode: 'editor' },
      ], 1);
      var out = ft.deserializeState(src);
      assert.deepStrictEqual(out, {
        tabs: [
          { path: '/a/b.js', mode: 'preview' },
          { path: '/c/d.js', mode: 'editor' },
        ],
        activeIndex: 1,
      });
    });

    it('rejects a wrong-version payload (forward-compat guard)', function () {
      var out = ft.deserializeState({ version: 999, tabs: [{ path: '/x', mode: 'preview' }], activeIndex: 0 });
      assert.deepStrictEqual(out, { tabs: [], activeIndex: -1 });
    });

    it('drops malformed tab entries silently', function () {
      var out = ft.deserializeState({
        version: ft.STORAGE_VERSION,
        tabs: [
          { path: '/ok', mode: 'preview' },
          { path: '', mode: 'preview' },          // empty path → drop
          { path: '/bad-mode', mode: 'wat' },     // unknown mode → coerce to preview
          'string-not-object',                    // wrong shape → drop
          null,                                   // null → drop
          { mode: 'preview' },                    // missing path → drop
        ],
        activeIndex: 0,
      });
      assert.deepStrictEqual(out.tabs, [
        { path: '/ok', mode: 'preview' },
        { path: '/bad-mode', mode: 'preview' },
      ]);
    });

    it('clamps out-of-range activeIndex to 0 if tabs exist', function () {
      var out = ft.deserializeState({
        version: ft.STORAGE_VERSION,
        tabs: [{ path: '/a', mode: 'preview' }],
        activeIndex: 99,
      });
      assert.strictEqual(out.activeIndex, 0);
    });

    it('returns empty state for null / non-object / missing tabs[]', function () {
      assert.deepStrictEqual(ft.deserializeState(null), { tabs: [], activeIndex: -1 });
      assert.deepStrictEqual(ft.deserializeState('hello'), { tabs: [], activeIndex: -1 });
      assert.deepStrictEqual(ft.deserializeState({}), { tabs: [], activeIndex: -1 });
      assert.deepStrictEqual(ft.deserializeState({ version: ft.STORAGE_VERSION, tabs: 'x' }),
        { tabs: [], activeIndex: -1 });
    });

    // Codex review #1: restoreFromStorage was dropping the diff target on
    // reload because _createTab(t.path, t.mode, {}) ignored the persisted
    // compareWithRef / compareWithPath. The schema HAS always preserved
    // them — the consumer just wasn't threading them through. This test
    // pins the schema half (the fix is in restoreFromStorage's call site).
    it('round-trips diff-mode compareWithRef + compareWithPath', function () {
      var src = ft.serializeState([
        { path: '/repo/src/foo.js', mode: 'diff', compareWithRef: 'main' },
        { path: '/repo/src/bar.js', mode: 'diff', compareWithPath: '/repo/old/bar.js' },
        { path: '/repo/src/baz.js', mode: 'diff' }, // no target → defaults to HEAD on render
      ], 0);
      var out = ft.deserializeState(src);
      assert.deepStrictEqual(out.tabs[0],
        { path: '/repo/src/foo.js', mode: 'diff', compareWithRef: 'main' });
      assert.deepStrictEqual(out.tabs[1],
        { path: '/repo/src/bar.js', mode: 'diff', compareWithPath: '/repo/old/bar.js' });
      assert.deepStrictEqual(out.tabs[2],
        { path: '/repo/src/baz.js', mode: 'diff' });
    });

    it('truncates over-long diff target strings (defensive, prevents storage bloat)', function () {
      var longRef = 'x'.repeat(500);   // exceeds the 200-char cap
      var longPath = 'p'.repeat(5000); // exceeds the 4096-char cap
      var out = ft.deserializeState({
        version: ft.STORAGE_VERSION,
        tabs: [
          { path: '/x', mode: 'diff', compareWithRef: longRef },
          { path: '/y', mode: 'diff', compareWithPath: longPath },
        ],
        activeIndex: 0,
      });
      // Both bad fields should be dropped (not silently truncated to a
      // partial value that happened to validate elsewhere).
      assert.strictEqual(out.tabs[0].compareWithRef, undefined,
        'over-long ref should be dropped, not truncated');
      assert.strictEqual(out.tabs[1].compareWithPath, undefined,
        'over-long path should be dropped');
    });
  });
});
