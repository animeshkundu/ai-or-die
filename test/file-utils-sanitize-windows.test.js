// test/file-utils-sanitize-windows.test.js — Windows-first hardening of
// sanitizeFileName(). Uploads land on the server filesystem (primary deployment
// target: Windows 11), so the one chokepoint all uploads pass through
// (src/server.js → sanitizeFileName) must neutralize names that are illegal or
// dangerous on NTFS: reserved device names, Alternate Data Streams (`:`),
// Windows-forbidden characters, and trailing dot/space.

'use strict';

const assert = require('assert');
const { sanitizeFileName } = require('../src/utils/file-utils');

describe('sanitizeFileName — Windows hardening', function () {
  describe('reserved device names', function () {
    const reserved = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9'];

    reserved.forEach((name) => {
      it(`neutralizes bare "${name}"`, function () {
        assert.strictEqual(sanitizeFileName(name), '_' + name);
      });
      it(`neutralizes "${name}" with an extension`, function () {
        assert.strictEqual(sanitizeFileName(name + '.txt'), '_' + name + '.txt');
      });
    });

    it('is case-insensitive', function () {
      assert.strictEqual(sanitizeFileName('con.txt'), '_con.txt');
      assert.strictEqual(sanitizeFileName('Aux'), '_Aux');
    });

    it('matches the stem before the FIRST dot (COM1.tar.gz is still COM1)', function () {
      assert.strictEqual(sanitizeFileName('COM1.tar.gz'), '_COM1.tar.gz');
    });

    it('does NOT touch names that merely start with a reserved prefix', function () {
      assert.strictEqual(sanitizeFileName('console.log'), 'console.log');
      assert.strictEqual(sanitizeFileName('communication.md'), 'communication.md');
      assert.strictEqual(sanitizeFileName('com10.txt'), 'com10.txt'); // only COM1-9
      assert.strictEqual(sanitizeFileName('nullable.js'), 'nullable.js');
    });
  });

  describe('NTFS Alternate Data Streams + forbidden chars', function () {
    it('strips the colon that introduces an ADS', function () {
      assert.strictEqual(sanitizeFileName('report.pdf:evil.exe'), 'report.pdfevil.exe');
    });
    it('strips Windows-forbidden characters < > : " | ? *', function () {
      assert.strictEqual(sanitizeFileName('a<b>c:d"e|f?g*h.txt'), 'abcdefgh.txt');
    });
  });

  describe('trailing dot / space (illegal on Windows)', function () {
    it('trims a trailing dot', function () {
      assert.strictEqual(sanitizeFileName('report.'), 'report');
    });
    it('trims trailing spaces', function () {
      assert.strictEqual(sanitizeFileName('report.txt   '), 'report.txt');
    });
  });

  describe('regressions — existing behavior preserved', function () {
    it('leaves ordinary names untouched', function () {
      assert.strictEqual(sanitizeFileName('notes.md'), 'notes.md');
      assert.strictEqual(sanitizeFileName('my-file_v2.tar.gz'), 'my-file_v2.tar.gz');
    });
    it('still strips path separators', function () {
      assert.strictEqual(sanitizeFileName('a/b\\c.txt'), 'abc.txt');
    });
    it('still throws on empty / non-string input', function () {
      assert.throws(() => sanitizeFileName(''), /File name is required/);
      assert.throws(() => sanitizeFileName(null), /File name is required/);
    });
    it('throws when nothing survives sanitization', function () {
      assert.throws(() => sanitizeFileName(':::'), /empty after sanitization/);
    });
  });
});
