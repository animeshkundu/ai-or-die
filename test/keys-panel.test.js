'use strict';

// test/keys-panel.test.js — the Control-mode "all keys" panel (keyboard-down).
// Verifies it emits correct mode-aware bytes, opens/closes, and — critically —
// never takes terminal focus (which on iOS would pop the soft keyboard and
// defeat the two-mode model). Skips when jsdom is unavailable.

const path = require('path');
const fs = require('fs');
const assert = require('assert');

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (_) { /* skip below */ }

const KeyEncoder = require('../src/public/key-encoder');
const KEYS_PANEL_SRC = path.join(__dirname, '..', 'src', 'public', 'keys-panel.js');

(JSDOM ? describe : describe.skip)('keys-panel.js (JSDOM)', function () {
  this.timeout(15000);

  let window, document, KeysPanel, sent, focusCalls, app;

  beforeEach(function () {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    window = dom.window;
    document = window.document;
    global.window = window;
    global.document = document;
    window.KeyEncoder = KeyEncoder;
    window.eval(fs.readFileSync(KEYS_PANEL_SRC, 'utf8'));
    KeysPanel = window.KeysPanel;

    sent = [];
    focusCalls = 0;
    app = {
      send: (msg) => sent.push(msg),
      terminal: {
        focus() { focusCalls += 1; },
        modes: { applicationCursorKeysMode: false, bracketedPasteMode: false },
      },
    };
  });

  afterEach(function () {
    delete global.window;
    delete global.document;
  });

  function make() { return new KeysPanel({ app }); }
  function keyByLabel(kp, label) {
    return Array.from(kp.panel.querySelectorAll('button.keys-panel__key'))
      .find((b) => b.textContent === label);
  }
  function click(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
  function lastData() {
    assert.ok(sent.length > 0, 'expected an input frame');
    return sent[sent.length - 1].data;
  }

  it('creates a launcher FAB, backdrop, and panel', function () {
    make();
    assert.ok(document.getElementById('keysPanelBtn'), 'FAB exists');
    assert.ok(document.getElementById('keysPanel'), 'panel exists');
    assert.ok(document.querySelector('.keys-panel__backdrop'), 'backdrop exists');
  });

  it('toggles open/closed via the FAB', function () {
    const kp = make();
    assert.strictEqual(kp.open, false);
    click(document.getElementById('keysPanelBtn'));
    assert.strictEqual(kp.open, true);
    assert.ok(kp.panel.classList.contains('keys-panel--open'));
    click(document.getElementById('keysPanelBtn'));
    assert.strictEqual(kp.open, false);
  });

  it('emits correct bytes and NEVER takes terminal focus (keyboard-down)', function () {
    const kp = make();
    kp.show();
    click(keyByLabel(kp, '^C'));
    assert.strictEqual(lastData(), '\x03');
    click(keyByLabel(kp, 'F5'));
    assert.strictEqual(lastData(), '\x1b[15~');
    click(keyByLabel(kp, 'Del'));
    assert.strictEqual(lastData(), '\x1b[3~');
    click(keyByLabel(kp, '⇤ Tab'));
    assert.strictEqual(lastData(), '\x1b[Z');
    assert.strictEqual(focusCalls, 0, 'panel must not call terminal.focus()');
  });

  it('respects application-cursor mode for arrows', function () {
    const kp = make();
    app.terminal.modes.applicationCursorKeysMode = true;
    click(keyByLabel(kp, '↑'));
    assert.strictEqual(lastData(), '\x1bOA');
  });

  it('emits Alt word-ops (Alt+Backspace = ESC DEL)', function () {
    const kp = make();
    click(keyByLabel(kp, '⌥⌫'));
    assert.strictEqual(lastData(), '\x1b\x7f');
    click(keyByLabel(kp, '⌥B'));
    assert.strictEqual(lastData(), '\x1bb');
  });

  it('does not rely on window.focusTrap', function () {
    // The panel must not register itself with the global focus trap; assert the
    // source contains no focusTrap reference.
    const src = fs.readFileSync(KEYS_PANEL_SRC, 'utf8');
    assert.ok(!/focusTrap/.test(src), 'keys-panel.js must not use window.focusTrap');
  });

  it('destroy() removes all elements', function () {
    const kp = make();
    kp.destroy();
    assert.ok(!document.getElementById('keysPanelBtn'));
    assert.ok(!document.getElementById('keysPanel'));
    assert.ok(!document.querySelector('.keys-panel__backdrop'));
  });
});
