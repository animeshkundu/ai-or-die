// test/file-search.test.js — pure-JS helpers exposed by file-search.js.
//
// DOM/SSE paths (SearchPanel constructor, EventSource lifecycle, debounce
// timer, result-row rendering, abort-on-new-query, rate-limit error
// surfacing) are exercised by the Playwright e2e suite (task #11). This
// file covers the testable seam: URL construction + location formatting.

'use strict';

const path = require('path');
const assert = require('assert');

const modulePath = path.join(__dirname, '..', 'src', 'public', 'file-search.js');
delete require.cache[require.resolve(modulePath)];

const fs = require(modulePath);

describe('file-search.js (pure helpers)', function () {
  describe('exports under Node', function () {
    it('exposes buildSearchUrl, formatLocation, SEARCH_ENDPOINT', function () {
      assert.strictEqual(typeof fs.buildSearchUrl, 'function');
      assert.strictEqual(typeof fs.formatLocation, 'function');
      assert.strictEqual(typeof fs.SEARCH_ENDPOINT, 'string');
      assert.strictEqual(fs.SEARCH_ENDPOINT, '/api/search');
    });
    it('does NOT expose SearchPanel under Node (DOM-only)', function () {
      assert.strictEqual(typeof fs.SearchPanel, 'undefined');
    });
  });

  describe('buildSearchUrl', function () {
    it('builds a minimal URL with just the query', function () {
      assert.strictEqual(fs.buildSearchUrl('foo'), '/api/search?q=foo');
    });

    it('encodes the query for special chars', function () {
      assert.strictEqual(fs.buildSearchUrl('hello world&!'),
        '/api/search?q=hello%20world%26!');
    });

    it('omits regex/case/glob params when not set', function () {
      var u = fs.buildSearchUrl('foo');
      assert.ok(u.indexOf('regex') === -1);
      assert.ok(u.indexOf('caseSensitive') === -1);
      assert.ok(u.indexOf('glob') === -1);
      assert.ok(u.indexOf('path') === -1);
      assert.ok(u.indexOf('token') === -1);
    });

    it('appends regex=1 when regex flag set', function () {
      var u = fs.buildSearchUrl('foo', { regex: true });
      assert.ok(u.indexOf('regex=1') !== -1, 'should include regex=1: ' + u);
    });

    it('appends caseSensitive=1 when flag set', function () {
      var u = fs.buildSearchUrl('foo', { caseSensitive: true });
      assert.ok(u.indexOf('caseSensitive=1') !== -1);
    });

    it('appends glob param URL-encoded', function () {
      var u = fs.buildSearchUrl('foo', { glob: '*.{ts,tsx}' });
      assert.ok(u.indexOf('glob=%2A.%7Bts%2Ctsx%7D') !== -1, 'glob encoded: ' + u);
    });

    it('appends path param URL-encoded', function () {
      var u = fs.buildSearchUrl('foo', { path: '/home/user/proj' });
      assert.ok(u.indexOf('path=%2Fhome%2Fuser%2Fproj') !== -1);
    });

    it('appends token param URL-encoded (EventSource-friendly auth)', function () {
      var u = fs.buildSearchUrl('foo', { token: 'abc def' });
      assert.ok(u.indexOf('token=abc%20def') !== -1);
    });

    it('combines multiple options correctly', function () {
      var u = fs.buildSearchUrl('foo', {
        regex: true, caseSensitive: true, glob: '*.ts',
        path: '/p', token: 't',
      });
      // Order is: q, regex, caseSensitive, glob, path, token.
      assert.strictEqual(u,
        '/api/search?q=foo&regex=1&caseSensitive=1&glob=%2A.ts&path=%2Fp&token=t');
    });

    it('returns empty string for falsy query', function () {
      assert.strictEqual(fs.buildSearchUrl(''), '');
      assert.strictEqual(fs.buildSearchUrl(null), '');
      assert.strictEqual(fs.buildSearchUrl(undefined), '');
    });

    it('coerces non-string query to string for encoding safety', function () {
      assert.strictEqual(fs.buildSearchUrl(42), '/api/search?q=42');
    });
  });

  describe('formatLocation', function () {
    it('returns path:line:col when both line and col are present', function () {
      assert.strictEqual(fs.formatLocation('src/foo.js', 42, 7), 'src/foo.js:42:7');
    });

    it('returns path:line when col is missing/empty', function () {
      assert.strictEqual(fs.formatLocation('src/foo.js', 42), 'src/foo.js:42');
      assert.strictEqual(fs.formatLocation('src/foo.js', 42, ''), 'src/foo.js:42');
      assert.strictEqual(fs.formatLocation('src/foo.js', 42, null), 'src/foo.js:42');
    });

    it('returns just path when line is missing', function () {
      assert.strictEqual(fs.formatLocation('src/foo.js'), 'src/foo.js');
      assert.strictEqual(fs.formatLocation('src/foo.js', null, 5), 'src/foo.js');
    });

    it('handles zero values (line/col 0 is technically valid)', function () {
      // 0 is a falsy line; current impl treats it as missing. Document
      // this so a future change is intentional.
      assert.strictEqual(fs.formatLocation('src/foo.js', 0), 'src/foo.js');
      // col 0 is preserved as ':0'.
      assert.strictEqual(fs.formatLocation('src/foo.js', 1, 0), 'src/foo.js:1:0');
    });

    it('handles empty/null path defensively', function () {
      assert.strictEqual(fs.formatLocation('', 42, 7), ':42:7');
      assert.strictEqual(fs.formatLocation(null, 42, 7), ':42:7');
    });
  });
});
