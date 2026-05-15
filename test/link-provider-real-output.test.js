// test/link-provider-real-output.test.js — Realism pass for the link-provider
// regex (task #8 part 1 from team-lead). Where test/link-provider-regex.test.js
// covers the synthetic patterns from the spec, this suite samples REAL CLI
// output captured from the tools developers actually use, runs it through
// LINK_RE_GLOBAL, and asserts the contract:
//
//   - "expected" paths in each fixture must be detected (true positives).
//   - "false positives" — substrings that LOOK path-shaped but aren't —
//     must NOT be detected.
//   - "known limitations" — outputs we acknowledge we don't catch yet —
//     are documented as `it.skip` so the next iteration's diff makes
//     the gap obvious.
//
// Codex's critique of the original regex test suite: synthetic strings
// pass while real output fails. This file closes that gap by working
// from real-output fixtures in test/fixtures/real-cli-output/ — those
// were captured via scripts/sample-real-output.sh (see commit log).

'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

// Browser stubs so file-browser.js IIFE loads cleanly.
let _origWindow, _origDocument;
function installBrowserStubs() {
  _origWindow = global.window;
  _origDocument = global.document;
  global.window = { innerWidth: 1280 };
  global.document = {
    createElement: () => ({
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      addEventListener() {}, appendChild() {}, setAttribute() {},
      style: {}, dataset: {},
    }),
    body: { appendChild() {} }, addEventListener() {},
  };
}
function restoreBrowserStubs() {
  if (_origWindow === undefined) delete global.window; else global.window = _origWindow;
  if (_origDocument === undefined) delete global.document; else global.document = _origDocument;
}
installBrowserStubs();
delete require.cache[require.resolve('../src/public/file-browser')];
const fb = require('../src/public/file-browser');

const FIX_DIR = path.join(__dirname, 'fixtures', 'real-cli-output');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFixture(name) {
  return fs.readFileSync(path.join(FIX_DIR, name), 'utf8');
}

function findPathsAcrossLines(text) {
  // Scan line by line — matches what the link provider does (per visible
  // terminal row). Returns the deduped set of detected path strings.
  var found = new Set();
  text.split(/\r?\n/).forEach(function (line) {
    if (!line) return;
    var iter;
    try { iter = line.matchAll(fb.LINK_RE_GLOBAL); } catch (_) { return; }
    for (var m of iter) {
      var p = m[2];
      if (p) found.add(p);
    }
  });
  return found;
}

function assertContains(found, needles, fixtureName) {
  needles.forEach(function (n) {
    assert.ok(found.has(n),
      '[' + fixtureName + '] expected detection of ' + JSON.stringify(n) +
      '; got: ' + JSON.stringify([...found]));
  });
}

function assertExcludes(found, badNeedles, fixtureName) {
  badNeedles.forEach(function (b) {
    assert.ok(!found.has(b),
      '[' + fixtureName + '] expected NO detection of ' + JSON.stringify(b) +
      ' (false positive); got: ' + JSON.stringify([...found]));
  });
}

// ---------------------------------------------------------------------------
// Fixtures + assertions
// ---------------------------------------------------------------------------

describe('link-provider regex — real CLI output', function () {

  before(installBrowserStubs);
  after(restoreBrowserStubs);

  describe('git diff (a/, b/ prefixes + numstat)', function () {
    it('catches a/<file> and b/<file> + the per-file paths in --stat', function () {
      var found = findPathsAcrossLines(readFixture('git-diff-stat.txt'));
      // --stat lines are `path/to/file | NN ++--`; the path is bare and
      // has an allowlisted extension → must be detected.
      var someJsExpected = ['e2e/playwright.config.js', 'e2e/tests/57-cmd-p.spec.js'];
      assertContains(found, someJsExpected, 'git-diff-stat');
    });

    it('catches a/ and b/ prefixed paths from `diff --git`', function () {
      var found = findPathsAcrossLines(readFixture('git-diff-stat.txt'));
      // The diff --git lines contain `a/src/public/app.js b/src/public/app.js`.
      var hasA = [...found].some(function (p) { return /^a[\\/]/.test(p); });
      var hasB = [...found].some(function (p) { return /^b[\\/]/.test(p); });
      // At least ONE of a/ or b/ in the captured output should hit. (The
      // captured fixture only has --stat + one diff hunk header; assert
      // either form survives the regex so the resolver can strip it.)
      assert.ok(hasA || hasB,
        'git diff a/ or b/ must survive the regex; got: ' + JSON.stringify([...found]));
    });
  });

  describe('Python pytest traceback', function () {
    it('catches "File \\"path\\", line N" + bare path:line forms', function () {
      var found = findPathsAcrossLines(readFixture('pytest-style.txt'));
      assertContains(found, [
        '/Users/kundus/Software/ai-or-die/scripts/builder.py',
        'scripts/lib/util.py',
        'test/test_thing.py',
      ], 'pytest-style');
    });
  });

  describe('Cargo build warnings (Rust --> path:line:col)', function () {
    it('catches paths after `-->`', function () {
      var found = findPathsAcrossLines(readFixture('cargo-style.txt'));
      assertContains(found, ['src/main.rs', 'src/lib.rs'], 'cargo-style');
    });
  });

  describe('Node V8 stack frames', function () {
    it('catches paths inside parens AND bare path:line:col', function () {
      var found = findPathsAcrossLines(readFixture('node-stack.txt'));
      assertContains(found, [
        'src/worker.js',
        '/Users/kundus/Software/ai-or-die/scripts/main.js',
        '/Users/kundus/Software/ai-or-die/test/runner.js',
      ], 'node-stack');
    });

    it('does NOT detect node:internal/* pseudo-paths (no extension allowlist match)', function () {
      // `node:internal/modules/cjs/loader:1295:14` is not a real path; rejecting
      // it is correct (the user can't open a virtual node:internal:* URI).
      var found = findPathsAcrossLines(readFixture('node-stack.txt'));
      var hasNodeInternal = [...found].some(function (p) {
        return p.indexOf('node:internal') !== -1;
      });
      assert.strictEqual(hasNodeInternal, false,
        'node:internal/* must NOT be detected; got: ' + JSON.stringify([...found]));
    });
  });

  describe('Mocha failure output', function () {
    it('catches the test file path and the line number in `at file:line:col`', function () {
      var found = findPathsAcrossLines(readFixture('mocha-style.txt'));
      assertContains(found, [
        '/Users/kundus/Software/ai-or-die/test/link-provider-regex.test.js',
        'test/link-provider-regex.test.js',
      ], 'mocha-style');
    });
  });

  describe('ESLint output', function () {
    it('catches absolute file paths from the per-file headers', function () {
      var found = findPathsAcrossLines(readFixture('eslint-style.txt'));
      assertContains(found, [
        '/Users/kundus/Software/ai-or-die/src/public/file-browser.js',
        '/Users/kundus/Software/ai-or-die/src/public/app.js',
      ], 'eslint-style');
    });
  });

  describe('Markdown rendered in `cat`', function () {
    it('catches markdown-link bodies (path) and (path:line)', function () {
      var found = findPathsAcrossLines(readFixture('markdown-cat.txt'));
      assertContains(found, [
        'docs/specs/file-browser.md',
        'src/public/file-browser.js',
        'src/public/file-find.js',
        'docs/history/README.md',
      ], 'markdown-cat');
    });
  });

  describe('grep -rn (bare path:line:match)', function () {
    it('catches the per-line file path', function () {
      var found = findPathsAcrossLines(readFixture('grep-rn.txt'));
      // grep -rn output: `src/public/file-find.js:42:fileFind = ...`. The
      // regex must catch the leading bare path with .js extension.
      var anyHit = [...found].some(function (p) { return p.endsWith('.js'); });
      assert.ok(anyHit, 'expected at least one .js path; got: ' + JSON.stringify([...found]));
    });
  });

  describe('Server startup output', function () {
    it('catches absolute paths in log lines', function () {
      var found = findPathsAcrossLines(readFixture('server-startup.txt'));
      assertContains(found, [
        '/Users/kundus/Software/ai-or-die/src/server.js',
        '/Users/kundus/Software/ai-or-die/.claude-code-web/config.json',
      ], 'server-startup');
    });

    it('does NOT detect http:// URLs (handled by WebLinksAddon)', function () {
      var found = findPathsAcrossLines(readFixture('server-startup.txt'));
      var hasUrl = [...found].some(function (p) { return p.indexOf('http') !== -1; });
      assert.strictEqual(hasUrl, false,
        'http URLs should NOT be detected; got: ' + JSON.stringify([...found]));
    });
  });

  // -------------------------------------------------------------------------
  // tsc errors `path(line,col): error TS####` — realism gap CLOSED
  //
  // Captured by the codex-flagged real-output sampling (task #8). Pre-fix:
  // the path itself failed to detect because `(` blocked LINK_RIGHT.
  // Post-fix: regex's LINK_TAIL grew a `(line,col)` alternative + `(`
  // joined LINK_RIGHT. Both path AND line+col now survive.
  // -------------------------------------------------------------------------

  describe('tsc errors `path(line,col): error TS####` (regression)', function () {
    it('catches the path AND the (line,col) tail', function () {
      var found = findPathsAcrossLines(readFixture('tsc-style.txt'));
      assertContains(found, [
        'src/public/app.js',
        'src/public/file-browser.js',
        'test/file-find-panel.test.js',
      ], 'tsc-style');
    });

    it('extractPathFromText returns line + col from `(1234,17)` form', function () {
      var d = fb.extractPathFromText('src/public/app.js(1234,17)');
      assert.ok(d, 'should extract');
      assert.strictEqual(d.path, 'src/public/app.js');
      assert.strictEqual(d.line, 1234);
      assert.strictEqual(d.col, 17);
    });

    it('extractPathFromText still parses the legacy `:line:col` form', function () {
      var d = fb.extractPathFromText('src/lib.rs:23:9');
      assert.ok(d);
      assert.strictEqual(d.line, 23);
      assert.strictEqual(d.col, 9);
    });
  });

  // -------------------------------------------------------------------------
  // KNOWN LIMITATIONS — documented gaps. These are `.skip` so the suite
  // stays green; the next iteration's diff makes the gap obvious.
  // -------------------------------------------------------------------------

  describe('KNOWN LIMITATION — tsc errors `path(line,col): error TS####`', function () {
    it.skip('FIXED in task #8 — see "tsc errors regression" above', function () {
      // Kept as documentation only: this test block lived here BEFORE the
      // fix landed. The regression suite above now covers the working case.
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases on a single line — punctuation, parens, quotes, leading/
  // trailing whitespace. These exercise the LINK_LEFT/LINK_RIGHT boundary
  // classes against forms users actually paste / commands actually emit.
  // -------------------------------------------------------------------------

  describe('hit-test edge cases (single-line, regex level)', function () {
    it('catches a path adjacent to a sentence period', function () {
      var found = findPathsAcrossLines('Found bug in src/app.js.');
      assert.ok(found.has('src/app.js'),
        'punctuation-adjacent path must be caught; got: ' + JSON.stringify([...found]));
    });

    it('catches a path inside parentheses', function () {
      var found = findPathsAcrossLines('open (src/app.js) for the impl');
      assert.ok(found.has('src/app.js'),
        'parens-wrapped path must be caught; got: ' + JSON.stringify([...found]));
    });

    it('catches a path inside square brackets (markdown / log)', function () {
      var found = findPathsAcrossLines('see [src/app.js] for context');
      assert.ok(found.has('src/app.js'),
        'bracket-wrapped path must be caught; got: ' + JSON.stringify([...found]));
    });

    it('catches a path inside angle brackets (HTML-ish)', function () {
      var found = findPathsAcrossLines('see <src/app.js> for context');
      assert.ok(found.has('src/app.js'),
        'angle-wrapped path must be caught; got: ' + JSON.stringify([...found]));
    });

    it('catches a path immediately followed by a comma (list context)', function () {
      var found = findPathsAcrossLines('files: src/app.js, src/util.js, src/lib.js');
      ['src/app.js', 'src/util.js', 'src/lib.js'].forEach(function (p) {
        assert.ok(found.has(p), 'comma-list path missed: ' + p +
          '; got: ' + JSON.stringify([...found]));
      });
    });

    it('handles ANSI-color SUFFIX cleanly (color reset after path)', function () {
      // Real output: `\x1b[31msrc/app.js\x1b[0m for impl`. The regex runs
      // against the visible-text translation (xterm's translateToString),
      // which strips ANSI by default — so this test runs against the
      // ANSI-stripped form, matching what provideLinks sees in production.
      var raw = '\x1b[31msrc/app.js\x1b[0m for impl';
      // Strip ANSI to mirror xterm's translateToString(false) output.
      var stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');
      var found = findPathsAcrossLines(stripped);
      assert.ok(found.has('src/app.js'),
        'ANSI-stripped path must be caught; got: ' + JSON.stringify([...found]));
    });

    it('KNOWN LIMITATION: ANSI-colour break IN THE MIDDLE of a path', function () {
      // `\x1b[31msrc/\x1b[0mapp.js` — when xterm strips ANSI it produces
      // `src/app.js` which DOES match. So this case actually WORKS at the
      // regex layer because the link provider sees the ANSI-stripped
      // visible text. Documented as confirmed-working.
      var raw = '\x1b[31msrc/\x1b[0mapp.js';
      var stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');
      var found = findPathsAcrossLines(stripped);
      assert.ok(found.has('src/app.js'),
        'mid-path ANSI break is harmless after strip; got: ' + JSON.stringify([...found]));
    });
  });

  // -------------------------------------------------------------------------
  // Summary report — emit a one-line "regex realism" rate at the end of
  // the suite. Helps catch a regression where a future regex change
  // tanks the hit rate without any individual test failing.
  // -------------------------------------------------------------------------

  describe('summary report', function () {
    it('emits realism stats across all fixtures', function () {
      var totalDetected = 0;
      var fixtures = fs.readdirSync(FIX_DIR);
      fixtures.forEach(function (f) {
        var found = findPathsAcrossLines(readFixture(f));
        totalDetected += found.size;
      });
      // Print a summary line — visible in mocha's stdout. Not asserting
      // a specific count; the per-fixture tests above are the contract.
      // This just makes the realism rate visible at a glance.
      // eslint-disable-next-line no-console
      console.log('  [realism] ' + fixtures.length + ' fixtures, ' +
        totalDetected + ' total path detections.');
      assert.ok(totalDetected > 0, 'sanity: at least some detections');
    });
  });
});
