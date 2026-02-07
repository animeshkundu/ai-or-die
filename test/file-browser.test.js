const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getFileInfo,
  sanitizeFileName,
  isBlockedExtension,
  formatFileSize,
  normalizePath,
  computeFileHash,
  isBinaryFile,
} = require('../src/utils/file-utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let tmpFiles = [];

function createTmpFile(name, content) {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
  tmpFiles.push(filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('file-utils', function () {

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-utils-test-'));
    tmpFiles = [];
  });

  afterEach(function () {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
    }
    try { fs.rmdirSync(tmpDir); } catch (_) { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // getFileInfo
  // -------------------------------------------------------------------------

  describe('getFileInfo', function () {

    it('should map .png to image category', function () {
      const info = getFileInfo('photo.png');
      assert.strictEqual(info.mimeCategory, 'image');
      assert.strictEqual(info.previewable, true);
      assert.strictEqual(info.editable, false);
    });

    it('should map .jpg to image category', function () {
      const info = getFileInfo('photo.jpg');
      assert.strictEqual(info.mimeCategory, 'image');
      assert.strictEqual(info.previewable, true);
      assert.strictEqual(info.editable, false);
    });

    it('should map .jpeg to image category', function () {
      const info = getFileInfo('photo.jpeg');
      assert.strictEqual(info.mimeCategory, 'image');
    });

    it('should map .gif to image category', function () {
      const info = getFileInfo('anim.gif');
      assert.strictEqual(info.mimeCategory, 'image');
    });

    it('should map .webp to image category', function () {
      const info = getFileInfo('image.webp');
      assert.strictEqual(info.mimeCategory, 'image');
    });

    it('should map .svg to image category', function () {
      const info = getFileInfo('icon.svg');
      assert.strictEqual(info.mimeCategory, 'image');
    });

    it('should map .js to code category (previewable and editable)', function () {
      const info = getFileInfo('app.js');
      assert.strictEqual(info.mimeCategory, 'code');
      assert.strictEqual(info.previewable, true);
      assert.strictEqual(info.editable, true);
    });

    it('should map .ts to code category', function () {
      assert.strictEqual(getFileInfo('index.ts').mimeCategory, 'code');
    });

    it('should map .py to code category', function () {
      assert.strictEqual(getFileInfo('script.py').mimeCategory, 'code');
    });

    it('should map .go to code category', function () {
      assert.strictEqual(getFileInfo('main.go').mimeCategory, 'code');
    });

    it('should map .rs to code category', function () {
      assert.strictEqual(getFileInfo('lib.rs').mimeCategory, 'code');
    });

    it('should map .java to code category', function () {
      assert.strictEqual(getFileInfo('Main.java').mimeCategory, 'code');
    });

    it('should map .c and .cpp to code category', function () {
      assert.strictEqual(getFileInfo('main.c').mimeCategory, 'code');
      assert.strictEqual(getFileInfo('main.cpp').mimeCategory, 'code');
    });

    it('should map .html, .css, .yaml, .sh to code category', function () {
      assert.strictEqual(getFileInfo('page.html').mimeCategory, 'code');
      assert.strictEqual(getFileInfo('style.css').mimeCategory, 'code');
      assert.strictEqual(getFileInfo('config.yaml').mimeCategory, 'code');
      assert.strictEqual(getFileInfo('run.sh').mimeCategory, 'code');
    });

    it('should map .md to markdown category (editable)', function () {
      const info = getFileInfo('README.md');
      assert.strictEqual(info.mimeCategory, 'markdown');
      assert.strictEqual(info.editable, true);
    });

    it('should map .json to json category (editable)', function () {
      const info = getFileInfo('package.json');
      assert.strictEqual(info.mimeCategory, 'json');
      assert.strictEqual(info.editable, true);
    });

    it('should map .csv to csv category (editable)', function () {
      const info = getFileInfo('data.csv');
      assert.strictEqual(info.mimeCategory, 'csv');
      assert.strictEqual(info.editable, true);
    });

    it('should map .pdf to pdf category (previewable, not editable)', function () {
      const info = getFileInfo('document.pdf');
      assert.strictEqual(info.mimeCategory, 'pdf');
      assert.strictEqual(info.previewable, true);
      assert.strictEqual(info.editable, false);
    });

    it('should map .exe to binary category', function () {
      const info = getFileInfo('program.exe');
      assert.strictEqual(info.mimeCategory, 'binary');
      assert.strictEqual(info.previewable, false);
      assert.strictEqual(info.editable, false);
    });

    it('should map unknown extension to binary', function () {
      const info = getFileInfo('data.unknown');
      assert.strictEqual(info.mimeCategory, 'binary');
      assert.strictEqual(info.previewable, false);
      assert.strictEqual(info.editable, false);
    });

    it('should map file with no extension to binary', function () {
      const info = getFileInfo('noext');
      assert.strictEqual(info.mimeCategory, 'binary');
      assert.strictEqual(info.previewable, false);
      assert.strictEqual(info.editable, false);
    });

    it('should handle extensions case-insensitively', function () {
      assert.strictEqual(getFileInfo('image.PNG').mimeCategory, 'image');
      assert.strictEqual(getFileInfo('README.Md').mimeCategory, 'markdown');
      assert.strictEqual(getFileInfo('config.JSON').mimeCategory, 'json');
    });

    it('should handle files with multiple dots (e.g. foo.test.js)', function () {
      const info = getFileInfo('foo.test.js');
      assert.strictEqual(info.mimeCategory, 'code');
      assert.strictEqual(info.extension, '.js');
    });

    it('should recognize Dockerfile as code', function () {
      const info = getFileInfo('Dockerfile');
      assert.strictEqual(info.mimeCategory, 'code');
      assert.strictEqual(info.previewable, true);
      assert.strictEqual(info.editable, true);
    });

    it('should recognize Makefile as code', function () {
      const info = getFileInfo('Makefile');
      assert.strictEqual(info.mimeCategory, 'code');
      assert.strictEqual(info.previewable, true);
      assert.strictEqual(info.editable, true);
    });
  });

  // -------------------------------------------------------------------------
  // sanitizeFileName
  // -------------------------------------------------------------------------

  describe('sanitizeFileName', function () {

    it('should return a clean name unchanged', function () {
      assert.strictEqual(sanitizeFileName('file.txt'), 'file.txt');
    });

    it('should strip forward slashes', function () {
      assert.strictEqual(sanitizeFileName('path/file.txt'), 'pathfile.txt');
    });

    it('should strip backslashes', function () {
      assert.strictEqual(sanitizeFileName('path\\file.txt'), 'pathfile.txt');
    });

    it('should strip null bytes', function () {
      assert.strictEqual(sanitizeFileName('file\x00.txt'), 'file.txt');
    });

    it('should strip control characters', function () {
      assert.strictEqual(sanitizeFileName('file\x01\x1f.txt'), 'file.txt');
    });

    it('should trim leading and trailing dots and spaces', function () {
      assert.strictEqual(sanitizeFileName('...file.txt...'), 'file.txt');
      assert.strictEqual(sanitizeFileName('  file.txt  '), 'file.txt');
      assert.strictEqual(sanitizeFileName('. . file.txt . .'), 'file.txt');
    });

    it('should throw on empty string', function () {
      assert.throws(() => sanitizeFileName(''), /File name is required/);
    });

    it('should throw on null or undefined', function () {
      assert.throws(() => sanitizeFileName(null), /File name is required/);
      assert.throws(() => sanitizeFileName(undefined), /File name is required/);
    });

    it('should truncate names longer than 255 chars while preserving extension', function () {
      const longName = 'a'.repeat(300) + '.txt';
      const result = sanitizeFileName(longName);
      assert.ok(result.length <= 255);
      assert.ok(result.endsWith('.txt'));
    });
  });

  // -------------------------------------------------------------------------
  // isBlockedExtension
  // -------------------------------------------------------------------------

  describe('isBlockedExtension', function () {

    it('should return true for dangerous extensions', function () {
      assert.strictEqual(isBlockedExtension('app.exe'), true);
      assert.strictEqual(isBlockedExtension('script.bat'), true);
      assert.strictEqual(isBlockedExtension('setup.ps1'), true);
      assert.strictEqual(isBlockedExtension('lib.dll'), true);
      assert.strictEqual(isBlockedExtension('archive.jar'), true);
    });

    it('should return false for safe extensions', function () {
      assert.strictEqual(isBlockedExtension('app.js'), false);
      assert.strictEqual(isBlockedExtension('readme.txt'), false);
      assert.strictEqual(isBlockedExtension('photo.png'), false);
      assert.strictEqual(isBlockedExtension('notes.md'), false);
    });

    it('should be case-insensitive', function () {
      assert.strictEqual(isBlockedExtension('app.EXE'), true);
      assert.strictEqual(isBlockedExtension('script.Bat'), true);
      assert.strictEqual(isBlockedExtension('setup.PS1'), true);
    });

    it('should return false for files with no extension', function () {
      assert.strictEqual(isBlockedExtension('noext'), false);
    });

    it('should return false for unknown extensions', function () {
      assert.strictEqual(isBlockedExtension('data.xyz'), false);
    });
  });

  // -------------------------------------------------------------------------
  // formatFileSize
  // -------------------------------------------------------------------------

  describe('formatFileSize', function () {

    it('should format 0 bytes', function () {
      assert.strictEqual(formatFileSize(0), '0 B');
    });

    it('should format bytes below 1 KB', function () {
      assert.strictEqual(formatFileSize(1023), '1023 B');
    });

    it('should format exactly 1 KB', function () {
      assert.strictEqual(formatFileSize(1024), '1.0 KB');
    });

    it('should format exactly 1 MB', function () {
      assert.strictEqual(formatFileSize(1048576), '1.0 MB');
    });

    it('should format exactly 1 GB', function () {
      assert.strictEqual(formatFileSize(1073741824), '1.0 GB');
    });

    it('should return empty string for null', function () {
      assert.strictEqual(formatFileSize(null), '');
    });

    it('should return empty string for undefined', function () {
      assert.strictEqual(formatFileSize(undefined), '');
    });
  });

  // -------------------------------------------------------------------------
  // normalizePath
  // -------------------------------------------------------------------------

  describe('normalizePath', function () {

    it('should convert backslashes to forward slashes', function () {
      assert.strictEqual(
        normalizePath('C:\\Users\\test\\file.txt'),
        'C:/Users/test/file.txt'
      );
    });

    it('should leave forward slashes unchanged', function () {
      assert.strictEqual(
        normalizePath('/home/user/file.txt'),
        '/home/user/file.txt'
      );
    });

    it('should handle mixed separators', function () {
      assert.strictEqual(
        normalizePath('C:\\Users/test\\file.txt'),
        'C:/Users/test/file.txt'
      );
    });
  });

  // -------------------------------------------------------------------------
  // computeFileHash
  // -------------------------------------------------------------------------

  describe('computeFileHash', function () {

    it('should return a 32-character hex string', async function () {
      const filePath = createTmpFile('hash-test.txt', 'hello world');
      const hash = await computeFileHash(filePath);
      assert.strictEqual(hash.length, 32);
      assert.ok(/^[0-9a-f]{32}$/.test(hash));
    });

    it('should produce the same hash for the same content', async function () {
      const file1 = createTmpFile('hash-a.txt', 'identical content');
      const file2 = createTmpFile('hash-b.txt', 'identical content');
      const hash1 = await computeFileHash(file1);
      const hash2 = await computeFileHash(file2);
      assert.strictEqual(hash1, hash2);
    });

    it('should produce different hashes for different content', async function () {
      const file1 = createTmpFile('diff-a.txt', 'content A');
      const file2 = createTmpFile('diff-b.txt', 'content B');
      const hash1 = await computeFileHash(file1);
      const hash2 = await computeFileHash(file2);
      assert.notStrictEqual(hash1, hash2);
    });
  });

  // -------------------------------------------------------------------------
  // isBinaryFile
  // -------------------------------------------------------------------------

  describe('isBinaryFile', function () {

    it('should return false for a text file', async function () {
      const filePath = createTmpFile('text.txt', 'just plain text\n');
      const result = await isBinaryFile(filePath);
      assert.strictEqual(result, false);
    });

    it('should return true for a file containing null bytes', async function () {
      const filePath = createTmpFile('binary.bin', Buffer.from([0x48, 0x00, 0x65, 0x6c]));
      const result = await isBinaryFile(filePath);
      assert.strictEqual(result, true);
    });

    it('should return false for an empty file', async function () {
      const filePath = createTmpFile('empty.txt', '');
      const result = await isBinaryFile(filePath);
      assert.strictEqual(result, false);
    });

    it('should return true for a file starting with binary content', async function () {
      const buf = Buffer.alloc(64);
      buf[0] = 0x89; // PNG-like magic byte
      buf[1] = 0x50;
      buf[2] = 0x4e;
      buf[3] = 0x47;
      buf[4] = 0x00; // null byte
      const filePath = createTmpFile('magic.bin', buf);
      const result = await isBinaryFile(filePath);
      assert.strictEqual(result, true);
    });
  });
});
