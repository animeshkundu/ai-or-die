const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('window-controls-overlay CSS polish', function () {
  const baseCssPath = path.join(__dirname, '..', 'src', 'public', 'base.css');
  let css;

  before(function () {
    css = fs.readFileSync(baseCssPath, 'utf8');
  });

  it('keeps WCO drag region scoped to window-controls-overlay mode', function () {
    assert.ok(
      css.includes('@media (display-mode: window-controls-overlay)'),
      'expected a window-controls-overlay media query'
    );
    assert.ok(css.includes('-webkit-app-region: drag;'), 'expected a drag region in WCO mode');
    assert.strictEqual((css.match(/-webkit-app-region:/g) || []).length, 2, 'app-region styles should stay minimal');
  });

  it('marks overflow tab menu and actions as no-drag for usability', function () {
    assert.ok(css.includes('.session-tabs-bar button,'), 'expected button no-drag rule');
    assert.ok(css.includes('.session-tabs-bar .session-tab,'), 'expected tab no-drag rule');
    assert.ok(css.includes('.session-tabs-bar .tab-overflow-menu,'), 'expected overflow menu no-drag rule');
    assert.ok(css.includes('.session-tabs-bar .tab-overflow-menu *'), 'expected overflow descendants no-drag rule');
  });

  it('preserves standalone fallback handling', function () {
    assert.ok(
      css.includes('@media (display-mode: standalone), (display-mode: window-controls-overlay)'),
      'expected standalone/window-controls-overlay fallback media query'
    );
    assert.ok(css.includes('overscroll-behavior: none;'), 'expected standalone fallback behavior to remain');
  });
});
