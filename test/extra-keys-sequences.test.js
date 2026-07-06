'use strict';

// test/extra-keys-sequences.test.js — verifies the on-screen extra-keys bar
// emits the correct, MODE-AWARE byte sequences through KeyEncoder. This is the
// integration counterpart to test/key-encoder.test.js (which unit-tests the
// encoder in isolation): it drives real button clicks in jsdom and asserts the
// `input` frame handed to app.send().
//
// Skips automatically when jsdom isn't installed.

const path = require('path');
const fs = require('fs');
const assert = require('assert');

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (_) { /* skip below */ }

const KeyEncoder = require('../src/public/key-encoder');
const EXTRA_KEYS_SRC = path.join(__dirname, '..', 'src', 'public', 'extra-keys.js');

(JSDOM ? describe : describe.skip)('extra-keys.js byte sequences (JSDOM)', function () {
  this.timeout(15000);

  let window, document, ExtraKeys, sent, app;

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
    // Inject the (pure) encoder onto the jsdom window so extra-keys can find it
    // regardless of how globalThis resolves inside window.eval.
    window.KeyEncoder = KeyEncoder;
    window.eval(fs.readFileSync(EXTRA_KEYS_SRC, 'utf8'));
    ExtraKeys = window.ExtraKeys;

    sent = [];
    app = {
      _ctrlModifierPending: false,
      send: (msg) => sent.push(msg),
      terminal: {
        focus() {},
        modes: { applicationCursorKeysMode: false, bracketedPasteMode: false },
      },
    };
  });

  afterEach(function () {
    delete global.window;
    delete global.document;
  });

  function makeBar() {
    return new ExtraKeys({ app });
  }
  function btn(ek, label) {
    return Array.from(ek.container.querySelectorAll('button.extra-key'))
      .find((b) => b.textContent === label);
  }
  function click(el) {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  function lastData() {
    assert.ok(sent.length > 0, 'expected an input frame to have been sent');
    const msg = sent[sent.length - 1];
    assert.strictEqual(msg.type, 'input');
    return msg.data;
  }

  it('arrows emit CSI form in normal mode', function () {
    const ek = makeBar();
    click(btn(ek, '←'));
    assert.strictEqual(lastData(), '\x1b[D');
    click(btn(ek, '↑'));
    assert.strictEqual(lastData(), '\x1b[A');
  });

  it('arrows emit SS3 form in application-cursor mode', function () {
    const ek = makeBar();
    app.terminal.modes.applicationCursorKeysMode = true;
    click(btn(ek, '↑'));
    assert.strictEqual(lastData(), '\x1bOA');
    click(btn(ek, '→'));
    assert.strictEqual(lastData(), '\x1bOC');
  });

  it('Shift+Tab emits CBT regardless of mode', function () {
    const ek = makeBar();
    click(btn(ek, '⇤Tab'));
    assert.strictEqual(lastData(), '\x1b[Z');
  });

  it('one-tap Ctrl+C emits ETX', function () {
    const ek = makeBar();
    click(btn(ek, '^C'));
    assert.strictEqual(lastData(), '\x03');
  });

  it('Esc and Tab', function () {
    const ek = makeBar();
    click(btn(ek, 'Esc'));
    assert.strictEqual(lastData(), '\x1b');
    click(btn(ek, 'Tab'));
    assert.strictEqual(lastData(), '\t');
  });

  it('sticky Ctrl modifies the next arrow to a CSI modifier sequence', function () {
    const ek = makeBar();
    click(btn(ek, 'Ctrl'));
    assert.strictEqual(ek.ctrlActive, true);
    click(btn(ek, '←'));
    assert.strictEqual(lastData(), '\x1b[1;5D');
    assert.strictEqual(ek.ctrlActive, false, 'sticky Ctrl clears after use');
  });

  it('sticky Shift modifies the next arrow (Shift+Up)', function () {
    const ek = makeBar();
    click(btn(ek, 'Shift'));
    assert.strictEqual(ek.shiftActive, true);
    click(btn(ek, '↑'));
    assert.strictEqual(lastData(), '\x1b[1;2A');
    assert.strictEqual(ek.shiftActive, false);
  });

  it('sticky Ctrl + a symbol from row2 yields its control code (Ctrl+[ = ESC)', function () {
    const ek = makeBar();
    click(btn(ek, 'Ctrl'));
    click(btn(ek, '['));
    assert.strictEqual(lastData(), '\x1b');
  });

  it('symbol keys pass through', function () {
    const ek = makeBar();
    click(btn(ek, '/'));
    assert.strictEqual(lastData(), '/');
    click(btn(ek, '#'));
    assert.strictEqual(lastData(), '#');
    click(btn(ek, '!'));
    assert.strictEqual(lastData(), '!');
  });

  it('destroy() removes the bar and can be called twice safely', function () {
    const ek = makeBar();
    assert.ok(document.body.contains(ek.container));
    ek.destroy();
    assert.ok(!document.body.contains(ek.container));
    assert.doesNotThrow(() => ek.destroy());
  });

  // Regression for the iOS WebKit bug where touchstart.preventDefault suppresses
  // the emulated click: the action must fire on touchend, and a following click
  // must NOT double-fire.
  function touch(el, type) {
    el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  }
  it('fires the key on touchend (touch devices) — not only click', function () {
    const ek = makeBar();
    const before = sent.length;
    touch(btn(ek, 'Esc'), 'touchend');
    assert.strictEqual(sent.length, before + 1, 'touchend must send the key');
    assert.strictEqual(lastData(), '\x1b');
  });
  it('does not double-fire when a click follows the touchend', function () {
    const ek = makeBar();
    const b = btn(ek, '^C');
    touch(b, 'touchend');
    const after = sent.length;
    click(b); // emulated click after a real touch — must be swallowed
    assert.strictEqual(sent.length, after, 'click after touchend must not re-send');
  });
  it('a genuine later click (well after the touch) still fires', function () {
    const ek = makeBar();
    const b = btn(ek, 'Esc');
    touch(b, 'touchend');
    const after = sent.length;
    const realNow = window.Date.now;
    window.Date.now = () => realNow() + 1000; // past the 700ms dedup window
    try { click(b); } finally { window.Date.now = realNow; }
    assert.strictEqual(sent.length, after + 1, 'a real later click must fire the action');
  });
});
