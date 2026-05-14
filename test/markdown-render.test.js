// test/markdown-render.test.js — pure-JS helpers exposed by markdown-render.js
//
// DOM/browser paths (renderInto, lazy script loading, DOMPurify hook,
// Mermaid + KaTeX integration, internal-link click delegation) are
// exercised by the Playwright e2e suite (task #11). This file covers the
// portable seam: the URL-classification and path-resolution helpers that
// determine whether a markdown link gets rewritten and how.

'use strict';

const path = require('path');
const assert = require('assert');

const modulePath = path.join(__dirname, '..', 'src', 'public', 'markdown-render.js');
delete require.cache[require.resolve(modulePath)];

const md = require(modulePath);

describe('markdown-render.js (pure helpers)', function () {
  describe('exports under Node', function () {
    it('exposes isInternalRelative and resolveRelative', function () {
      assert.strictEqual(typeof md.isInternalRelative, 'function');
      assert.strictEqual(typeof md.resolveRelative, 'function');
    });

    // The full module surface (including DOM-bound `renderInto`) is exposed
    // under Node by design — the dual-export pattern matches what
    // file-browser.js already does so all the IIFE's surface is testable.
    // We don't call DOM-bound methods from these unit tests; that's e2e's
    // job (Playwright + JSDOM-integration spec). See lead's CI guidance:
    // the early-return Node guard inside the IIFE was over-engineered and
    // gets bypassed by any other test that pre-populates global.window
    // (session-tab-activity does this at module-eval time).
  });

  describe('isInternalRelative', function () {
    it('classifies plain relative paths as internal', function () {
      assert.strictEqual(md.isInternalRelative('foo.md'), true);
      assert.strictEqual(md.isInternalRelative('./foo.md'), true);
      assert.strictEqual(md.isInternalRelative('../foo.md'), true);
      assert.strictEqual(md.isInternalRelative('subdir/foo.png'), true);
      assert.strictEqual(md.isInternalRelative('/absolute/path.txt'), true);
    });

    it('rejects absolute http(s) URLs', function () {
      assert.strictEqual(md.isInternalRelative('https://example.com/x'), false);
      assert.strictEqual(md.isInternalRelative('http://example.com/x'), false);
      assert.strictEqual(md.isInternalRelative('HTTPS://example.com/x'), false);
    });

    it('rejects protocol-relative URLs', function () {
      assert.strictEqual(md.isInternalRelative('//example.com/x'), false);
    });

    it('rejects pseudo-scheme URIs (XSS surface)', function () {
      // These are the dangerous ones that DOMPurify would already strip from
      // <a href>, but isInternalRelative must NOT classify them as paths.
      assert.strictEqual(md.isInternalRelative('javascript:alert(1)'), false);
      assert.strictEqual(md.isInternalRelative('data:text/html,foo'), false);
      assert.strictEqual(md.isInternalRelative('mailto:foo@example.com'), false);
      assert.strictEqual(md.isInternalRelative('tel:+1234'), false);
      assert.strictEqual(md.isInternalRelative('vbscript:msgbox(1)'), false);
      assert.strictEqual(md.isInternalRelative('JaVaScRiPt:alert(1)'), false);
    });

    it('rejects fragment-only URLs', function () {
      assert.strictEqual(md.isInternalRelative('#anchor'), false);
      assert.strictEqual(md.isInternalRelative('#'), false);
    });

    it('rejects empty / whitespace input', function () {
      assert.strictEqual(md.isInternalRelative(''), false);
      assert.strictEqual(md.isInternalRelative('   '), false);
      assert.strictEqual(md.isInternalRelative(null), false);
      assert.strictEqual(md.isInternalRelative(undefined), false);
      assert.strictEqual(md.isInternalRelative(42), false);
    });
  });

  describe('resolveRelative', function () {
    it('joins simple relative path against base directory', function () {
      assert.strictEqual(md.resolveRelative('foo.png', '/home/user/docs'), '/home/user/docs/foo.png');
    });

    it('strips a leading ./ before joining', function () {
      assert.strictEqual(md.resolveRelative('./foo.png', '/home/user/docs'), '/home/user/docs/foo.png');
    });

    it('walks .. segments correctly', function () {
      assert.strictEqual(md.resolveRelative('../shared/x.md', '/home/user/docs'), '/home/user/shared/x.md');
      assert.strictEqual(md.resolveRelative('../../assets/y.png', '/a/b/c/d'), '/a/b/assets/y.png');
    });

    it('does not climb above the filesystem root', function () {
      assert.strictEqual(md.resolveRelative('../../../etc/passwd', '/'), '/etc/passwd');
      assert.strictEqual(md.resolveRelative('../../../etc/passwd', ''), '../../../etc/passwd');
    });

    it('preserves an already-absolute path verbatim', function () {
      assert.strictEqual(md.resolveRelative('/absolute/path.txt', '/home/user/docs'), '/absolute/path.txt');
    });

    it('normalises Windows-style backslashes to forward slashes', function () {
      assert.strictEqual(
        md.resolveRelative('subdir\\nested\\img.png', 'C:/projects/app'),
        'C:/projects/app/subdir/nested/img.png'
      );
    });

    it('drops trailing slashes from the base path', function () {
      assert.strictEqual(md.resolveRelative('foo.txt', '/home/user/docs/'), '/home/user/docs/foo.txt');
      assert.strictEqual(md.resolveRelative('foo.txt', '/home/user/docs///'), '/home/user/docs/foo.txt');
    });

    it('returns url verbatim if base is empty/null', function () {
      assert.strictEqual(md.resolveRelative('foo.txt', null), 'foo.txt');
      assert.strictEqual(md.resolveRelative('foo.txt', ''), 'foo.txt');
    });

    it('returns empty string for empty input', function () {
      assert.strictEqual(md.resolveRelative('', '/home/user'), '');
      assert.strictEqual(md.resolveRelative(null, '/home/user'), '');
    });

    it('handles no-op . segments', function () {
      assert.strictEqual(md.resolveRelative('././/foo.txt', '/home'), '/home/foo.txt');
    });
  });
});
