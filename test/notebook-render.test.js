// test/notebook-render.test.js — pure-JS helpers for the notebook viewer.
//
// DOM/network paths (renderInto, lazy CDN load of nbviewer.js, DOMPurify
// sanitisation of nbv.render output) are exercised by the Playwright e2e
// suite (task #11). This file covers the testable seam: notebook source
// parsing + module exports.

'use strict';

const path = require('path');
const assert = require('assert');

const modulePath = path.join(__dirname, '..', 'src', 'public', 'notebook-render.js');
delete require.cache[require.resolve(modulePath)];

const nb = require(modulePath);

describe('notebook-render.js (pure helpers)', function () {
  describe('exports under Node', function () {
    it('exposes parseNotebook', function () {
      assert.strictEqual(typeof nb.parseNotebook, 'function');
    });
    it('exposes the CDN URL + sanitize config constants', function () {
      assert.strictEqual(typeof nb.NBV_CDN, 'string');
      assert.ok(nb.NBV_CDN.indexOf('nbviewer.js') !== -1);
      assert.strictEqual(typeof nb.SANITIZE_CONFIG, 'object');
      assert.ok(Array.isArray(nb.SANITIZE_CONFIG.FORBID_ATTR));
      assert.ok(Array.isArray(nb.SANITIZE_CONFIG.FORBID_TAGS));
    });
    it('does NOT expose renderInto under Node (DOM-only)', function () {
      assert.strictEqual(typeof nb.renderInto, 'undefined');
    });
  });

  describe('SANITIZE_CONFIG', function () {
    it('forbids style + srcset attrs (matches markdown-render defenses)', function () {
      assert.ok(nb.SANITIZE_CONFIG.FORBID_ATTR.indexOf('style') !== -1);
      assert.ok(nb.SANITIZE_CONFIG.FORBID_ATTR.indexOf('srcset') !== -1);
    });
    it('forbids form/style/input/button (CSRF + UX-spoof + CSS-rule defenses)', function () {
      ['style', 'form', 'input', 'button'].forEach(function (tag) {
        assert.ok(nb.SANITIZE_CONFIG.FORBID_TAGS.indexOf(tag) !== -1,
          'tag should be in FORBID_TAGS: ' + tag);
      });
    });
    it('uses the html USE_PROFILES preset', function () {
      assert.strictEqual(nb.SANITIZE_CONFIG.USE_PROFILES.html, true);
    });
  });

  describe('parseNotebook', function () {
    var validIpynbJson = JSON.stringify({
      cells: [
        { cell_type: 'markdown', source: ['# Hello\n'] },
        { cell_type: 'code', source: ['print("hi")\n'], outputs: [], execution_count: 1 },
      ],
      metadata: { kernelspec: { name: 'python3' } },
      nbformat: 4,
      nbformat_minor: 5,
    });

    it('parses a valid notebook JSON string into { ok:true, notebook }', function () {
      var r = nb.parseNotebook(validIpynbJson);
      assert.strictEqual(r.ok, true);
      assert.ok(r.notebook);
      assert.strictEqual(r.notebook.cells.length, 2);
    });

    it('accepts an already-parsed notebook object', function () {
      var obj = JSON.parse(validIpynbJson);
      var r = nb.parseNotebook(obj);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.notebook, obj, 'returns the same reference');
    });

    it('rejects malformed JSON with a specific error', function () {
      var r = nb.parseNotebook('{not valid json');
      assert.strictEqual(r.ok, false);
      assert.ok(/invalid JSON/.test(r.error), 'error mentions JSON: ' + r.error);
    });

    it('rejects empty / whitespace-only input', function () {
      assert.strictEqual(nb.parseNotebook('').ok, false);
      assert.strictEqual(nb.parseNotebook('   \n').ok, false);
      assert.strictEqual(nb.parseNotebook(null).ok, false);
      assert.strictEqual(nb.parseNotebook(undefined).ok, false);
    });

    it('rejects valid JSON that is not a notebook (no cells[])', function () {
      var r = nb.parseNotebook('{"foo":"bar"}');
      assert.strictEqual(r.ok, false);
      assert.ok(/cells/.test(r.error), 'error mentions cells: ' + r.error);
    });

    it('rejects valid JSON whose root is not an object', function () {
      var r = nb.parseNotebook('[1,2,3]');
      assert.strictEqual(r.ok, false);
      assert.ok(/cells/.test(r.error) || /object/.test(r.error));
    });

    it('rejects already-parsed objects without cells[]', function () {
      var r = nb.parseNotebook({ foo: 'bar' });
      assert.strictEqual(r.ok, false);
      assert.ok(/cells/.test(r.error));
    });

    it('rejects non-string non-object input (defensive)', function () {
      assert.strictEqual(nb.parseNotebook(42).ok, false);
      assert.strictEqual(nb.parseNotebook(true).ok, false);
    });

    it('handles empty cells[] (a brand-new notebook)', function () {
      var r = nb.parseNotebook(JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.notebook.cells.length, 0);
    });
  });
});
