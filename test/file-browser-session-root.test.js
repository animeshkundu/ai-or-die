// Tests for the per-tab file-browser root behaviour (client side):
//   - navigateTo() forwards the active session id as the `session` query
//     param (so the server can resolve the default root on a cold cache),
//     and only sends `path` when a dir is explicitly given.
//   - navigateTo() stores the server-reported `home` and (re)connects the
//     fs-watcher to the server-resolved currentPath.
//   - navigateHome() roots at the stored session `home`, not the sandbox base.
//   - notifyActiveSessionChanged() re-roots an OPEN panel (path-less, so the
//     server resolves the new session's root) and no-ops when closed / same
//     session.
//
// FileBrowserPanel is browser-DOM-bound; we stub the minimal window/document
// surface and the DOM-heavy render methods, but exercise the REAL navigateTo /
// navigateHome / notifyActiveSessionChanged so the query-string + home +
// watcher logic is actually covered.

const assert = require('assert');

let _origWindow, _origDocument;

function installBrowserStubs() {
  _origWindow = global.window;
  _origDocument = global.document;
  global.window = { innerWidth: 1280 };
  global.document = {
    createElement: () => ({
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      addEventListener() {}, appendChild() {}, setAttribute() {}, style: {}, dataset: {},
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

// Flush pending microtasks/timers so navigateTo's fetch .then runs.
function flush() { return new Promise((r) => setTimeout(r, 0)); }

describe('FileBrowserPanel — per-tab session root (client)', function () {
  let fetches, watcherConnects, lastResponse;

  function makePanel(opts) {
    fetches = [];
    watcherConnects = [];
    // Default server response; tests can override lastResponse fields.
    lastResponse = {
      currentPath: '/proj/cwd', baseFolder: '/base', home: '/proj/cwd',
      items: [], totalCount: 0, offset: 0, limit: 500, parentPath: null,
    };
    const fakeWatcher = { connect: (p) => watcherConnects.push(p) };

    function FakePanel(o) { FileBrowserPanel.call(this, o); }
    FakePanel.prototype = Object.create(FileBrowserPanel.prototype);
    FakePanel.prototype._buildDOM = function () {
      const el = { classList: { add() {}, remove() {}, contains: () => false }, addEventListener() {} };
      this._panelEl = el; this._backdropEl = el;
    };
    FakePanel.prototype._updateOverlayMode = function () {};
    FakePanel.prototype._announceToScreenReader = function () {};
    FakePanel.prototype._adjustTerminal = function () {};
    FakePanel.prototype._renderBreadcrumbs = function () {};
    FakePanel.prototype._renderItems = function () {};
    FakePanel.prototype._showBrowseView = function () {};
    FakePanel.prototype._reconcileListingSubscriptions = function () {};
    FakePanel.prototype._ensureFileWatcher = function () { return fakeWatcher; };

    const panel = new FakePanel(Object.assign({
      authFetch: (url) => {
        fetches.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(lastResponse),
        });
      },
    }, opts));
    panel._statusBar = { textContent: '' };
    return panel;
  }

  function urlParams(url) {
    return new URL('http://x' + url.slice(url.indexOf('?'))).searchParams;
  }

  before(installBrowserStubs);
  after(restoreBrowserStubs);

  it('forwards the session id and omits path when navigateTo(null)', async function () {
    const panel = makePanel({ getSessionId: () => 'sess-1' });
    panel.navigateTo(null);
    await flush();
    assert.strictEqual(fetches.length, 1);
    const p = urlParams(fetches[0]);
    assert.strictEqual(p.get('session'), 'sess-1');
    assert.strictEqual(p.get('path'), null, 'no explicit path should be sent');
  });

  it('sends both path and session when a dir is given', async function () {
    const panel = makePanel({ getSessionId: () => 'sess-1' });
    panel.navigateTo('/proj/cwd/sub');
    await flush();
    const p = urlParams(fetches[0]);
    assert.strictEqual(p.get('path'), '/proj/cwd/sub');
    assert.strictEqual(p.get('session'), 'sess-1');
  });

  it('omits session when no getSessionId is wired (back-compat)', async function () {
    const panel = makePanel({});
    panel.navigateTo('/x');
    await flush();
    assert.strictEqual(urlParams(fetches[0]).get('session'), null);
  });

  it('stores server home and reconnects the watcher to currentPath', async function () {
    const panel = makePanel({ getSessionId: () => 'sess-1' });
    lastResponse.currentPath = '/proj/cwd';
    lastResponse.home = '/proj/cwd';
    panel.navigateTo(null);
    await flush();
    assert.strictEqual(panel._homePath, '/proj/cwd');
    assert.deepStrictEqual(watcherConnects, ['/proj/cwd']);
  });

  it('navigateHome roots at the stored session home, not baseFolder', async function () {
    const panel = makePanel({ getSessionId: () => 'sess-1' });
    lastResponse.currentPath = '/proj/cwd/deep';
    lastResponse.home = '/proj/cwd';
    lastResponse.baseFolder = '/base';
    panel.navigateTo('/proj/cwd/deep');
    await flush();
    assert.strictEqual(panel._homePath, '/proj/cwd');
    fetches.length = 0;
    panel.navigateHome();
    await flush();
    assert.strictEqual(urlParams(fetches[0]).get('path'), '/proj/cwd',
      'navigateHome should target the session home');
  });

  it('notifyActiveSessionChanged re-roots an open panel path-lessly', async function () {
    let sid = 'sess-A';
    const panel = makePanel({ getSessionId: () => sid });
    panel._open = true;
    panel.navigateTo(null);          // initial render for sess-A
    await flush();
    assert.strictEqual(panel._lastRenderedSession, 'sess-A');
    fetches.length = 0;
    sid = 'sess-B';                   // app switched the active session
    panel.notifyActiveSessionChanged('sess-B');
    await flush();
    assert.strictEqual(fetches.length, 1, 'should re-fetch on session change');
    const p = urlParams(fetches[0]);
    assert.strictEqual(p.get('session'), 'sess-B');
    assert.strictEqual(p.get('path'), null, 're-root must be path-less so server picks the new root');
  });

  it('notifyActiveSessionChanged is a no-op when closed or unchanged', async function () {
    const panel = makePanel({ getSessionId: () => 'sess-A' });
    // Closed panel → no fetch.
    panel._open = false;
    panel.notifyActiveSessionChanged('sess-B');
    await flush();
    assert.strictEqual(fetches.length, 0, 'closed panel should not re-fetch');
    // Open, render A, then notify A again → no-op.
    panel._open = true;
    panel.navigateTo(null);
    await flush();
    fetches.length = 0;
    panel.notifyActiveSessionChanged('sess-A');
    await flush();
    assert.strictEqual(fetches.length, 0, 'same session should not re-fetch');
  });
});
