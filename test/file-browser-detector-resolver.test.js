// test/file-browser-detector-resolver.test.js — regression for the
// architect's audit ask on `TerminalPathDetector` (right-click selection
// menu). Pre-fix the detector stat'd the bare selection text — so a
// relative selection like "src/app.js" was sent to /api/files/stat
// raw and the server resolved it against process.cwd() (baseFolder),
// NOT the session's workingDir. For any Claude/Codex/Gemini session
// whose workingDir was a subdirectory of baseFolder, every right-click
// "Open in File Viewer" / "Edit" / "Download" silently disabled the
// menu (the stat returned 404).
//
// Post-fix the detector walks the same resolveCandidates() chain the
// link provider uses, threaded with the per-session sessionIdSource
// (so splits hit THEIR own workingDir, not the foreground tab's).

'use strict';

const assert = require('assert');

let _origWindow, _origDocument;
function installBrowserStubs() {
  _origWindow = global.window;
  _origDocument = global.document;
  const fakeEl = () => ({
    classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); }, toggle(c) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, setAttribute() {},
    style: {}, dataset: {}, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ right: 0, bottom: 0, width: 0, height: 0 }),
    parentNode: null,
  });
  global.window = { innerWidth: 1280, innerHeight: 800, requestAnimationFrame: (fn) => setImmediate(fn) };
  global.document = {
    createElement: () => fakeEl(),
    body: { appendChild() {} },
    addEventListener() {}, removeEventListener() {},
  };
  global.requestAnimationFrame = window.requestAnimationFrame;
}
function restoreBrowserStubs() {
  if (_origWindow === undefined) delete global.window; else global.window = _origWindow;
  if (_origDocument === undefined) delete global.document; else global.document = _origDocument;
}
installBrowserStubs();
delete require.cache[require.resolve('../src/public/file-browser')];
const fb = require('../src/public/file-browser');

describe('TerminalPathDetector — resolver chain', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  // Fake xterm-shaped terminal with a stub element so init() doesn't bail.
  function makeFakeTerm() {
    return {
      element: { addEventListener() {}, removeEventListener() {} },
      getSelection: () => '',
    };
  }

  // Fake app exposing the resolver-chain helpers TerminalPathDetector
  // now consults. Mirrors the real app's contract.
  function makeFakeApp(opts) {
    const _liveCwd = new Map(Object.entries(opts.liveCwd || {}));
    const _sessionWorkingDirs = new Map(Object.entries(opts.workingDirs || {}));
    return {
      _liveCwd,
      _sessionWorkingDirs,
      claudeSessions: opts.claudeSessions || [],
      currentClaudeSessionId: opts.currentClaudeSessionId || null,
      currentFolderPath: opts.currentFolderPath || null,
      getSessionWorkingDir(sid) {
        if (!sid) return null;
        if (_liveCwd.has(sid) && _liveCwd.get(sid)) return _liveCwd.get(sid);
        if (_sessionWorkingDirs.has(sid) && _sessionWorkingDirs.get(sid)) return _sessionWorkingDirs.get(sid);
        const s = (opts.claudeSessions || []).find(x => x.id === sid);
        return (s && s.workingDir) || null;
      },
      _getRepoRootCached: (sid) => opts.repoRoots ? (opts.repoRoots[sid] || null) : null,
      getCurrentWorkingDir() {
        return this.getSessionWorkingDir(this.currentClaudeSessionId) || this.currentFolderPath || null;
      },
    };
  }

  // Invokes _showMenu with a path hint. Returns the stat URLs touched
  // (so we can assert which candidate the chain picked).
  function probeShowMenu(detector, hint, statResponder) {
    const urls = [];
    detector.authFetch = (url) => {
      urls.push(url);
      const resp = statResponder(url);
      return Promise.resolve(resp);
    };
    return new Promise((resolve) => {
      // _showMenu fires the stat chain asynchronously; setImmediate
      // after the call gives microtasks + the requestAnimationFrame
      // shim time to drain.
      detector._showMenu(0, 0, { path: hint, line: null, col: null });
      const flush = () => setImmediate(() => setImmediate(() => setImmediate(() => resolve(urls))));
      flush();
    });
  }

  it('resolves a relative selection against the session workingDir (not the global baseFolder)', async function () {
    const app = makeFakeApp({
      currentClaudeSessionId: 'sessA',
      currentFolderPath: '/global/folder',     // legacy fallback — must NOT be used
      workingDirs: { sessA: '/proj/A' },
    });
    const det = new fb.TerminalPathDetector({
      authFetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ editable: true }) }),
      terminal: makeFakeTerm(),
      app: app,
      getSessionId: () => 'sessA',
    });
    det.init();

    const urls = await probeShowMenu(det, 'src/app.js', (url) => {
      // Stat 200s only for the session-dir join.
      const target = '/api/files/stat?path=' + encodeURIComponent('/proj/A/src/app.js');
      if (url === target) return { ok: true, status: 200, json: () => Promise.resolve({ editable: true }) };
      return { ok: false, status: 404, json: () => Promise.resolve({}) };
    });

    // Should have tried /proj/A/src/app.js — the session's workingDir join.
    assert.ok(urls.some(u => u.includes(encodeURIComponent('/proj/A/src/app.js'))),
      'expected stat against session workingDir; got: ' + JSON.stringify(urls));
    // Should NOT have tried /global/folder/src/app.js (the legacy fallback).
    assert.ok(!urls.some(u => u.includes(encodeURIComponent('/global/folder/src/app.js'))),
      'expected NO stat against the global folder fallback; got: ' + JSON.stringify(urls));
  });

  it('honours the split-pane sessionId source even when currentClaudeSessionId points elsewhere', async function () {
    const app = makeFakeApp({
      currentClaudeSessionId: 'sessA',     // foreground tab
      workingDirs: { sessA: '/proj/A', sessB: '/proj/B' },
    });
    const det = new fb.TerminalPathDetector({
      authFetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ editable: true }) }),
      terminal: makeFakeTerm(),
      app: app,
      getSessionId: () => 'sessB',         // split pane belongs to B
    });
    det.init();

    const urls = await probeShowMenu(det, 'src/onlyB.js', (url) => {
      const target = '/api/files/stat?path=' + encodeURIComponent('/proj/B/src/onlyB.js');
      if (url === target) return { ok: true, status: 200, json: () => Promise.resolve({ editable: true }) };
      return { ok: false, status: 404, json: () => Promise.resolve({}) };
    });

    // Right answer: stat against B's workingDir, NOT A's.
    assert.ok(urls.some(u => u.includes(encodeURIComponent('/proj/B/src/onlyB.js'))),
      'expected stat against split B\'s workingDir; got: ' + JSON.stringify(urls));
    assert.ok(!urls.some(u => u.includes(encodeURIComponent('/proj/A/src/onlyB.js'))),
      'expected NO stat against foreground A\'s workingDir; got: ' + JSON.stringify(urls));
  });

  it('falls back to raw hint when no resolver context is available (legacy embedders)', async function () {
    // Detector built without getSessionId and without an app; should
    // still try the hint as-is so a pre-Layer-4 absolute-path call
    // path doesn't break.
    const det = new fb.TerminalPathDetector({
      authFetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ editable: true }) }),
      terminal: makeFakeTerm(),
    });
    det.init();

    const urls = await probeShowMenu(det, '/abs/path.js', (url) => {
      if (url.includes(encodeURIComponent('/abs/path.js'))) {
        return { ok: true, status: 200, json: () => Promise.resolve({ editable: true }) };
      }
      return { ok: false, status: 404, json: () => Promise.resolve({}) };
    });
    assert.ok(urls.some(u => u.includes(encodeURIComponent('/abs/path.js'))),
      'expected stat against the literal absolute hint; got: ' + JSON.stringify(urls));
  });
});

// ---------------------------------------------------------------------------
// getSessionWorkingDir is a method on the app class (src/public/app.js)
// rather than on file-browser.js, so the behaviour the architect's
// Layer-2 ask requires is asserted indirectly via the resolver-chain
// test above + the existing test/link-provider-resolver-chain.test.js
// "does NOT fall back to getCwd when getWorkingDir is wired" case.
//
// (Adding a direct unit test for ClaudeCodeWebInterface methods would
// require pulling in the whole xterm/Monaco stack just to instantiate
// the class — out of proportion for a 6-LOC helper. The e2e spec
// e2e/tests/67-click-split-pane-sessionid.spec.js covers the
// integrated behaviour end-to-end.)
// ---------------------------------------------------------------------------
