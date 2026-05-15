// test/auth-token-url.test.js — Regressions for QA #13 findings #2/#3/#4.
//
// Pure-helper coverage (Node-direct):
//   - sanitizeForLog scrubs `?token=…` and `Bearer …` from arbitrary
//     strings (defends finding #4).
//   - extractAndStripUrlToken extracts the URL token AND mutates the
//     address bar via history.replaceState so the URL is clean afterwards
//     (defends findings #2 + #3 in one shot).
//
// AuthManager.initialize() flow tests run against a stubbed window/fetch
// so they exercise: (a) URL token wins over a stale sessionStorage
// token; (b) URL is stripped on first init regardless of validity; (c)
// when neither URL nor SS token validates, the login prompt fires.

'use strict';

const assert = require('assert');

// ---------------------------------------------------------------------------
// Browser globals — install before requiring auth.js so the IIFE's
// `typeof window` / `typeof sessionStorage` checks see something sane.
// We track every mutation so each test can assert on it cleanly.
// ---------------------------------------------------------------------------

let _origWindow, _origDocument, _origURLSearchParams, _origFetch, _origSessionStorage;
let history, location, ssMap, fetchCalls, fetchHandler;

function makeFakeStorage() {
  var m = new Map();
  return {
    getItem: function (k) { return m.has(k) ? m.get(k) : null; },
    setItem: function (k, v) { m.set(k, String(v)); },
    removeItem: function (k) { m.delete(k); },
    clear: function () { m.clear(); },
    _map: m,
  };
}

function installBrowserStubs(opts) {
  opts = opts || {};
  _origWindow = global.window;
  _origDocument = global.document;
  _origURLSearchParams = global.URLSearchParams;
  _origFetch = global.fetch;
  _origSessionStorage = global.sessionStorage;

  ssMap = makeFakeStorage();
  fetchCalls = [];
  fetchHandler = opts.fetchHandler || (function () {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
  // Use Node's built-in URLSearchParams.
  global.URLSearchParams = require('url').URLSearchParams;
  global.sessionStorage = ssMap;

  location = {
    pathname: '/',
    search: opts.search || '',
    hash: opts.hash || '',
  };
  // history.replaceState records the new URL the page would display after.
  history = { calls: [], replaceState: function (state, title, url) {
    history.calls.push({ state: state, title: title, url: url });
    // Mutate location to match what a real browser does.
    var idx = url.indexOf('?');
    var hashIdx = url.indexOf('#');
    location.pathname = url.slice(0, idx === -1 ? (hashIdx === -1 ? url.length : hashIdx) : idx);
    location.search = idx === -1 ? '' : (hashIdx === -1 ? url.slice(idx) : url.slice(idx, hashIdx));
    location.hash = hashIdx === -1 ? '' : url.slice(hashIdx);
  }};

  global.window = {
    location: location,
    history: history,
    addEventListener: function () {},
  };
  global.document = {
    createElement: () => ({
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      addEventListener() {}, appendChild() {}, setAttribute() {}, style: {}, dataset: {},
    }),
    body: { appendChild() {} },
    getElementById: () => null,
  };
  global.fetch = function (url, init) {
    fetchCalls.push({ url: url, init: init });
    return Promise.resolve(fetchHandler(url, init));
  };
}

function restoreBrowserStubs() {
  if (_origWindow === undefined) delete global.window; else global.window = _origWindow;
  if (_origDocument === undefined) delete global.document; else global.document = _origDocument;
  if (_origURLSearchParams === undefined) delete global.URLSearchParams; else global.URLSearchParams = _origURLSearchParams;
  if (_origFetch === undefined) delete global.fetch; else global.fetch = _origFetch;
  if (_origSessionStorage === undefined) delete global.sessionStorage; else global.sessionStorage = _origSessionStorage;
}

function loadAuth() {
  delete require.cache[require.resolve('../src/public/auth')];
  return require('../src/public/auth');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth.js — URL-token + log-sanitization regressions (QA #13)', function () {

  describe('sanitizeForLog (finding #4)', function () {
    before(function () { installBrowserStubs(); });
    after(restoreBrowserStubs);

    it('redacts ?token=… inside arbitrary strings', function () {
      var auth = loadAuth();
      var msg = 'GET http://localhost:11500/api/x?token=secret123 failed';
      var clean = auth.sanitizeForLog(msg);
      assert.ok(clean.indexOf('secret123') === -1, 'token leaked: ' + clean);
      assert.ok(clean.indexOf('<redacted>') !== -1, 'no redaction marker: ' + clean);
    });

    it('redacts &token=… (not first-param form)', function () {
      var auth = loadAuth();
      var msg = '/api/foo?bar=1&token=hush';
      var clean = auth.sanitizeForLog(msg);
      assert.strictEqual(clean.indexOf('hush'), -1, 'token leaked: ' + clean);
      assert.ok(clean.indexOf('bar=1') !== -1, 'unrelated params must survive: ' + clean);
    });

    it('redacts Bearer headers in serialized header dumps', function () {
      var auth = loadAuth();
      var msg = "headers: { 'Authorization': 'Bearer ABCDEF1234.foo' }";
      var clean = auth.sanitizeForLog(msg);
      assert.strictEqual(clean.indexOf('ABCDEF1234'), -1, 'bearer leaked: ' + clean);
    });

    it('handles a multi-line stack-trace error message', function () {
      var auth = loadAuth();
      var stack = [
        'TypeError: Cannot read properties of undefined (reading "scope")',
        '    at http://localhost:11500/?token=foo:1:1',
        '    at /service-worker.js:1:1',
      ].join('\n');
      var clean = auth.sanitizeForLog(stack);
      assert.strictEqual(clean.indexOf('?token=foo'), -1, 'token leaked: ' + clean);
      assert.ok(clean.indexOf('?token=<redacted>') !== -1);
    });

    it('coerces non-string inputs and returns "" for null/undefined', function () {
      var auth = loadAuth();
      assert.strictEqual(auth.sanitizeForLog(null), '');
      assert.strictEqual(auth.sanitizeForLog(undefined), '');
      assert.strictEqual(auth.sanitizeForLog(42), '42');
    });

    it('passes through messages with no token reference unchanged', function () {
      var auth = loadAuth();
      var msg = 'Plain old error message with no token references.';
      assert.strictEqual(auth.sanitizeForLog(msg), msg);
    });
  });

  describe('extractAndStripUrlToken (findings #2 + #3)', function () {
    afterEach(restoreBrowserStubs);

    it('extracts the token AND strips it from the URL', function () {
      installBrowserStubs({ search: '?token=abc123' });
      var auth = loadAuth();
      var t = auth.extractAndStripUrlToken();
      assert.strictEqual(t, 'abc123', 'token extraction');
      assert.strictEqual(history.calls.length, 1, 'history.replaceState must fire');
      assert.strictEqual(history.calls[0].url, '/');
      assert.strictEqual(window.location.search, '');
    });

    it('preserves other query params when stripping the token', function () {
      installBrowserStubs({ search: '?session=foo&token=abc&other=1' });
      var auth = loadAuth();
      var t = auth.extractAndStripUrlToken();
      assert.strictEqual(t, 'abc');
      assert.strictEqual(history.calls.length, 1);
      var newUrl = history.calls[0].url;
      assert.ok(newUrl.indexOf('token=') === -1, 'token must be stripped');
      assert.ok(newUrl.indexOf('session=foo') !== -1, 'session= must survive: ' + newUrl);
      assert.ok(newUrl.indexOf('other=1') !== -1, 'other= must survive: ' + newUrl);
    });

    it('preserves the URL hash fragment', function () {
      installBrowserStubs({ search: '?token=xyz', hash: '#ondark' });
      var auth = loadAuth();
      auth.extractAndStripUrlToken();
      assert.strictEqual(history.calls[0].url, '/#ondark');
    });

    it('returns null and does NOT mutate history when no token present', function () {
      installBrowserStubs({ search: '?other=1' });
      var auth = loadAuth();
      var t = auth.extractAndStripUrlToken();
      assert.strictEqual(t, null);
      assert.strictEqual(history.calls.length, 0,
        'no history mutation for a token-less URL');
    });

    it('returns null on an empty query string', function () {
      installBrowserStubs({ search: '' });
      var auth = loadAuth();
      assert.strictEqual(auth.extractAndStripUrlToken(), null);
    });

    it('survives missing window.history (best-effort)', function () {
      installBrowserStubs({ search: '?token=zzz' });
      window.history = null;
      var auth = loadAuth();
      // Returns the token even when we can't strip the URL.
      assert.strictEqual(auth.extractAndStripUrlToken(), 'zzz');
    });
  });

  describe('AuthManager.initialize() URL-token flow', function () {
    afterEach(restoreBrowserStubs);

    function jsonResponse(data) {
      return { ok: true, status: 200, json: () => Promise.resolve(data) };
    }

    it('uses URL token and skips the login prompt when valid', async function () {
      installBrowserStubs({
        search: '?token=urlT0K',
        fetchHandler: function (url, init) {
          if (url.indexOf('/auth-status') !== -1) return jsonResponse({ authRequired: true });
          if (url.indexOf('/auth-verify') !== -1) {
            // Token comes through as JSON body — verify it's the URL one.
            var body = JSON.parse(init.body);
            return jsonResponse({ valid: body.token === 'urlT0K' });
          }
          return jsonResponse({});
        },
      });
      var auth = loadAuth();
      var mgr = new auth.AuthManager();
      var ok = await mgr.initialize();
      assert.strictEqual(ok, true, 'URL token should auto-authenticate');
      // sessionStorage now holds the URL token.
      assert.strictEqual(ssMap.getItem('cc-web-token'), 'urlT0K');
      // URL has been stripped.
      assert.strictEqual(history.calls.length, 1);
      assert.strictEqual(window.location.search, '');
    });

    it('URL token wins over a stale sessionStorage token', async function () {
      installBrowserStubs({
        search: '?token=fresh',
        fetchHandler: function (url, init) {
          if (url.indexOf('/auth-status') !== -1) return jsonResponse({ authRequired: true });
          if (url.indexOf('/auth-verify') !== -1) {
            var body = JSON.parse(init.body);
            // Stale token rejected, fresh one accepted.
            return jsonResponse({ valid: body.token === 'fresh' });
          }
          return jsonResponse({});
        },
      });
      ssMap.setItem('cc-web-token', 'stale');  // pre-existing stale token
      var auth = loadAuth();
      var mgr = new auth.AuthManager();
      // Constructor seeded this.token from the (stale) SS value.
      assert.strictEqual(mgr.token, 'stale');
      var ok = await mgr.initialize();
      assert.strictEqual(ok, true);
      // Stash now holds the fresh URL token (overwrote stale).
      assert.strictEqual(ssMap.getItem('cc-web-token'), 'fresh');
      // verify-token was called with the fresh token first; never had to
      // try the stale one because the fresh one validated.
      var verifyCalls = fetchCalls.filter(function (c) { return c.url === '/auth-verify'; });
      assert.strictEqual(verifyCalls.length, 1, 'should verify URL token only');
      assert.strictEqual(JSON.parse(verifyCalls[0].init.body).token, 'fresh');
    });

    it('falls through to SS token when URL token is invalid', async function () {
      installBrowserStubs({
        search: '?token=bogus',
        fetchHandler: function (url, init) {
          if (url.indexOf('/auth-status') !== -1) return jsonResponse({ authRequired: true });
          if (url.indexOf('/auth-verify') !== -1) {
            var body = JSON.parse(init.body);
            // Bogus URL token rejected, valid SS token accepted.
            return jsonResponse({ valid: body.token === 'goodSS' });
          }
          return jsonResponse({});
        },
      });
      ssMap.setItem('cc-web-token', 'goodSS');
      var auth = loadAuth();
      var mgr = new auth.AuthManager();
      var ok = await mgr.initialize();
      assert.strictEqual(ok, true);
      var verifyCalls = fetchCalls.filter(function (c) { return c.url === '/auth-verify'; });
      // Both tokens were tried — URL first (rejected), SS second (accepted).
      assert.strictEqual(verifyCalls.length, 2, 'should try URL then SS');
      assert.strictEqual(JSON.parse(verifyCalls[0].init.body).token, 'bogus');
      assert.strictEqual(JSON.parse(verifyCalls[1].init.body).token, 'goodSS');
    });

    it('strips URL even when auth is not required', async function () {
      installBrowserStubs({
        search: '?token=harmless',
        fetchHandler: function (url) {
          if (url.indexOf('/auth-status') !== -1) return jsonResponse({ authRequired: false });
          return jsonResponse({});
        },
      });
      var auth = loadAuth();
      var mgr = new auth.AuthManager();
      var ok = await mgr.initialize();
      assert.strictEqual(ok, true);
      // URL was stripped on the way in (extractAndStripUrlToken always
      // strips when a token is present, before checkAuthStatus runs).
      assert.strictEqual(history.calls.length, 1, 'URL strip is unconditional');
      assert.strictEqual(window.location.search, '');
    });

    it('shows login prompt when both URL token and SS token are invalid', async function () {
      installBrowserStubs({
        search: '?token=nope',
        fetchHandler: function (url) {
          if (url.indexOf('/auth-status') !== -1) return jsonResponse({ authRequired: true });
          if (url.indexOf('/auth-verify') !== -1) return jsonResponse({ valid: false });
          return jsonResponse({});
        },
      });
      ssMap.setItem('cc-web-token', 'alsoBad');
      var auth = loadAuth();
      var mgr = new auth.AuthManager();
      // Stub showLoginPrompt so we don't have to drive the DOM.
      var promptShown = 0;
      mgr.showLoginPrompt = function () { promptShown++; };
      var ok = await mgr.initialize();
      assert.strictEqual(ok, false);
      assert.strictEqual(promptShown, 1, 'login prompt must fire');
      // Stale SS token cleared.
      assert.strictEqual(ssMap.getItem('cc-web-token'), null);
    });
  });

  describe('AuthManager class statics', function () {
    before(function () { installBrowserStubs(); });
    after(restoreBrowserStubs);

    it('exposes sanitizeForLog and extractAndStripUrlToken statically', function () {
      var auth = loadAuth();
      assert.strictEqual(typeof auth.AuthManager.sanitizeForLog, 'function');
      assert.strictEqual(typeof auth.AuthManager.extractAndStripUrlToken, 'function');
    });
  });
});
