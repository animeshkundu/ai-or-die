// test/file-editor.test.js — pure-JS exports of the FileEditorPanel module.
//
// DOM / Monaco-bound paths (loadMonaco, createCodeViewer, autosave timer,
// 409 conflict UI, diff editor) are exercised by the Playwright e2e suite
// (task #11). This file covers the testable seam: the language-resolution
// helpers and the public surface shape.

'use strict';

const path = require('path');
const assert = require('assert');

const fileEditorPath = path.join(__dirname, '..', 'src', 'public', 'file-editor.js');
const monacoLoaderPath = path.join(__dirname, '..', 'src', 'public', 'file-viewer-monaco.js');

// Drop any cached state, then load both modules. file-editor.js delegates
// language lookups to the Monaco loader module via require() under Node.
delete require.cache[require.resolve(fileEditorPath)];
delete require.cache[require.resolve(monacoLoaderPath)];

const fileEditor = require(fileEditorPath);
const monacoLoader = require(monacoLoaderPath);

describe('file-editor.js (Monaco migration)', function () {
  describe('exports', function () {
    it('exposes the FileEditorPanel constructor', function () {
      assert.strictEqual(typeof fileEditor.FileEditorPanel, 'function');
    });

    it('exposes getMonacoLanguage as the canonical language helper', function () {
      assert.strictEqual(typeof fileEditor.getMonacoLanguage, 'function');
    });

    it('preserves getAceMode as a backward-compat alias', function () {
      assert.strictEqual(typeof fileEditor.getAceMode, 'function');
    });

    it('preserves getExtension and getFileName helpers', function () {
      assert.strictEqual(typeof fileEditor.getExtension, 'function');
      assert.strictEqual(typeof fileEditor.getFileName, 'function');
    });
  });

  describe('getExtension', function () {
    it('returns the dot-prefixed extension for a simple filename', function () {
      assert.strictEqual(fileEditor.getExtension('foo.js'), '.js');
    });

    it('returns the rightmost extension on multi-dot filenames', function () {
      assert.strictEqual(fileEditor.getExtension('foo.bar.ts'), '.ts');
    });

    it('returns empty string for files with no extension', function () {
      assert.strictEqual(fileEditor.getExtension('Dockerfile'), '');
    });

    it('returns empty string for null/undefined input (defensive)', function () {
      assert.strictEqual(fileEditor.getExtension(null), '');
      assert.strictEqual(fileEditor.getExtension(undefined), '');
    });

    it('handles full Unix and Windows paths', function () {
      assert.strictEqual(fileEditor.getExtension('/home/user/src/index.ts'), '.ts');
      assert.strictEqual(fileEditor.getExtension('C:\\Users\\me\\app.py'), '.py');
    });
  });

  describe('getFileName', function () {
    it('returns the basename for a Unix path', function () {
      assert.strictEqual(fileEditor.getFileName('/a/b/c.txt'), 'c.txt');
    });

    it('returns the basename for a Windows path', function () {
      assert.strictEqual(fileEditor.getFileName('C:\\a\\b\\c.txt'), 'c.txt');
    });

    it('returns the input when there are no path separators', function () {
      assert.strictEqual(fileEditor.getFileName('readme.md'), 'readme.md');
    });

    it('returns empty string for null input (defensive)', function () {
      assert.strictEqual(fileEditor.getFileName(null), '');
    });
  });

  describe('getMonacoLanguage', function () {
    it('returns the Monaco language id for known extensions', function () {
      assert.strictEqual(fileEditor.getMonacoLanguage('.ts'), 'typescript');
      assert.strictEqual(fileEditor.getMonacoLanguage('.js'), 'javascript');
      assert.strictEqual(fileEditor.getMonacoLanguage('.py'), 'python');
      assert.strictEqual(fileEditor.getMonacoLanguage('.md'), 'markdown');
      assert.strictEqual(fileEditor.getMonacoLanguage('.json'), 'json');
    });

    it('returns plaintext for unknown extensions', function () {
      assert.strictEqual(fileEditor.getMonacoLanguage('.xyzunknown'), 'plaintext');
    });

    it('returns plaintext for empty/null input', function () {
      assert.strictEqual(fileEditor.getMonacoLanguage(''), 'plaintext');
      assert.strictEqual(fileEditor.getMonacoLanguage(null), 'plaintext');
      assert.strictEqual(fileEditor.getMonacoLanguage(undefined), 'plaintext');
    });

    it('uses Monaco canonical IDs (not Ace IDs) for diverging languages', function () {
      // These are the Ace → Monaco renames that ADR-0016 calls out as the
      // mechanical change set. Hard-code the assertions so a regression
      // (someone re-importing the Ace map) is caught loudly.
      assert.strictEqual(fileEditor.getMonacoLanguage('.go'), 'go');         // not 'golang'
      assert.strictEqual(fileEditor.getMonacoLanguage('.cpp'), 'cpp');       // not 'c_cpp'
      assert.strictEqual(fileEditor.getMonacoLanguage('.sh'), 'shell');      // not 'sh'
      assert.strictEqual(fileEditor.getMonacoLanguage('.bat'), 'bat');       // not 'batchfile'
      assert.strictEqual(fileEditor.getMonacoLanguage('.txt'), 'plaintext'); // not 'text'
      // JSX/TSX → javascript/typescript (Monaco's TS service handles JSX).
      assert.strictEqual(fileEditor.getMonacoLanguage('.jsx'), 'javascript');
      assert.strictEqual(fileEditor.getMonacoLanguage('.tsx'), 'typescript');
    });

    it('matches the loader module verbatim (no drift between aliases)', function () {
      // Sanity check the cross-module delegation: the editor's helper must
      // forward to the loader's authoritative map, not maintain a copy.
      ['.js', '.ts', '.py', '.md', '.json', '.cpp', '.sh', '.unknownext']
        .forEach(function (ext) {
          assert.strictEqual(
            fileEditor.getMonacoLanguage(ext),
            monacoLoader.getMonacoLanguage(ext),
            'mismatch on ' + ext
          );
        });
    });

    it('handles full paths by extracting the basename extension', function () {
      assert.strictEqual(
        fileEditor.getMonacoLanguage('/home/user/src/server.js'),
        'javascript'
      );
      assert.strictEqual(
        fileEditor.getMonacoLanguage('C:\\projects\\app\\index.ts'),
        'typescript'
      );
    });
  });

  describe('getAceMode (deprecated alias)', function () {
    it('returns the same value as getMonacoLanguage', function () {
      ['.js', '.ts', '.py', '.unknownext', '', null].forEach(function (ext) {
        assert.strictEqual(
          fileEditor.getAceMode(ext),
          fileEditor.getMonacoLanguage(ext),
          'alias diverged on ' + JSON.stringify(ext)
        );
      });
    });
  });
});
