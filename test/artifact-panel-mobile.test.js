'use strict';

// jsdom regression coverage for the artifact panel's phone layout behavior:
// persisted desktop geometry must not be applied or overwritten while the panel
// is docked as a mobile bottom sheet, and the dismissed-panel affordance remains
// touchable.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (_) { /* will skip below */ }

const PANEL_SRC = path.join(__dirname, '..', 'src', 'public', 'artifact-panel.js');
const PANEL_CSS = path.join(__dirname, '..', 'src', 'public', 'components', 'artifact-panel.css');
const STORE_KEY = 'ai-or-die:artifact-panel:layout';

(JSDOM ? describe : describe.skip)('artifact-panel.js phone bottom sheet (JSDOM)', function () {
  this.timeout(15000);

  let window, document, ArtifactPanel;

  beforeEach(function () {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div class="terminal-wrapper"></div></body></html>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    window = dom.window;
    document = window.document;
    window.innerWidth = 390;
    window.matchMedia = (query) => ({
      media: query,
      matches: query === '(max-width:640px)',
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });

    global.window = window;
    global.document = document;

    const style = document.createElement('style');
    style.textContent = fs.readFileSync(PANEL_CSS, 'utf8');
    document.head.appendChild(style);

    window.eval(fs.readFileSync(PANEL_SRC, 'utf8'));
    ArtifactPanel = window.ArtifactPanel;
  });

  afterEach(function () {
    delete global.window;
    delete global.document;
  });

  it('detects phone mode without applying or writing shared desktop geometry', function () {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({
      left: 80,
      top: 48,
      width: 520,
      height: 360,
      minimized: false,
    }));

    const panel = new ArtifactPanel({});
    assert.strictEqual(panel._isPhone(), true, '_isPhone() should reflect the phone media query');
    assert.strictEqual(panel.el.style.left, '', 'phone mode should not apply persisted left');
    assert.strictEqual(panel.el.style.top, '', 'phone mode should not apply persisted top');
    assert.strictEqual(panel.el.style.width, '', 'phone mode should not apply persisted width');
    assert.strictEqual(panel.el.style.height, '', 'phone mode should not apply persisted height');

    panel._layout.left = 5;
    panel._layout.top = 6;
    panel._layout.width = 300;
    panel._layout.height = 260;
    panel._saveLayout();

    const stored = JSON.parse(window.localStorage.getItem(STORE_KEY));
    assert.deepStrictEqual(stored, {
      left: 80,
      top: 48,
      width: 520,
      height: 360,
      minimized: false,
    }, 'phone geometry should not overwrite the shared layout store');
  });

  it('renders a touch-sized reopen affordance', function () {
    const panel = new ArtifactPanel({});
    const reopen = document.querySelector('.artifact-panel__reopen');
    assert.ok(reopen, 'reopen affordance should exist');
    assert.strictEqual(reopen, panel._reopenBadge);

    const style = window.getComputedStyle(reopen);
    const minWidth = parseFloat(style.minWidth);
    const minHeight = parseFloat(style.minHeight);
    if (Number.isFinite(minWidth) && Number.isFinite(minHeight)) {
      assert.ok(minWidth >= 44, 'reopen min-width should be at least 44px');
      assert.ok(minHeight >= 44, 'reopen min-height should be at least 44px');
    } else {
      const css = fs.readFileSync(PANEL_CSS, 'utf8');
      assert.ok(/\.artifact-panel__reopen\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/s.test(css),
        'reopen CSS should configure at least a 44px touch target');
    }
  });
});
