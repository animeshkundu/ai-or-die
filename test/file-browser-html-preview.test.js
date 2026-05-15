// test/file-browser-html-preview.test.js — pure-JS helpers for the HTML
// sandboxed-iframe preview (#18). DOM-bound paths (the toggle button,
// iframe attribute set, Monaco source view) are exercised by the
// Playwright e2e suite (task #11).

'use strict';

const path = require('path');
const assert = require('assert');

const fbPath = path.join(__dirname, '..', 'src', 'public', 'file-browser.js');
delete require.cache[require.resolve(fbPath)];

const fb = require(fbPath);

describe('file-browser HTML preview helpers (#18)', function () {
  describe('exports', function () {
    it('exposes isHtmlExtension', function () {
      assert.strictEqual(typeof fb.isHtmlExtension, 'function');
    });
    it('exposes buildSandboxedSrcdoc', function () {
      assert.strictEqual(typeof fb.buildSandboxedSrcdoc, 'function');
    });
    it('exposes HTML_PREVIEW_CSP and HTML_PREVIEW_SRCDOC_CAP_BYTES constants', function () {
      assert.strictEqual(typeof fb.HTML_PREVIEW_CSP, 'string');
      assert.ok(fb.HTML_PREVIEW_CSP.indexOf("default-src 'none'") !== -1);
      assert.strictEqual(typeof fb.HTML_PREVIEW_SRCDOC_CAP_BYTES, 'number');
      assert.ok(fb.HTML_PREVIEW_SRCDOC_CAP_BYTES > 0);
    });
  });

  describe('isHtmlExtension', function () {
    it('matches .html / .htm / .xhtml regardless of case', function () {
      assert.strictEqual(fb.isHtmlExtension('foo.html'), true);
      assert.strictEqual(fb.isHtmlExtension('FOO.HTML'), true);
      assert.strictEqual(fb.isHtmlExtension('Foo.HtM'), true);
      assert.strictEqual(fb.isHtmlExtension('page.xhtml'), true);
    });
    it('rejects non-HTML extensions', function () {
      assert.strictEqual(fb.isHtmlExtension('foo.js'), false);
      assert.strictEqual(fb.isHtmlExtension('foo.md'), false);
      assert.strictEqual(fb.isHtmlExtension('foo'), false);
      assert.strictEqual(fb.isHtmlExtension(''), false);
      assert.strictEqual(fb.isHtmlExtension(null), false);
      assert.strictEqual(fb.isHtmlExtension(undefined), false);
    });
    it('handles full Unix and Windows paths', function () {
      assert.strictEqual(fb.isHtmlExtension('/home/user/index.html'), true);
      assert.strictEqual(fb.isHtmlExtension('C:\\Users\\me\\page.htm'), true);
      assert.strictEqual(fb.isHtmlExtension('/home/user/script.js'), false);
    });
    it('does NOT match files whose name CONTAINS html but extension differs', function () {
      assert.strictEqual(fb.isHtmlExtension('htmltools.zip'), false);
      assert.strictEqual(fb.isHtmlExtension('html.txt'), false);
    });
  });

  describe('buildSandboxedSrcdoc', function () {
    it('injects the CSP meta tag at the top of an existing <head>', function () {
      var input = '<html><head><title>X</title></head><body>hi</body></html>';
      var out = fb.buildSandboxedSrcdoc(input);
      assert.ok(out.indexOf('Content-Security-Policy') !== -1, 'CSP meta should be present');
      // CSP comes BEFORE <title> (i.e. immediately after <head>).
      assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('<title>'),
        'CSP should be the first child of <head>');
    });

    it('creates a <head> when only <html> is present', function () {
      var input = '<html><body>hi</body></html>';
      var out = fb.buildSandboxedSrcdoc(input);
      assert.ok(/<head>.*Content-Security-Policy.*<\/head>/i.test(out));
    });

    it('prepends <head> when no <html> wrapper is present', function () {
      var input = '<p>hi</p>';
      var out = fb.buildSandboxedSrcdoc(input);
      assert.ok(out.indexOf('<head>') === 0);
      assert.ok(out.indexOf('Content-Security-Policy') !== -1);
      assert.ok(out.indexOf('<p>hi</p>') !== -1, 'original body content preserved');
    });

    it('strips every <base> tag, case-insensitive', function () {
      var input = '<html><head>' +
        '<base href="javascript:alert(1)">' +
        '<BASE TARGET="_top">' +
        '<base\n  href="http://attacker">' +
        '</head><body>x</body></html>';
      var out = fb.buildSandboxedSrcdoc(input);
      assert.ok(!/<base\b/i.test(out), 'no <base> tags should remain');
      assert.ok(out.indexOf('javascript:alert') === -1, 'javascript: payload gone');
      assert.ok(out.indexOf('attacker') === -1, 'external href gone');
    });

    it('strips <meta http-equiv="refresh"> case-insensitively', function () {
      var input = '<html><head>' +
        '<meta http-equiv="refresh" content="0;url=http://attacker">' +
        '<META HTTP-EQUIV=\'refresh\' content=\'0\'>' +
        '</head><body>x</body></html>';
      var out = fb.buildSandboxedSrcdoc(input);
      assert.ok(!/http-equiv\s*=\s*['"]?refresh/i.test(out),
        'no meta-refresh should remain');
      assert.ok(out.indexOf('attacker') === -1, 'redirect target removed');
    });

    it('does NOT strip benign <meta charset> or <meta name=...>', function () {
      var input = '<html><head>' +
        '<meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width">' +
        '</head><body>hi</body></html>';
      var out = fb.buildSandboxedSrcdoc(input);
      assert.ok(out.indexOf('charset="utf-8"') !== -1, 'charset preserved');
      assert.ok(out.indexOf('name="viewport"') !== -1, 'viewport preserved');
    });

    it('CSP body sets default-src none and locks network paths', function () {
      var input = '<html><head></head><body></body></html>';
      var out = fb.buildSandboxedSrcdoc(input);
      assert.ok(out.indexOf("default-src 'none'") !== -1);
      assert.ok(out.indexOf('img-src data: blob:') !== -1);
      assert.ok(out.indexOf("style-src 'unsafe-inline'") !== -1);
      assert.ok(out.indexOf('font-src data:') !== -1);
      // Crucially: no script-src grant, no connect-src grant.
      assert.ok(out.indexOf('script-src') === -1, 'scripts blocked entirely');
      assert.ok(out.indexOf('connect-src') === -1, 'fetch/XHR blocked entirely');
    });

    it('CSP includes form-action and base-uri (do NOT fall back to default-src)', function () {
      // Per CSP spec, form-action and base-uri do NOT inherit from
      // default-src. Without explicit directives they default to *. This
      // test guards against a future regression that drops them.
      var out = fb.buildSandboxedSrcdoc('<html></html>');
      assert.ok(out.indexOf("form-action 'none'") !== -1,
        'form-action must be present (sandbox already blocks form-submit; this is the second line of defense)');
      assert.ok(out.indexOf("base-uri 'none'") !== -1,
        'base-uri must be present (second line of defense behind <base> regex strip)');
      // frame-ancestors is intentionally OMITTED — meta-CSP-ignored per spec.
      assert.ok(out.indexOf('frame-ancestors') === -1,
        'frame-ancestors is meta-CSP-ignored; do not add it');
    });

    it('handles null / undefined / empty input safely', function () {
      assert.strictEqual(typeof fb.buildSandboxedSrcdoc(null), 'string');
      assert.strictEqual(typeof fb.buildSandboxedSrcdoc(undefined), 'string');
      assert.strictEqual(typeof fb.buildSandboxedSrcdoc(''), 'string');
      // Even with no input, the CSP meta is present (defence in depth for
      // any subsequent injection).
      assert.ok(fb.buildSandboxedSrcdoc('').indexOf('Content-Security-Policy') !== -1);
    });

    it('preserves arbitrary inline content verbatim outside the modifications', function () {
      var input = '<html><head></head><body>' +
        '<style>body{color:red;}</style>' +
        '<p>Hello &amp; goodbye</p>' +
        '<svg><circle cx="10" cy="10" r="5"/></svg>' +
        '</body></html>';
      var out = fb.buildSandboxedSrcdoc(input);
      assert.ok(out.indexOf('<style>body{color:red;}</style>') !== -1);
      assert.ok(out.indexOf('Hello &amp; goodbye') !== -1);
      assert.ok(out.indexOf('<circle cx="10" cy="10" r="5"/>') !== -1);
    });
  });
});
