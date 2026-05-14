// test/file-diff.test.js — pure-JS helpers exposed by file-diff.js.
//
// DOM/Monaco-bound paths (DiffViewerPanel constructor, openDiff, the diff
// editor mount, openHeadVsWorking fetch flow) are exercised by the
// Playwright e2e suite (task #11). This file covers the testable seam:
// URL construction + git-show error classification.

'use strict';

const path = require('path');
const assert = require('assert');

const modulePath = path.join(__dirname, '..', 'src', 'public', 'file-diff.js');
delete require.cache[require.resolve(modulePath)];

const fd = require(modulePath);

describe('file-diff.js (pure helpers)', function () {
  describe('exports under Node', function () {
    it('exposes buildGitShowUrl, buildContentUrl, parseGitShowError', function () {
      assert.strictEqual(typeof fd.buildGitShowUrl, 'function');
      assert.strictEqual(typeof fd.buildContentUrl, 'function');
      assert.strictEqual(typeof fd.parseGitShowError, 'function');
    });
    it('does NOT expose DiffViewerPanel under Node (DOM-only)', function () {
      assert.strictEqual(typeof fd.DiffViewerPanel, 'undefined');
    });
  });

  describe('buildGitShowUrl', function () {
    it('omits ref query param when ref is HEAD (default)', function () {
      assert.strictEqual(
        fd.buildGitShowUrl('/a/b.js', 'HEAD'),
        '/api/files/git-show?path=%2Fa%2Fb.js'
      );
    });
    it('includes ref when not HEAD', function () {
      assert.strictEqual(
        fd.buildGitShowUrl('/a/b.js', 'main'),
        '/api/files/git-show?path=%2Fa%2Fb.js&ref=main'
      );
    });
    it('encodes path components (spaces, query chars)', function () {
      assert.strictEqual(
        fd.buildGitShowUrl('/has space/file?.js', 'HEAD'),
        '/api/files/git-show?path=%2Fhas%20space%2Ffile%3F.js'
      );
    });
    it('encodes ref components', function () {
      assert.strictEqual(
        fd.buildGitShowUrl('/x', 'feature/foo bar'),
        '/api/files/git-show?path=%2Fx&ref=feature%2Ffoo%20bar'
      );
    });
    it('returns empty string for falsy path', function () {
      assert.strictEqual(fd.buildGitShowUrl('', 'HEAD'), '');
      assert.strictEqual(fd.buildGitShowUrl(null, 'HEAD'), '');
    });
    it('treats missing ref as HEAD (no ref param)', function () {
      assert.strictEqual(
        fd.buildGitShowUrl('/x', undefined),
        '/api/files/git-show?path=%2Fx'
      );
    });
  });

  describe('buildContentUrl', function () {
    it('encodes the path', function () {
      assert.strictEqual(
        fd.buildContentUrl('/a/b c.js'),
        '/api/files/content?path=%2Fa%2Fb%20c.js'
      );
    });
    it('returns empty string for falsy path', function () {
      assert.strictEqual(fd.buildContentUrl(''), '');
      assert.strictEqual(fd.buildContentUrl(null), '');
    });
  });

  describe('parseGitShowError', function () {
    function fakeResp(status) { return { status: status, ok: false }; }

    it('classifies 404 as not-found', function () {
      var c = fd.parseGitShowError(fakeResp(404));
      assert.strictEqual(c.kind, 'not-found');
      assert.ok(/git repository|did not exist/.test(c.userMessage));
    });
    it('classifies 400 as bad-request', function () {
      assert.strictEqual(fd.parseGitShowError(fakeResp(400)).kind, 'bad-request');
    });
    it('classifies 403 as forbidden', function () {
      assert.strictEqual(fd.parseGitShowError(fakeResp(403)).kind, 'forbidden');
    });
    it('classifies 413 as too-large', function () {
      var c = fd.parseGitShowError(fakeResp(413));
      assert.strictEqual(c.kind, 'too-large');
      assert.ok(/5 MB/.test(c.userMessage));
    });
    it('classifies 503 as git-missing', function () {
      assert.strictEqual(fd.parseGitShowError(fakeResp(503)).kind, 'git-missing');
    });
    it('classifies 504 as timeout', function () {
      assert.strictEqual(fd.parseGitShowError(fakeResp(504)).kind, 'timeout');
    });
    it('classifies generic 5xx as server-error', function () {
      assert.strictEqual(fd.parseGitShowError(fakeResp(502)).kind, 'server-error');
      assert.strictEqual(fd.parseGitShowError(fakeResp(500)).kind, 'server-error');
    });
    it('classifies unknown 4xx as unknown with the status surfaced', function () {
      var c = fd.parseGitShowError(fakeResp(418));
      assert.strictEqual(c.kind, 'unknown');
      assert.ok(/418/.test(c.userMessage));
    });
    it('handles null/undefined input safely', function () {
      assert.strictEqual(fd.parseGitShowError(null).kind, 'unknown');
      assert.strictEqual(fd.parseGitShowError(undefined).kind, 'unknown');
    });
  });
});
