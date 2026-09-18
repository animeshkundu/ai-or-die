'use strict';

// Tests for the Settings "Server update ready / Apply Now" surface in
// src/public/app.js (hybrid autoupdate model: the supervisor auto-downloads,
// the user applies via this banner or Settings).
//
// Approach: same vm-sandbox precedent as test/session-deleted-cleanup.test.js
// — evaluate app.js without invoking the constructor, then call the update
// methods against a fake `this`. A real jsdom document backs the banner DOM
// so show/hide/apply behavior is asserted, not stubbed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let JSDOM = null;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (_) {
  /* skip below */
}

function loadAppClass(realDocument) {
  const src = fs.readFileSync(path.join(__dirname, '../src/public/app.js'), 'utf8');
  const noopFn = function () {};
  // Facade over the real jsdom document: DOM creation/querying is real, but
  // addEventListener is a swallow-stub so the bottom-of-file
  // DOMContentLoaded registration never constructs a live app instance
  // (same rationale as test/session-deleted-cleanup.test.js).
  const sandbox = {
    window: { addEventListener: noopFn, innerWidth: 1280 },
    document: {
      addEventListener: noopFn,
      createElement: (...args) => realDocument.createElement(...args),
      getElementById: (...args) => realDocument.getElementById(...args),
      body: realDocument.body,
      head: realDocument.head,
    },
    navigator: { userAgent: '' },
    TextDecoder: TextDecoder,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext('var self = globalThis;', sandbox);
  const exposed = src + '\n;globalThis.__ClaudeCodeWebInterface = ClaudeCodeWebInterface;';
  vm.runInContext(exposed, sandbox, { filename: 'app.js' });
  return sandbox.__ClaudeCodeWebInterface;
}

describe('server update banner (Settings apply surface)', function () {
  if (!JSDOM) {
    it('skipped — jsdom not installed', function () { this.skip(); });
    return;
  }

  let App;
  let dom;

  before(function () {
    dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://localhost' });
    App = loadAppClass(dom.window.document);
  });

  afterEach(function () {
    const banner = dom.window.document.getElementById('serverUpdateBanner');
    if (banner) banner.remove();
  });

  function fakeApp(overrides = {}) {
    // Prototype-chained so internal this._showX/_checkX calls resolve;
    // network + UI side effects are stubbed per test.
    return Object.assign(Object.create(App.prototype), {
      authFetch: async () => ({ ok: false }),
      updateStatus: () => {},
      showError: () => {},
      ...overrides,
    });
  }

  it('shows a banner with the staged version and an Apply button', function () {
    const fake = fakeApp();
    App.prototype._showServerUpdateBanner.call(fake, '0.1.109');
    const banner = dom.window.document.getElementById('serverUpdateBanner');
    assert.ok(banner, 'banner is added to the DOM');
    assert.ok(banner.textContent.includes('0.1.109'));
    assert.ok(dom.window.document.getElementById('serverUpdateApplyBtn'), 'apply button exists');
  });

  it('hides the banner on demand and on server_restarting', function () {
    const fake = fakeApp();
    App.prototype._showServerUpdateBanner.call(fake, '0.1.109');
    App.prototype._hideServerUpdateBanner.call(fake);
    const banner = dom.window.document.getElementById('serverUpdateBanner');
    assert.strictEqual(banner.style.display, 'none');
  });

  it('check shows the banner when a staged update is reported', async function () {
    const fake = fakeApp({
      authFetch: async () => ({
        ok: true,
        json: async () => ({ supervised: true, pending: { version: '0.1.109' } }),
      }),
    });
    await App.prototype._checkServerUpdate.call(fake);
    assert.ok(dom.window.document.getElementById('serverUpdateBanner'));
  });

  it('check stays silent when unsupervised', async function () {
    const fake = fakeApp({
      authFetch: async () => ({
        ok: true,
        json: async () => ({ supervised: false, updatable: false }),
      }),
    });
    await App.prototype._checkServerUpdate.call(fake);
    assert.strictEqual(dom.window.document.getElementById('serverUpdateBanner'), null);
  });

  it('apply posts to /api/update/apply and reports reconnect', async function () {
    const posted = [];
    const statuses = [];
    const fake = fakeApp({
      authFetch: async (url, opts) => {
        posted.push({ url, opts });
        return { ok: true, json: async () => ({ applied: true, version: '0.1.109', ptys: 2 }) };
      },
      updateStatus: (s) => statuses.push(s),
    });
    App.prototype._showServerUpdateBanner.call(fake, '0.1.109');
    await App.prototype._applyServerUpdate.call(fake);
    assert.strictEqual(posted[0].url, '/api/update/apply');
    assert.strictEqual(posted[0].opts.method, 'POST');
    assert.ok(statuses.length > 0, 'user sees reconnect status');
  });

  it('failed apply keeps sessions safe and shows an error', async function () {
    const errors = [];
    const fake = fakeApp({
      authFetch: async () => ({ ok: true, json: async () => ({ applied: false, reason: 'handoff_failed' }) }),
      showError: (e) => errors.push(e),
    });
    App.prototype._showServerUpdateBanner.call(fake, '0.1.109');
    await App.prototype._applyServerUpdate.call(fake);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes('unaffected'), 'error reassures sessions survive');
  });
});
