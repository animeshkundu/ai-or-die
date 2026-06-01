// test/extra-keys-tooltips.test.js — verifies the mobile extra-keys bar renders
// `title` tooltip attributes on every key that declares one (arrow keys, the
// dismiss key, and the clipboard keys), not just the clipboard keys.
//
// Regression guard for the iOS PWA polish: arrow buttons (←↑↓→) previously
// carried `aria-label` only, so iPad trackpad / external-keyboard users got no
// hover tooltip. The fix hoists the `title` application in `_buildRow` so it
// applies to all key types.
//
// Skips automatically when jsdom isn't installed so the unit suite still runs
// where the dev dependency wasn't fetched.

'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (_) { /* will skip below */ }

const EXTRA_KEYS_SRC = path.join(__dirname, '..', 'src', 'public', 'extra-keys.js');

(JSDOM ? describe : describe.skip)('extra-keys.js tooltips (JSDOM)', function () {
  this.timeout(15000);

  let window, document, ExtraKeys;

  beforeEach(function () {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    window = dom.window;
    document = window.document;
    // The class registers itself on `window` and uses the global `document`
    // for element creation; expose both so the IIFE-style module loads cleanly.
    global.window = window;
    global.document = document;
    window.eval(fs.readFileSync(EXTRA_KEYS_SRC, 'utf8'));
    ExtraKeys = window.ExtraKeys;
  });

  afterEach(function () {
    delete global.window;
    delete global.document;
  });

  function buildBar() {
    const ek = new ExtraKeys({ app: { sendInput() {} } });
    return ek.container;
  }

  function buttonByLabel(container, label) {
    return Array.from(container.querySelectorAll('button.extra-key'))
      .find((b) => b.textContent === label);
  }

  it('renders title tooltips on every arrow key', function () {
    const container = buildBar();
    const expected = {
      '←': 'Left arrow',
      '→': 'Right arrow',
      '↑': 'Up arrow',
      '↓': 'Down arrow',
    };
    for (const [label, title] of Object.entries(expected)) {
      const btn = buttonByLabel(container, label);
      assert.ok(btn, `arrow button "${label}" should exist`);
      assert.strictEqual(btn.getAttribute('title'), title,
        `arrow button "${label}" should have title="${title}"`);
    }
  });

  it('renders a title tooltip on the dismiss key', function () {
    const container = buildBar();
    const btn = buttonByLabel(container, '⇩');
    assert.ok(btn, 'dismiss button should exist');
    assert.strictEqual(btn.getAttribute('title'), 'Dismiss keyboard');
  });

  it('keeps aria-label alongside title (accessibility not regressed)', function () {
    const container = buildBar();
    const btn = buttonByLabel(container, '←');
    assert.strictEqual(btn.getAttribute('aria-label'), 'Left arrow');
    assert.strictEqual(btn.getAttribute('title'), 'Left arrow');
  });
});
