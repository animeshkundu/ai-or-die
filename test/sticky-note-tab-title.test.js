'use strict';

const assert = require('assert');
const path = require('path');

let JSDOM = null;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (_) {
  /* skip below */
}

const SM_SRC = path.join(__dirname, '..', 'src', 'public', 'session-manager.js');

describe('auto tab title (applyAutoTitle)', function () {
  if (!JSDOM) {
    it('skipped — jsdom not installed', function () {
      this.skip();
    });
    return;
  }

  let SessionTabManager;
  let mgr;
  let sent;

  function addFakeTab(id, name) {
    const tab = document.createElement('div');
    tab.className = 'session-tab';
    const span = document.createElement('span');
    span.className = 'tab-name';
    span.textContent = name;
    tab.appendChild(span);
    document.body.appendChild(tab);
    mgr.tabs.set(id, tab);
    mgr.activeSessions.set(id, { id, name, nameIsUserSet: false, stickyNote: null, autoTitle: null });
    return tab;
  }

  beforeEach(function () {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://localhost' });
    global.window = dom.window;
    global.document = dom.window.document;
    delete require.cache[require.resolve(SM_SRC)];
    const mod = require(SM_SRC);
    SessionTabManager = mod.SessionTabManager;
    sent = [];
    mgr = new SessionTabManager({ getAlias: (k) => k, send: (m) => sent.push(m) });
  });

  afterEach(function () {
    delete global.window;
    delete global.document;
  });

  it('applies a model title to the tab label and stored name', function () {
    const tab = addFakeTab('s1', 'Session 1');
    mgr.applyAutoTitle('s1', 'Fix auth redirect');
    assert.strictEqual(tab.querySelector('.tab-name').textContent, 'Fix auth redirect');
    assert.strictEqual(mgr.activeSessions.get('s1').name, 'Fix auth redirect');
    assert.strictEqual(mgr.activeSessions.get('s1').autoTitle, 'Fix auth redirect');
  });

  it('does NOT override a tab the user manually renamed', function () {
    const tab = addFakeTab('s1', 'My Tab');
    mgr.activeSessions.get('s1').nameIsUserSet = true;
    mgr.applyAutoTitle('s1', 'Auto Title');
    assert.strictEqual(tab.querySelector('.tab-name').textContent, 'My Tab', 'manual name preserved');
    assert.strictEqual(mgr.activeSessions.get('s1').name, 'My Tab');
  });

  it('a manual rename pins the name and notifies the server', function () {
    addFakeTab('s1', 'Old');
    mgr.renameTab('s1');
    const input = mgr.tabs.get('s1').querySelector('input.tab-name-input');
    assert.ok(input, 'rename input rendered');
    input.value = 'Renamed By User';
    input.dispatchEvent(new window.Event('keydown')); // no-op; trigger save via blur
    input.dispatchEvent(new window.Event('blur'));
    assert.strictEqual(mgr.activeSessions.get('s1').nameIsUserSet, true);
    assert.strictEqual(mgr.activeSessions.get('s1').name, 'Renamed By User');
    const msg = sent.find((m) => m.type === 'set_tab_name');
    assert.ok(msg && msg.name === 'Renamed By User', 'server told of the manual rename');

    // Subsequent auto-titles are now ignored.
    mgr.applyAutoTitle('s1', 'Auto Title');
    assert.strictEqual(mgr.activeSessions.get('s1').name, 'Renamed By User');
  });

  it('ignores empty / whitespace titles', function () {
    const tab = addFakeTab('s1', 'Keep');
    mgr.applyAutoTitle('s1', '   ');
    assert.strictEqual(tab.querySelector('.tab-name').textContent, 'Keep');
  });
});
