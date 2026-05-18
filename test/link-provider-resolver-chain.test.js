// test/link-provider-resolver-chain.test.js — regression coverage for the
// attachLinkProvider activate-time resolver wiring.
//
// Two regressions in scope (both from the file-browser-v2-followup
// post-PR-108 diagnosis):
//
//   1. Layer 2 — silent currentFolderPath fallback. When the host wires
//      the new getLiveCwd/getWorkingDir callbacks, attachLinkProvider
//      MUST NOT fall through to the legacy getCwd() (which app.js maps
//      to the global folder picker). Doing so resolves a session-scoped
//      click against the wrong directory and silently 404s — or worse,
//      opens an unrelated file that happens to share the relative path.
//
//   2. Layer 4 / split-pane sessionId mismatch. Splits register their
//      own getLiveCwd/getWorkingDir callbacks; verify those callbacks
//      are invoked at click time (not registration time) so a session-
//      switch between attach and click picks up the new session's
//      values.
//
// File-browser.js is a browser IIFE; we install minimal window/document
// stubs (same pattern as test/file-browser-getcwd.test.js) and stub
// xterm's registerLinkProvider so we can capture the provider object
// and exercise its provideLinks → link.activate flow directly.

'use strict';

const assert = require('assert');

let _origWindow, _origDocument;
function installBrowserStubs() {
  _origWindow = global.window;
  _origDocument = global.document;
  global.window = { innerWidth: 1280 };
  global.document = {
    createElement: () => ({
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      addEventListener() {}, appendChild() {}, setAttribute() {},
      style: {}, dataset: {},
    }),
    body: { appendChild() {} }, addEventListener() {},
  };
}
function restoreBrowserStubs() {
  if (_origWindow === undefined) delete global.window; else global.window = _origWindow;
  if (_origDocument === undefined) delete global.document; else global.document = _origDocument;
}
installBrowserStubs();
delete require.cache[require.resolve('../src/public/file-browser')];
const fb = require('../src/public/file-browser');

// Build a minimal xterm-shaped terminal object whose registerLinkProvider
// captures the provider so the test can invoke provideLinks(y, cb) directly.
function makeFakeTerminal(line) {
  const provider = { captured: null };
  const term = {
    registerLinkProvider(p) { provider.captured = p; return { dispose() {} }; },
    buffer: {
      active: {
        length: 1,
        getLine: (y) => y === 0
          ? { translateToString: () => line }
          : null,
      },
    },
  };
  return { term, provider };
}

// Helper: attach the link provider, drive provideLinks for row 1, return
// the first link's activate function. Errors loudly if no link found —
// the regex/match cases are covered by sibling test files; here we only
// need that ONE link materialises so we can test the resolver.
function attachAndGetActivate(opts, lineText) {
  const { term, provider } = makeFakeTerminal(lineText);
  const merged = Object.assign({ terminal: term }, opts);
  if (typeof merged.authFetch !== 'function') merged.authFetch = () => Promise.resolve({ status: 200, ok: true });
  if (typeof merged.openInViewer !== 'function') merged.openInViewer = () => {};
  fb.attachLinkProvider(merged);
  let activate = null;
  provider.captured.provideLinks(1, (links) => {
    if (!links || !links.length) throw new Error('no links materialised for: ' + JSON.stringify(lineText));
    activate = links[0].activate;
  });
  return activate;
}

describe('attachLinkProvider — resolver chain', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  // ------------------------------------------------------------------
  // Layer 2 — back-compat fallback gate
  // ------------------------------------------------------------------

  describe('Layer 2: back-compat getCwd fallback', function () {
    it('falls back to legacy getCwd when neither getLiveCwd nor getWorkingDir is supplied', function (done) {
      const statCalls = [];
      const opens = [];
      const activate = attachAndGetActivate({
        getCwd: () => '/legacy/cwd',
        authFetch: (url) => {
          statCalls.push(url);
          return Promise.resolve({ status: 200, ok: true });
        },
        openInViewer: (p) => opens.push(p),
      }, ' src/foo.js ');

      activate(null, null);
      // Stat is async; give it a microtask flush.
      setImmediate(() => {
        try {
          // The legacy getCwd was the only context — chain joined against it.
          assert.ok(statCalls.some(u => u.includes('%2Flegacy%2Fcwd%2Fsrc%2Ffoo.js')),
            'expected stat against legacy cwd; got: ' + JSON.stringify(statCalls));
          assert.deepStrictEqual(opens, ['/legacy/cwd/src/foo.js']);
          done();
        } catch (e) { done(e); }
      });
    });

    it('does NOT fall back to getCwd when getWorkingDir is wired (even if it returns null)', function (done) {
      // The regression: getCwd returns the global folder picker; when
      // getWorkingDir was wired but momentarily null, the old code
      // silently treated /global/folder as the session's workingDir.
      const statCalls = [];
      const opens = [];
      const errs = [];
      const activate = attachAndGetActivate({
        getCwd: () => '/global/folder',          // would be wrong-dir
        getLiveCwd: () => null,
        getWorkingDir: () => null,                // session not known YET
        getRepoRoot: () => null,
        authFetch: (url) => {
          statCalls.push(url);
          return Promise.resolve({ status: 200, ok: true });
        },
        openInViewer: (p) => opens.push(p),
        feedback: { error: (m) => errs.push(m), warning: () => {}, info: () => {} },
      }, ' src/foo.js ');

      activate(null, null);
      setImmediate(() => {
        try {
          // No candidates → no stat calls → no open.
          assert.deepStrictEqual(statCalls, [],
            'expected NO stat against /global/folder; got: ' + JSON.stringify(statCalls));
          assert.deepStrictEqual(opens, [],
            'expected NO open call; got: ' + JSON.stringify(opens));
          // User sees a "could not resolve" error rather than the
          // silent wrong-dir-then-404 sequence.
          assert.ok(errs.some(m => /could not resolve|file not found/i.test(m)),
            'expected user-visible "could not resolve / not found" error; got: ' + JSON.stringify(errs));
          done();
        } catch (e) { done(e); }
      });
    });

    it('respects getWorkingDir over legacy getCwd when getWorkingDir returns a value', function (done) {
      const opens = [];
      const activate = attachAndGetActivate({
        getCwd: () => '/wrong/cwd',
        getLiveCwd: () => null,
        getWorkingDir: () => '/correct/session-dir',
        getRepoRoot: () => null,
        authFetch: () => Promise.resolve({ status: 200, ok: true }),
        openInViewer: (p) => opens.push(p),
      }, ' src/foo.js ');

      activate(null, null);
      setImmediate(() => {
        try {
          assert.deepStrictEqual(opens, ['/correct/session-dir/src/foo.js'],
            'expected open against getWorkingDir, NOT legacy getCwd; got: ' + JSON.stringify(opens));
          done();
        } catch (e) { done(e); }
      });
    });
  });

  // ------------------------------------------------------------------
  // Layer 4 — split-pane sessionId mismatch (closures evaluated at click time)
  // ------------------------------------------------------------------

  describe('Layer 4: callbacks evaluated at click time, not registration time', function () {
    it('re-reads getWorkingDir on every activate (so split-pane sessionId switches take effect)', function (done) {
      // Simulate a split pane that initially points at session A,
      // then re-binds to session B mid-life. The link provider was
      // attached ONCE at split create time; the getWorkingDir closure
      // closes over `split.sessionId`, which the host updates on
      // re-bind. Verify the NEXT click picks up the new value
      // without re-attachment.
      let currentSid = 'sessionA';
      const dirsBySid = { sessionA: '/proj-A', sessionB: '/proj-B' };
      const opens = [];
      const activate = attachAndGetActivate({
        getCwd: () => null,
        getLiveCwd: () => null,
        getWorkingDir: () => dirsBySid[currentSid] || null,
        getRepoRoot: () => null,
        authFetch: () => Promise.resolve({ status: 200, ok: true }),
        openInViewer: (p) => opens.push(p),
      }, ' src/foo.js ');

      // First click: still on session A.
      activate(null, null);
      setImmediate(() => {
        try {
          assert.deepStrictEqual(opens, ['/proj-A/src/foo.js'],
            'first click should resolve against session A; got: ' + JSON.stringify(opens));
          // Host re-binds the split to session B; getWorkingDir closure
          // closes over the same `currentSid` mutable.
          currentSid = 'sessionB';
          activate(null, null);
          setImmediate(() => {
            try {
              assert.deepStrictEqual(opens, ['/proj-A/src/foo.js', '/proj-B/src/foo.js'],
                'second click should resolve against session B (closure re-evaluated); got: ' + JSON.stringify(opens));
              done();
            } catch (e) { done(e); }
          });
        } catch (e) { done(e); }
      });
    });
  });
});
