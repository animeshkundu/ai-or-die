// Tests for the getCwd callback wired into FileBrowserPanel.open() — the
// resolution order startPath → getCwd() → initialPath → null must be
// honoured, getCwd must be invoked on every open() (so a session switch
// between opens picks up the new cwd), and a getCwd that throws must not
// break the panel (defensive coding per docs/agent-instructions/05).
//
// FileBrowserPanel is browser-DOM-bound. Rather than pulling in jsdom,
// this suite stubs the minimal `document`/`window` surface and overrides
// the DOM-heavy prototype methods (`_buildDOM`, `_updateOverlayMode`,
// `navigateTo`, `_announceToScreenReader`, `_adjustTerminal`) to no-ops.
// The behaviour under test — open()'s startPath/getCwd/initialPath fallback
// chain — is fully covered without spinning up a real DOM.

const assert = require('assert');

// ---------------------------------------------------------------------------
// Minimal browser globals — installed before requiring file-browser.js so
// the IIFE's checks for `typeof window` and `document` see something sane.
// We restore the originals in `after()` so other tests in the suite are
// unaffected.
// ---------------------------------------------------------------------------

let _origWindow, _origDocument;

function installBrowserStubs() {
  _origWindow = global.window;
  _origDocument = global.document;
  global.window = { innerWidth: 1280 };
  global.document = {
    createElement: () => ({
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      addEventListener() {},
      appendChild() {},
      setAttribute() {},
      style: {},
      dataset: {},
    }),
    body: { appendChild() {} },
    addEventListener() {},
  };
}

function restoreBrowserStubs() {
  if (_origWindow === undefined) delete global.window; else global.window = _origWindow;
  if (_origDocument === undefined) delete global.document; else global.document = _origDocument;
}

installBrowserStubs();
const { FileBrowserPanel } = require('../src/public/file-browser');

describe('FileBrowserPanel.getCwd callback', function () {
  let panel, calls;

  before(installBrowserStubs);
  after(restoreBrowserStubs);

  beforeEach(function () {
    calls = { getCwd: 0, navigateTo: [] };
    // Build a panel with the DOM-heavy methods stubbed.
    const FakePanel = function (opts) { FileBrowserPanel.call(this, opts); };
    FakePanel.prototype = Object.create(FileBrowserPanel.prototype);
    FakePanel.prototype._buildDOM = function () {
      // Provide just enough fake DOM for open() to run without throwing.
      const el = {
        classList: { add() {}, remove() {}, contains: () => false },
        addEventListener() {},
      };
      this._panelEl = el;
      this._backdropEl = el;
    };
    FakePanel.prototype._updateOverlayMode = function () {};
    FakePanel.prototype.navigateTo = function (p) { calls.navigateTo.push(p); };
    FakePanel.prototype._announceToScreenReader = function () {};
    FakePanel.prototype._adjustTerminal = function () {};

    return { FakePanel };
  });

  function makePanel(opts) {
    function FakePanel(o) { FileBrowserPanel.call(this, o); }
    FakePanel.prototype = Object.create(FileBrowserPanel.prototype);
    FakePanel.prototype._buildDOM = function () {
      const el = { classList: { add() {}, remove() {} }, addEventListener() {} };
      this._panelEl = el;
      this._backdropEl = el;
    };
    FakePanel.prototype._updateOverlayMode = function () {};
    FakePanel.prototype.navigateTo = function (p) { calls.navigateTo.push(p); };
    FakePanel.prototype._announceToScreenReader = function () {};
    FakePanel.prototype._adjustTerminal = function () {};
    return new FakePanel(opts);
  }

  // -------------------------------------------------------------------------
  // Constructor wiring
  // -------------------------------------------------------------------------

  it('should accept a getCwd option', function () {
    panel = makePanel({ getCwd: () => '/tmp/foo' });
    assert.strictEqual(typeof panel.getCwd, 'function');
  });

  it('should ignore non-function getCwd values', function () {
    // Defensive: caller might pass null/string/object by mistake.
    panel = makePanel({ getCwd: '/tmp/foo' });
    assert.strictEqual(panel.getCwd, null);
    panel = makePanel({ getCwd: null });
    assert.strictEqual(panel.getCwd, null);
    panel = makePanel({});
    assert.strictEqual(panel.getCwd, null);
  });

  // -------------------------------------------------------------------------
  // open() resolution order: startPath → getCwd() → initialPath → null
  // -------------------------------------------------------------------------

  it('should prefer startPath over getCwd and initialPath', function () {
    panel = makePanel({
      initialPath: '/initial',
      getCwd: () => { calls.getCwd++; return '/cwd'; },
    });
    panel.open('/explicit');
    assert.deepStrictEqual(calls.navigateTo, ['/explicit']);
    // getCwd is allowed to be called (cheap), but the resolved path is /explicit.
  });

  it('should prefer getCwd over initialPath when no startPath is given', function () {
    panel = makePanel({
      initialPath: '/initial',
      getCwd: () => { calls.getCwd++; return '/cwd'; },
    });
    panel.open();
    assert.strictEqual(calls.getCwd, 1);
    assert.deepStrictEqual(calls.navigateTo, ['/cwd']);
  });

  it('should fall back to initialPath when getCwd returns null', function () {
    panel = makePanel({
      initialPath: '/initial',
      getCwd: () => { calls.getCwd++; return null; },
    });
    panel.open();
    assert.strictEqual(calls.getCwd, 1);
    assert.deepStrictEqual(calls.navigateTo, ['/initial']);
  });

  it('should fall back to initialPath when getCwd returns undefined', function () {
    panel = makePanel({
      initialPath: '/initial',
      getCwd: () => { calls.getCwd++; /* return undefined */ },
    });
    panel.open();
    assert.strictEqual(calls.getCwd, 1);
    assert.deepStrictEqual(calls.navigateTo, ['/initial']);
  });

  it('should fall back to initialPath when getCwd returns empty string', function () {
    panel = makePanel({
      initialPath: '/initial',
      getCwd: () => { calls.getCwd++; return ''; },
    });
    panel.open();
    assert.deepStrictEqual(calls.navigateTo, ['/initial']);
  });

  it('should fall back to null when no getCwd or initialPath is configured', function () {
    panel = makePanel({});
    panel.open();
    assert.deepStrictEqual(calls.navigateTo, [null]);
  });

  // -------------------------------------------------------------------------
  // Live behaviour: getCwd must be invoked on EVERY open(), not memoised at
  // construction time. This is the core of #14 — without it, the panel
  // captures the cwd at construction and stales when the user switches
  // sessions.
  // -------------------------------------------------------------------------

  it('should call getCwd on every open, not memoise the value', function () {
    let cwd = '/session-A';
    panel = makePanel({ getCwd: () => { calls.getCwd++; return cwd; } });

    panel.open();
    assert.strictEqual(calls.getCwd, 1);
    assert.deepStrictEqual(calls.navigateTo, ['/session-A']);

    panel.close();
    cwd = '/session-B'; // simulate user switching sessions

    panel.open();
    assert.strictEqual(calls.getCwd, 2);
    assert.deepStrictEqual(calls.navigateTo, ['/session-A', '/session-B']);
  });

  it('should not call getCwd if open() is already open (no-op re-open)', function () {
    panel = makePanel({ getCwd: () => { calls.getCwd++; return '/x'; } });
    panel.open();
    panel.open();
    panel.open();
    assert.strictEqual(calls.getCwd, 1);
  });

  // -------------------------------------------------------------------------
  // Defensive: a throwing getCwd must not break open() — fall through to
  // initialPath / null. Per docs/agent-instructions/05-defensive-coding.md,
  // a transient bug in the host app shouldn't render the panel unusable.
  // -------------------------------------------------------------------------

  it('should fall back gracefully when getCwd throws', function () {
    panel = makePanel({
      initialPath: '/initial',
      getCwd: () => { calls.getCwd++; throw new Error('boom'); },
    });
    assert.doesNotThrow(() => panel.open());
    assert.strictEqual(calls.getCwd, 1);
    assert.deepStrictEqual(calls.navigateTo, ['/initial']);
  });
});
