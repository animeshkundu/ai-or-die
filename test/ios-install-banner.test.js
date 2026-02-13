const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('iOS install banner guidance', function () {
  const htmlPath = path.join(__dirname, '..', 'src', 'public', 'index.html');
  const cssPath = path.join(__dirname, '..', 'src', 'public', 'style.css');
  let html;
  let css;

  before(function () {
    html = fs.readFileSync(htmlPath, 'utf8');
    css = fs.readFileSync(cssPath, 'utf8');
  });

  it('shows only for iOS non-standalone sessions with 7-day dismissal memory', function () {
    assert.ok(html.includes("const IOS_INSTALL_DISMISS_KEY = 'ios-install-banner-dismissed-at';"));
    assert.ok(html.includes('const IOS_INSTALL_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;'));
    assert.ok(html.includes('if (!isIOSDevice() || isPWA()) {'));
  });

  it('includes Safari, Chrome, and Edge iOS install instruction variants', function () {
    assert.ok(html.includes('/EdgiOS/i.test(ua)'));
    assert.ok(html.includes('/CriOS/i.test(ua)'));
    assert.ok(html.includes("browser: 'Safari'"));
    assert.ok(html.includes('Add to Phone.'));
    assert.ok(html.includes('Add to Home Screen.'));
  });

  it('includes accessible banner semantics and keyboard support', function () {
    assert.ok(html.includes("sheet.setAttribute('role', 'dialog');"));
    assert.ok(html.includes("sheet.setAttribute('aria-labelledby', 'iosInstallTitle');"));
    assert.ok(html.includes("sheet.setAttribute('aria-describedby', 'iosInstallCopy iosInstallSteps');"));
    assert.ok(html.includes("sheet.setAttribute('aria-live', 'polite');"));
    assert.ok(html.includes("if (event.key === 'Escape') {"));
    assert.ok(css.includes('.ios-install-dismiss:focus-visible'));
  });

  it('includes animated share icon in the install card', function () {
    assert.ok(html.includes('ios-install-share-icon'));
    assert.ok(css.includes('.ios-install-share-icon'));
    assert.ok(css.includes('@keyframes ios-install-share-bounce'));
  });
});
