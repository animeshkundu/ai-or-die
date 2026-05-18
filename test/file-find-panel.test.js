// test/file-find-panel.test.js — Cmd-P "Go to File" panel from Part B of
// the file-browser-v2 iteration.
//
// Pure helpers run under Node directly (URL build, basename split,
// truncation banner). DOM-bound FindPanel behaviour (keyboard nav,
// Enter→preview, Cmd+Enter→editor, debounce timer, AbortController
// cancel) runs under JSDOM — same posture as
// test/markdown-render-dom.test.js (skips when jsdom isn't installed).

'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const modulePath = path.join(__dirname, '..', 'src', 'public', 'file-find.js');
delete require.cache[require.resolve(modulePath)];

const ff = require(modulePath);

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (_) { /* will skip below */ }

const FIND_SRC = path.join(__dirname, '..', 'src', 'public', 'file-find.js');

// ---------------------------------------------------------------------------
// Pure helpers (Node-only — no DOM required)
// ---------------------------------------------------------------------------

describe('file-find.js (pure helpers)', function () {

  describe('exports under Node', function () {
    it('exposes the pure helpers + endpoint constants', function () {
      assert.strictEqual(typeof ff.buildFindUrl, 'function');
      assert.strictEqual(typeof ff.splitBasenameParent, 'function');
      assert.strictEqual(typeof ff.formatTruncationBanner, 'function');
      assert.strictEqual(ff.FIND_ENDPOINT, '/api/files/find');
      assert.strictEqual(ff.DEFAULT_DEBOUNCE_MS, 120);
    });
  });

  describe('buildFindUrl', function () {
    it('returns empty string for empty / null / undefined query', function () {
      assert.strictEqual(ff.buildFindUrl('', { session: 'sess-a' }), '');
      assert.strictEqual(ff.buildFindUrl(null, { session: 'sess-a' }), '');
      assert.strictEqual(ff.buildFindUrl(undefined, {}), '');
    });

    it('builds a minimal URL with q + session', function () {
      var u = ff.buildFindUrl('app', { session: 'sess-a' });
      assert.ok(u.indexOf('/api/files/find?') === 0);
      assert.ok(u.indexOf('q=app') !== -1);
      assert.ok(u.indexOf('session=sess-a') !== -1);
    });

    it('encodes the query for special chars', function () {
      var u = ff.buildFindUrl('foo bar&baz', { session: 's' });
      assert.ok(u.indexOf('q=foo%20bar%26baz') !== -1, 'encoded q: ' + u);
    });

    it('appends path / limit / token when provided', function () {
      var u = ff.buildFindUrl('app', { session: 's', path: '/Users/foo', limit: 100, token: 'tk' });
      assert.ok(u.indexOf('path=%2FUsers%2Ffoo') !== -1);
      assert.ok(u.indexOf('limit=100') !== -1);
      assert.ok(u.indexOf('token=tk') !== -1);
    });

    it('omits limit/token/path when not set', function () {
      var u = ff.buildFindUrl('app', { session: 's' });
      assert.ok(u.indexOf('limit') === -1);
      assert.ok(u.indexOf('token') === -1);
      assert.ok(u.indexOf('path') === -1);
    });
  });

  describe('splitBasenameParent', function () {
    it('splits a Unix path into { basename, parent }', function () {
      var r = ff.splitBasenameParent('/Users/foo/code/src/app.js');
      assert.strictEqual(r.basename, 'app.js');
      assert.strictEqual(r.parent, '/Users/foo/code/src');
    });

    it('splits a Windows path', function () {
      var r = ff.splitBasenameParent('C:\\Users\\foo\\src\\app.js');
      assert.strictEqual(r.basename, 'app.js');
      assert.strictEqual(r.parent, 'C:\\Users\\foo\\src');
    });

    it('returns the path itself as basename when there is no separator', function () {
      var r = ff.splitBasenameParent('app.js');
      assert.strictEqual(r.basename, 'app.js');
      assert.strictEqual(r.parent, '');
    });

    it('handles trailing separator gracefully', function () {
      var r = ff.splitBasenameParent('/Users/foo/');
      assert.strictEqual(r.basename, '');
      assert.strictEqual(r.parent, '/Users/foo');
    });

    it('returns empty parts for null/undefined/empty', function () {
      assert.deepStrictEqual(ff.splitBasenameParent(''), { basename: '', parent: '' });
      assert.deepStrictEqual(ff.splitBasenameParent(null), { basename: '', parent: '' });
      assert.deepStrictEqual(ff.splitBasenameParent(undefined), { basename: '', parent: '' });
    });
  });

  describe('formatTruncationBanner', function () {
    it('formats the truncation hint when truncated', function () {
      var msg = ff.formatTruncationBanner({ truncated: true, totalFound: 50000 }, 50);
      assert.ok(msg.indexOf('50000') !== -1);
      assert.ok(msg.indexOf('50') !== -1);
      assert.ok(msg.toLowerCase().indexOf('refine') !== -1);
    });

    it('returns null when not truncated / missing / null', function () {
      assert.strictEqual(ff.formatTruncationBanner({ truncated: false, totalFound: 100 }, 50), null);
      assert.strictEqual(ff.formatTruncationBanner({}, 50), null);
      assert.strictEqual(ff.formatTruncationBanner(null, 50), null);
    });
  });

  // -------------------------------------------------------------------------
  // dispatchFindHit — the Cmd-P → file-browser dispatch helper.
  //
  // QA #6 regression: an earlier draft did `panel.openToFile(hit.path)`
  // unconditionally then synchronously checked `panel._tabManager` for
  // editor mode. That null-checked the tabManager BEFORE openToFile's
  // async navigateTo had a chance to bootstrap it lazily, so first-use
  // Cmd+Enter silently degraded to a preview tab. Fix: editor mode must
  // call `panel._ensureTabManager()` (force-bootstrap) and skip the
  // openToFile dance entirely so we don't end up with two tabs.
  // -------------------------------------------------------------------------

  describe('dispatchFindHit', function () {
    it('exists and is exported', function () {
      assert.strictEqual(typeof ff.dispatchFindHit, 'function');
    });

    it('preview mode → calls panel.openToFile only', function () {
      var calls = { openToFile: [], ensureTabManager: 0, openFile: [] };
      var panel = {
        isOpen: function () { return true; },
        open: function () { /* no-op */ },
        openToFile: function (p) { calls.openToFile.push(p); },
        _ensureTabManager: function () { calls.ensureTabManager++; return null; },
      };
      ff.dispatchFindHit(panel, { path: '/a/file.js', mode: 'preview' });
      assert.deepStrictEqual(calls.openToFile, ['/a/file.js']);
      assert.strictEqual(calls.ensureTabManager, 0,
        'preview mode must NOT touch the tab manager directly');
    });

    it('editor mode → ensures tabManager + opens with mode=editor', function () {
      var calls = { openToFile: [], ensureTabManager: 0, openFile: [] };
      var fakeTM = {
        openFile: function (p, m) { calls.openFile.push({ path: p, mode: m }); return 't_1'; },
      };
      var panel = {
        isOpen: function () { return true; },
        open: function () { /* no-op */ },
        openToFile: function (p) { calls.openToFile.push(p); },
        _ensureTabManager: function () { calls.ensureTabManager++; return fakeTM; },
      };
      ff.dispatchFindHit(panel, { path: '/a/file.js', mode: 'editor' });
      assert.strictEqual(calls.openToFile.length, 0,
        'editor mode must NOT call openToFile (would open a preview tab too)');
      assert.strictEqual(calls.ensureTabManager, 1,
        'editor mode MUST force-bootstrap the tab manager');
      assert.deepStrictEqual(calls.openFile, [{ path: '/a/file.js', mode: 'editor' }]);
    });

    it('editor mode on first use (lazy tabManager) — _ensureTabManager builds it', function () {
      // The QA #6 fixture: simulate a panel where _tabManager STARTS null,
      // and only _ensureTabManager() can mint it. The fix uses the latter
      // so the editor-mode call is no longer racing against the lazy init.
      var lazyTM = null;
      var calls = { openFile: [] };
      var panel = {
        _tabManager: null,           // synchronous read returns null (the bug)
        isOpen: function () { return true; },
        open: function () {},
        openToFile: function () {},
        _ensureTabManager: function () {
          if (!lazyTM) {
            lazyTM = {
              openFile: function (p, m) { calls.openFile.push({ path: p, mode: m }); return 't'; },
            };
          }
          return lazyTM;
        },
      };
      ff.dispatchFindHit(panel, { path: '/a/file.js', mode: 'editor' });
      // The fix's contract: editor-mode tab opened on first invocation.
      assert.strictEqual(calls.openFile.length, 1);
      assert.strictEqual(calls.openFile[0].mode, 'editor');
      assert.strictEqual(calls.openFile[0].path, '/a/file.js');
    });

    it('editor mode opens the panel first when closed', function () {
      var opened = 0;
      var fakeTM = { openFile: function () {} };
      var panel = {
        isOpen: function () { return false; },
        open: function () { opened++; },
        _ensureTabManager: function () { return fakeTM; },
        openToFile: function () {},
      };
      ff.dispatchFindHit(panel, { path: '/a/file.js', mode: 'editor' });
      assert.strictEqual(opened, 1, 'panel.open() must fire when closed');
    });

    it('editor mode is a no-op when panel.openFile throws (defensive)', function () {
      var panel = {
        isOpen: function () { return true; },
        open: function () {},
        openToFile: function () {},
        _ensureTabManager: function () {
          return { openFile: function () { throw new Error('boom'); } };
        },
      };
      // Must not throw — dispatchFindHit swallows tabManager errors.
      assert.doesNotThrow(function () {
        ff.dispatchFindHit(panel, { path: '/a/file.js', mode: 'editor' });
      });
    });

    it('does nothing for null panel / null hit / hit without path', function () {
      assert.doesNotThrow(function () { ff.dispatchFindHit(null, { path: '/x', mode: 'editor' }); });
      assert.doesNotThrow(function () { ff.dispatchFindHit({}, null); });
      assert.doesNotThrow(function () { ff.dispatchFindHit({}, {}); });
    });
  });
});

// ---------------------------------------------------------------------------
// FindPanel (JSDOM — skipped when jsdom missing)
// ---------------------------------------------------------------------------

(JSDOM ? describe : describe.skip)('FindPanel (JSDOM)', function () {
  this.timeout(10000);

  let window, document, container, FindPanel;

  beforeEach(function () {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    window = dom.window;
    document = window.document;
    // Required globals for the file-find IIFE that probes them.
    window.icons = { x: function () { return 'x'; } };
    // Load file-find.js into the JSDOM window so the IIFE attaches
    // window.fileFind. Same trick markdown-render-dom uses.
    const src = fs.readFileSync(FIND_SRC, 'utf8');
    window.eval(src);
    FindPanel = window.fileFind.FindPanel;

    container = document.createElement('div');
    document.body.appendChild(container);
  });

  // ---- Helpers ----

  function makeResp(matches, opts) {
    opts = opts || {};
    return {
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({
          matches: matches,
          truncated: !!opts.truncated,
          totalFound: opts.totalFound != null ? opts.totalFound : matches.length,
          queryMs: 12,
        });
      },
    };
  }

  function makeFetchSpy(resp, opts) {
    opts = opts || {};
    var calls = [];
    var fn = function (url, fetchOpts) {
      calls.push({ url: url, opts: fetchOpts });
      if (opts.aborts) {
        // Returns a never-resolving promise that rejects on abort. Mimics
        // real fetch's AbortError behaviour so the panel can exercise the
        // re-entrancy guard.
        return new Promise(function (_, reject) {
          if (fetchOpts && fetchOpts.signal) {
            fetchOpts.signal.addEventListener('abort', function () {
              var err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }
      return Promise.resolve(resp);
    };
    fn.calls = calls;
    return fn;
  }

  // Drains the JSDOM microtask queue. Promise resolutions are scheduled
  // as microtasks; setImmediate(0) yields after they all flush.
  function flush() {
    return new Promise(function (resolve) { setImmediate(resolve); });
  }

  // ---- Tests ----

  describe('lifecycle', function () {
    it('opens and focuses the input', function () {
      var p = new FindPanel({ containerEl: container, fetchImpl: makeFetchSpy(makeResp([])) });
      p.open();
      assert.strictEqual(p.isOpen(), true);
    });

    it('close() hides the panel and aborts any in-flight fetch', function (done) {
      var fetchImpl = makeFetchSpy(null, { aborts: true });
      var p = new FindPanel({
        containerEl: container,
        fetchImpl: fetchImpl,
        getSession: function () { return 'sess-a'; },
      });
      p.open();
      p.runQuery('foo');
      // First fetch fires. close() should abort it.
      flush().then(function () {
        assert.strictEqual(fetchImpl.calls.length, 1);
        var ctrl = fetchImpl.calls[0].opts.signal;
        assert.ok(ctrl, 'fetch should receive an AbortSignal');
        assert.strictEqual(ctrl.aborted, false);
        p.close();
        assert.strictEqual(ctrl.aborted, true);
        done();
      });
    });

    it('destroy() removes the panel from the DOM', function () {
      var p = new FindPanel({ containerEl: container, fetchImpl: makeFetchSpy(makeResp([])) });
      assert.ok(container.querySelector('.fb-find-panel'));
      p.destroy();
      assert.strictEqual(container.querySelector('.fb-find-panel'), null);
    });
  });

  describe('debounce', function () {
    it('coalesces rapid input events into a single fetch', function (done) {
      var resp = makeResp([{ path: '/a/app.js', basename: 'app.js' }]);
      var fetchImpl = makeFetchSpy(resp);
      var p = new FindPanel({
        containerEl: container,
        fetchImpl: fetchImpl,
        debounceMs: 30,
        getSession: function () { return 'sess-a'; },
      });
      p.open();
      // Type three keystrokes quickly via the input event path.
      p._inputEl.value = 'a';
      p._inputEl.dispatchEvent(new window.Event('input'));
      p._inputEl.value = 'ap';
      p._inputEl.dispatchEvent(new window.Event('input'));
      p._inputEl.value = 'app';
      p._inputEl.dispatchEvent(new window.Event('input'));
      // After 30ms only ONE fetch should have fired (the last keystroke).
      setTimeout(function () {
        flush().then(function () {
          assert.strictEqual(fetchImpl.calls.length, 1, 'expected exactly one fetch');
          assert.ok(fetchImpl.calls[0].url.indexOf('q=app') !== -1, 'URL: ' + fetchImpl.calls[0].url);
          done();
        });
      }, 60);
    });
  });

  describe('AbortController re-entrancy', function () {
    it('aborts the prior fetch when a new query supersedes it', function (done) {
      var fetchImpl = makeFetchSpy(null, { aborts: true });
      var p = new FindPanel({
        containerEl: container,
        fetchImpl: fetchImpl,
        getSession: function () { return 'sess-a'; },
      });
      p.open();
      p.runQuery('foo');
      flush().then(function () {
        var firstCtrl = fetchImpl.calls[0].opts.signal;
        assert.strictEqual(firstCtrl.aborted, false);
        p.runQuery('foob');
        return flush();
      }).then(function () {
        // First fetch's signal MUST now be aborted; second fetch is fresh.
        var firstCtrl = fetchImpl.calls[0].opts.signal;
        var secondCtrl = fetchImpl.calls[1].opts.signal;
        assert.strictEqual(firstCtrl.aborted, true, 'prior fetch must be aborted');
        assert.strictEqual(secondCtrl.aborted, false, 'new fetch must not be aborted');
        done();
      });
    });
  });

  describe('keyboard navigation + open semantics', function () {
    function setupWithMatches(matches) {
      var fetchImpl = makeFetchSpy(makeResp(matches));
      var clicks = [];
      var p = new FindPanel({
        containerEl: container,
        fetchImpl: fetchImpl,
        getSession: function () { return 'sess-a'; },
        onResultClick: function (e) { clicks.push(e); },
      });
      p.open();
      return { panel: p, fetchImpl: fetchImpl, clicks: clicks };
    }

    function key(panel, opts) {
      opts = opts || {};
      var ev = new panel._inputEl.ownerDocument.defaultView.KeyboardEvent('keydown', {
        key: opts.key,
        bubbles: true,
        cancelable: true,
      });
      // JSDOM's KeyboardEvent constructor doesn't accept ctrlKey/metaKey
      // via init dict; set them after construction.
      Object.defineProperty(ev, 'ctrlKey', { value: !!opts.ctrlKey });
      Object.defineProperty(ev, 'metaKey', { value: !!opts.metaKey });
      panel._inputEl.dispatchEvent(ev);
      return ev;
    }

    it('Enter on focused row opens preview tab', function (done) {
      var matches = [
        { path: '/a/app.js', basename: 'app.js' },
        { path: '/b/util.js', basename: 'util.js' },
      ];
      var s = setupWithMatches(matches);
      s.panel.runQuery('a');
      flush().then(function () {
        try {
          // First match auto-focused after fetch.
          assert.strictEqual(s.panel._focusedIndex, 0, 'focusedIndex after fetch: ' + s.panel._focusedIndex);
          key(s.panel, { key: 'Enter' });
          // assert.deepStrictEqual would fail across JSDOM/Node realms
          // (the literal is constructed inside the FindPanel's JSDOM
          // realm so its prototype differs); compare fields directly.
          assert.strictEqual(s.clicks.length, 1, 'clicks after Enter: ' + s.clicks.length);
          assert.strictEqual(s.clicks[0].path, '/a/app.js');
          assert.strictEqual(s.clicks[0].mode, 'preview');
          // Panel closes after activate.
          assert.strictEqual(s.panel.isOpen(), false);
          done();
        } catch (e) { done(e); }
      });
    });

    it('Cmd+Enter on focused row opens editor tab', function (done) {
      var matches = [{ path: '/a/app.js', basename: 'app.js' }];
      var s = setupWithMatches(matches);
      s.panel.runQuery('a');
      flush().then(function () {
        try {
          key(s.panel, { key: 'Enter', metaKey: true });
          assert.strictEqual(s.clicks.length, 1);
          assert.strictEqual(s.clicks[0].path, '/a/app.js');
          assert.strictEqual(s.clicks[0].mode, 'editor');
          done();
        } catch (e) { done(e); }
      });
    });

    it('Ctrl+Enter on focused row opens editor tab (Linux/Windows)', function (done) {
      var matches = [{ path: '/a/app.js', basename: 'app.js' }];
      var s = setupWithMatches(matches);
      s.panel.runQuery('a');
      flush().then(function () {
        try {
          key(s.panel, { key: 'Enter', ctrlKey: true });
          assert.strictEqual(s.clicks.length, 1);
          assert.strictEqual(s.clicks[0].path, '/a/app.js');
          assert.strictEqual(s.clicks[0].mode, 'editor');
          done();
        } catch (e) { done(e); }
      });
    });

    it('ArrowDown / ArrowUp move focus, clamped at boundaries', function (done) {
      var matches = [
        { path: '/a/app.js', basename: 'app.js' },
        { path: '/b/util.js', basename: 'util.js' },
        { path: '/c/lib.js', basename: 'lib.js' },
      ];
      var s = setupWithMatches(matches);
      s.panel.runQuery('a');
      flush().then(function () {
        assert.strictEqual(s.panel._focusedIndex, 0);
        key(s.panel, { key: 'ArrowDown' });
        assert.strictEqual(s.panel._focusedIndex, 1);
        key(s.panel, { key: 'ArrowDown' });
        assert.strictEqual(s.panel._focusedIndex, 2);
        // Clamp at end.
        key(s.panel, { key: 'ArrowDown' });
        assert.strictEqual(s.panel._focusedIndex, 2);
        key(s.panel, { key: 'ArrowUp' });
        assert.strictEqual(s.panel._focusedIndex, 1);
        key(s.panel, { key: 'ArrowUp' });
        assert.strictEqual(s.panel._focusedIndex, 0);
        // Clamp at start.
        key(s.panel, { key: 'ArrowUp' });
        assert.strictEqual(s.panel._focusedIndex, 0);
        done();
      });
    });

    it('Escape closes the panel', function () {
      var s = setupWithMatches([]);
      key(s.panel, { key: 'Escape' });
      assert.strictEqual(s.panel.isOpen(), false);
    });

    it('Enter with no results is a no-op (does not throw)', function () {
      var s = setupWithMatches([]);
      key(s.panel, { key: 'Enter' });
      assert.strictEqual(s.clicks.length, 0);
    });
  });

  describe('result rendering', function () {
    it('renders basename + parent in separate spans', function (done) {
      var matches = [{ path: '/Users/foo/code/src/app.js', basename: 'app.js' }];
      var fetchImpl = makeFetchSpy(makeResp(matches));
      var p = new FindPanel({
        containerEl: container, fetchImpl: fetchImpl,
        getSession: function () { return 's'; },
      });
      p.open();
      p.runQuery('app');
      flush().then(function () {
        var basenameEl = container.querySelector('.fb-find-result-basename');
        var parentEl = container.querySelector('.fb-find-result-parent');
        assert.ok(basenameEl, 'basename span rendered');
        assert.strictEqual(basenameEl.textContent, 'app.js');
        assert.ok(parentEl, 'parent span rendered');
        assert.ok(parentEl.textContent.indexOf('/Users/foo/code/src') !== -1);
        done();
      });
    });

    it('shows truncation banner when server reports truncated=true', function (done) {
      var fetchImpl = makeFetchSpy(makeResp([{ path: '/a/app.js', basename: 'app.js' }],
        { truncated: true, totalFound: 50000 }));
      var p = new FindPanel({
        containerEl: container, fetchImpl: fetchImpl,
        getSession: function () { return 's' },
      });
      p.open();
      p.runQuery('app');
      flush().then(function () {
        var banner = container.querySelector('.fb-find-truncation');
        assert.ok(banner, 'banner rendered');
        assert.notStrictEqual(banner.style.display, 'none');
        assert.ok(banner.textContent.indexOf('50000') !== -1);
        done();
      });
    });
  });
});
