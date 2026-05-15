// test/generic-drop-handler.test.js — Part D of the file-browser-v2
// iteration. Sibling to image-handler.js (the image flow stays as-is per
// adversarial review). Dispatcher routes by MIME at the terminal
// container; image MIMEs delegate to attachImageHandler, all others
// upload to <workingDir>/.claude-attachments/ and inject `@<absolute-path>`
// as bracketed paste.
//
// Pure-helper tests under Node directly:
//   - isImageMime(file) — MIME dispatch predicate
//   - sanitizeBasename(name) — defensive filename cleanup
//   - buildAtPathInjection(absPath) — `@<path>` bracketed-paste payload
//   - buildAttachmentTarget(workingDir, basename) — UUID + filename layout
//
// JSDOM-driven tests (skipped when jsdom missing):
//   - drop event with image MIME → imageHandler hook fires; generic
//     pipeline does NOT
//   - drop event with non-image MIME → upload fetch fires; on success,
//     onInject({ path }) fires with the absolute path
//   - multi-file drop: up to 4 in flight; cancel aborts in-flight uploads
//     via AbortController; per-file failure surfaces a toast and only
//     successful paths inject
//   - hard limit of 10 files per drop

'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const modulePath = path.join(__dirname, '..', 'src', 'public', 'generic-drop-handler.js');
delete require.cache[require.resolve(modulePath)];

const gd = require(modulePath);

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (_) { /* will skip below */ }

const GD_SRC = path.join(__dirname, '..', 'src', 'public', 'generic-drop-handler.js');

// ---------------------------------------------------------------------------
// Pure helpers (Node-only)
// ---------------------------------------------------------------------------

describe('generic-drop-handler.js (pure helpers)', function () {

  describe('exports under Node', function () {
    it('exposes the pure helpers + constants', function () {
      assert.strictEqual(typeof gd.isImageMime, 'function');
      assert.strictEqual(typeof gd.sanitizeBasename, 'function');
      assert.strictEqual(typeof gd.buildAtPathInjection, 'function');
      assert.strictEqual(typeof gd.buildAttachmentTarget, 'function');
      assert.strictEqual(gd.MAX_FILES_PER_DROP, 10);
      assert.strictEqual(gd.MAX_PARALLEL_UPLOADS, 4);
      assert.strictEqual(gd.ATTACHMENTS_DIRNAME, '.claude-attachments');
    });
  });

  describe('isImageMime', function () {
    it('returns true for image/* MIME types', function () {
      assert.strictEqual(gd.isImageMime({ type: 'image/png' }), true);
      assert.strictEqual(gd.isImageMime({ type: 'image/jpeg' }), true);
      assert.strictEqual(gd.isImageMime({ type: 'image/webp' }), true);
      assert.strictEqual(gd.isImageMime({ type: 'image/gif' }), true);
    });
    it('returns false for non-image MIME types', function () {
      assert.strictEqual(gd.isImageMime({ type: 'application/pdf' }), false);
      assert.strictEqual(gd.isImageMime({ type: 'text/plain' }), false);
      assert.strictEqual(gd.isImageMime({ type: 'application/octet-stream' }), false);
    });
    it('returns false for empty / missing type (defensive)', function () {
      assert.strictEqual(gd.isImageMime({ type: '' }), false);
      assert.strictEqual(gd.isImageMime({}), false);
      assert.strictEqual(gd.isImageMime(null), false);
      assert.strictEqual(gd.isImageMime(undefined), false);
    });
  });

  describe('sanitizeBasename', function () {
    it('strips path separators (/ and \\)', function () {
      assert.strictEqual(gd.sanitizeBasename('a/b/c.txt'), 'c.txt');
      assert.strictEqual(gd.sanitizeBasename('a\\b\\c.txt'), 'c.txt');
    });
    it('strips control characters', function () {
      assert.strictEqual(gd.sanitizeBasename('foo\x00bar.txt'), 'foobar.txt');
    });
    it('truncates to 200 chars to leave room for the UUID prefix', function () {
      var long = new Array(300).join('a') + '.txt';
      var got = gd.sanitizeBasename(long);
      assert.ok(got.length <= 200, 'len: ' + got.length);
    });
    it('falls back to "file" for empty / null / whitespace input', function () {
      assert.strictEqual(gd.sanitizeBasename(''), 'file');
      assert.strictEqual(gd.sanitizeBasename(null), 'file');
      assert.strictEqual(gd.sanitizeBasename('   '), 'file');
    });
  });

  describe('buildAtPathInjection', function () {
    it('wraps a path as `@<path>` for Claude-native file reference', function () {
      assert.strictEqual(gd.buildAtPathInjection('/Users/foo/file.pdf'), '@/Users/foo/file.pdf');
    });
    it('does not quote the path (bracketed paste handles whitespace)', function () {
      assert.strictEqual(gd.buildAtPathInjection('/has space/file.pdf'), '@/has space/file.pdf');
    });
    it('returns empty string for empty / null input', function () {
      assert.strictEqual(gd.buildAtPathInjection(''), '');
      assert.strictEqual(gd.buildAtPathInjection(null), '');
    });
  });

  describe('buildAttachmentTarget', function () {
    it('joins workingDir + .claude-attachments + UUID-basename', function () {
      var t = gd.buildAttachmentTarget('/Users/foo/proj', 'mydoc.pdf', 'uuid-1');
      // Expect POSIX slashes — server normalizes anyway.
      assert.ok(t.indexOf('/Users/foo/proj/') === 0, 'starts with workingDir: ' + t);
      assert.ok(t.indexOf('.claude-attachments') !== -1, 'includes attachments dir: ' + t);
      assert.ok(t.indexOf('uuid-1-mydoc.pdf') !== -1, 'includes uuid-basename: ' + t);
    });
    it('handles Windows-style workingDir with back-slashes', function () {
      var t = gd.buildAttachmentTarget('C:\\Users\\foo', 'a.txt', 'u');
      assert.ok(t.indexOf('.claude-attachments') !== -1);
      assert.ok(t.indexOf('u-a.txt') !== -1);
    });
    it('sanitizes the basename before building the target', function () {
      var t = gd.buildAttachmentTarget('/Users/foo', '../evil.txt', 'u');
      // ../ stripped via sanitizeBasename → just 'evil.txt'.
      assert.ok(t.indexOf('u-evil.txt') !== -1, 'evil.txt: ' + t);
      assert.strictEqual(t.indexOf('..'), -1, 'no .. allowed: ' + t);
    });
  });
});

// ---------------------------------------------------------------------------
// JSDOM — drop event flow
// ---------------------------------------------------------------------------

(JSDOM ? describe : describe.skip)('attachGenericDropHandler (JSDOM)', function () {
  this.timeout(10000);

  let window, document, container, attachGenericDropHandler;

  beforeEach(function () {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    window = dom.window;
    document = window.document;
    // Minimal globals needed by the IIFE.
    window.icons = { x: () => 'x' };
    const src = fs.readFileSync(GD_SRC, 'utf8');
    window.eval(src);
    attachGenericDropHandler = window.genericDropHandler.attachGenericDropHandler;

    container = document.createElement('div');
    container.id = 'terminal';
    document.body.appendChild(container);
  });

  // ---- helpers ----

  function makeFile(name, type, sizeKb) {
    sizeKb = sizeKb || 1;
    var bytes = new window.Uint8Array(sizeKb * 1024);
    return new window.File([bytes], name, { type: type || 'application/octet-stream' });
  }

  function dispatchDrop(el, files) {
    // JSDOM lacks a DataTransfer constructor. Fake the minimal surface
    // the handler reads: `dataTransfer.files` (FileList-ish) +
    // `dataTransfer.types`. Files is an array — File[] suffices because
    // our handler indexes via [i] and reads .length, never invokes
    // FileList-specific methods.
    var dt = {
      files: files,
      types: ['Files'],
    };
    var ev = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    el.dispatchEvent(ev);
    return ev;
  }

  function flush() {
    return new Promise(function (resolve) { setImmediate(resolve); });
  }

  // ---- tests ----

  it('image MIME drops delegate to the image handler hook', function () {
    var imageCalls = [];
    var genericCalls = [];
    attachGenericDropHandler({
      containerEl: container,
      getWorkingDir: function () { return '/Users/foo'; },
      onImageDrop: function (files) { imageCalls.push(files); },
      onGenericFile: function (file) { genericCalls.push(file); },
      uploadImpl: function () { return Promise.resolve({ ok: true, status: 201 }); },
      injectAtPath: function () {},
    });
    var file = makeFile('cat.png', 'image/png');
    dispatchDrop(container, [file]);
    assert.strictEqual(imageCalls.length, 1, 'image handler should fire');
    assert.strictEqual(imageCalls[0].length, 1);
    assert.strictEqual(genericCalls.length, 0, 'generic handler must NOT fire');
  });

  it('non-image MIME triggers upload + @path injection', function (done) {
    var injects = [];
    var uploadCalls = [];
    attachGenericDropHandler({
      containerEl: container,
      getWorkingDir: function () { return '/Users/foo'; },
      onImageDrop: function () {},
      uploadImpl: function (target, file, opts) {
        uploadCalls.push({ target: target, file: file });
        return Promise.resolve({
          ok: true, status: 201,
          json: function () { return Promise.resolve({ path: target }); },
        });
      },
      injectAtPath: function (atSyntax) { injects.push(atSyntax); },
    });
    dispatchDrop(container, [makeFile('mydoc.pdf', 'application/pdf')]);
    flush().then(flush).then(function () {
      assert.strictEqual(uploadCalls.length, 1, 'one upload fired');
      assert.ok(uploadCalls[0].target.indexOf('.claude-attachments/') !== -1, 'target: ' + uploadCalls[0].target);
      assert.ok(uploadCalls[0].target.indexOf('mydoc.pdf') !== -1, 'target: ' + uploadCalls[0].target);
      assert.strictEqual(injects.length, 1, 'one @path injection');
      assert.ok(injects[0].indexOf('@') === 0, 'starts with @: ' + injects[0]);
      done();
    }).catch(done);
  });

  it('mixed drop: images go to image handler, others go through generic', function () {
    var imageCalls = [];
    var uploadCalls = [];
    attachGenericDropHandler({
      containerEl: container,
      getWorkingDir: function () { return '/Users/foo'; },
      onImageDrop: function (files) { imageCalls.push(files); },
      uploadImpl: function (target, file) {
        uploadCalls.push(file.name);
        return Promise.resolve({ ok: true, status: 201, json: function () { return Promise.resolve({ path: target }); } });
      },
      injectAtPath: function () {},
    });
    var img = makeFile('cat.png', 'image/png');
    var pdf = makeFile('doc.pdf', 'application/pdf');
    dispatchDrop(container, [img, pdf]);
    assert.strictEqual(imageCalls.length, 1, 'image handler fired once with 1 file');
    assert.strictEqual(imageCalls[0].length, 1);
    assert.strictEqual(uploadCalls.length, 1, 'one generic upload fired');
    assert.strictEqual(uploadCalls[0], 'doc.pdf');
  });

  it('multi-file drop: caps at MAX_FILES_PER_DROP=10', function (done) {
    var uploadCalls = [];
    attachGenericDropHandler({
      containerEl: container,
      getWorkingDir: function () { return '/Users/foo' },
      onImageDrop: function () {},
      uploadImpl: function (target, file) {
        uploadCalls.push(file.name);
        return Promise.resolve({ ok: true, status: 201, json: function () { return Promise.resolve({ path: target }); } });
      },
      injectAtPath: function () {},
    });
    var files = [];
    for (var i = 0; i < 15; i++) files.push(makeFile('f' + i + '.txt', 'text/plain'));
    dispatchDrop(container, files);
    // Worker queue is bounded at MAX_PARALLEL_UPLOADS=4 — drain by
    // flushing repeatedly until all uploads complete.
    function drainAndAssert() {
      flush().then(flush).then(function () {
        if (uploadCalls.length < 10) {
          drainAndAssert();
          return;
        }
        try {
          assert.strictEqual(uploadCalls.length, 10, 'cap enforced at 10');
          done();
        } catch (e) { done(e); }
      });
    }
    drainAndAssert();
  });

  it('per-file failure surfaces a toast and only successful paths inject', function (done) {
    var injects = [];
    var toasts = [];
    attachGenericDropHandler({
      containerEl: container,
      getWorkingDir: function () { return '/Users/foo' },
      onImageDrop: function () {},
      uploadImpl: function (target, file) {
        if (file.name === 'bad.exe') {
          return Promise.resolve({
            ok: false, status: 422,
            json: function () { return Promise.resolve({ error: 'blocked' }); },
          });
        }
        return Promise.resolve({
          ok: true, status: 201,
          json: function () { return Promise.resolve({ path: target }); },
        });
      },
      injectAtPath: function (atPath) { injects.push(atPath); },
      onError: function (basename, msg) { toasts.push({ basename: basename, msg: msg }); },
    });
    dispatchDrop(container, [
      makeFile('good.pdf', 'application/pdf'),
      makeFile('bad.exe', 'application/octet-stream'),
    ]);
    flush().then(flush).then(flush).then(function () {
      assert.strictEqual(injects.length, 1, 'only the success injects: ' + JSON.stringify(injects));
      assert.ok(injects[0].indexOf('good.pdf') !== -1);
      assert.strictEqual(toasts.length, 1);
      assert.strictEqual(toasts[0].basename, 'bad.exe');
      done();
    }).catch(done);
  });

  it('cancel aborts in-flight uploads via AbortController', function (done) {
    var aborted = [];
    var injects = [];
    var pendingResolvers = [];
    var controller;
    controller = attachGenericDropHandler({
      containerEl: container,
      getWorkingDir: function () { return '/Users/foo' },
      onImageDrop: function () {},
      uploadImpl: function (target, file, opts) {
        // Wire abort listener; resolve never (the cancel path tests).
        return new Promise(function (resolve, reject) {
          pendingResolvers.push(resolve);
          if (opts && opts.signal) {
            opts.signal.addEventListener('abort', function () {
              aborted.push(file.name);
              var err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      },
      injectAtPath: function (atPath) { injects.push(atPath); },
    });
    dispatchDrop(container, [
      makeFile('a.pdf', 'application/pdf'),
      makeFile('b.pdf', 'application/pdf'),
    ]);
    // Cancel — should abort all in-flight uploads.
    flush().then(function () {
      controller.cancelInFlight();
      return flush().then(flush);
    }).then(function () {
      assert.ok(aborted.length >= 1, 'at least one upload aborted: ' + JSON.stringify(aborted));
      assert.strictEqual(injects.length, 0, 'no injections after cancel');
      done();
    }).catch(done);
  });
});
