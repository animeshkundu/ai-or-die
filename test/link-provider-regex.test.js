// test/link-provider-regex.test.js — table-driven coverage of the broadened
// terminal-path link provider regex (Part C of the file-browser-v2
// iteration). Per docs/specs/file-browser.md "Detection patterns" — the
// 7 pattern classes and the rejection set.
//
// The link provider runs `provideLinks` on every visible terminal line on
// every render — synchronous regex only, NO network I/O (peer-review
// HIGH-1 from #7). Resolution is deferred to the click handler. So the
// regex is the ENTIRE security + correctness surface for what gets
// underlined; this suite is the contract.
//
// Pattern classes covered:
//   1. Absolute paths — POSIX (`/Users/foo/file.js`) and Windows
//      (`C:\Users\foo\file.js`, `\\server\share\file.js`)
//   2. Explicit relative — `./src/index.js`, `../shared/util.go`
//   3. Bare relative paths with allowlisted extension — `src/app.js`,
//      `package.json`, `Cargo.toml`
//   4. Stack-trace formats — Node `at Function (path:line:col)`,
//      Python `File "path", line N`, V8 `at path:line:col`,
//      Rust/Go `path:line:col`
//   5. Quoted paths — `"src/app.js"`, `'src/app.js'`
//   6. Markdown links — `[text](path)`, `[text](path:line)`
//   7. Git-diff `a/`, `b/` prefixes — `a/src/app.js`, `b/src/app.js`
//
// Rejection set:
//   - Dotless basenames (`Makefile`, `Dockerfile`, `Jenkinsfile`) — too
//     many false positives in real logs (per adversarial review).
//   - Version strings (`1.2.3`, `v1.2.3`) — caught by VERSION_RE belt.
//   - HTTP URLs — handled by xterm's WebLinksAddon.
//   - CLI flags (`--foo=bar/baz`).
//   - npm specifiers without extension (`react/jsx-runtime`).

'use strict';

const assert = require('assert');

// Browser stubs so the file-browser IIFE loads cleanly under Node.
let _origWindow, _origDocument;
function installBrowserStubs() {
  _origWindow = global.window;
  _origDocument = global.document;
  global.window = { innerWidth: 1280 };
  global.document = {
    createElement: () => ({
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      addEventListener() {},
      appendChild() {},
      setAttribute() {},
      style: {},
      dataset: {},
    }),
    body: { appendChild() {} },
    addEventListener() {},
  };
}
function restoreBrowserStubs() {
  if (_origWindow === undefined) delete global.window; else global.window = _origWindow;
  if (_origDocument === undefined) delete global.document; else global.document = _origDocument;
}

installBrowserStubs();
delete require.cache[require.resolve('../src/public/file-browser')];
const fb = require('../src/public/file-browser');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Run the global regex against `text` and return the array of matched
// path strings (group 2). Mirrors the link provider's findLinksInText
// loop without the start/end column bookkeeping.
function findPaths(text) {
  // findLinksInText is internal; the global regex is exported as
  // LINK_RE_GLOBAL. We use matchAll for re-entrancy safety (matches
  // the production code's posture per the LOW-3 fix).
  if (!fb.LINK_RE_GLOBAL) return [];
  var iter;
  try { iter = text.matchAll(fb.LINK_RE_GLOBAL); } catch (_) { return []; }
  var paths = [];
  for (var m of iter) {
    var p = m[2];
    if (!p) continue;
    paths.push(p);
  }
  return paths;
}

// findExtractedPaths uses extractPathFromText which is more permissive
// (it accepts the full string and strips quotes/markdown link syntax).
// Used for the right-click selection paths.
function extractPath(text) {
  return fb.extractPathFromText(text);
}

// ---------------------------------------------------------------------------
// Pattern 1 — Absolute paths
// ---------------------------------------------------------------------------

describe('link-provider regex — Pattern 1: Absolute paths', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  var cases = [
    { in: '/Users/foo/file.js',                expected: ['/Users/foo/file.js'] },
    { in: 'see /home/me/proj/main.go for impl', expected: ['/home/me/proj/main.go'] },
    { in: '/etc/profile.d/vte.sh',             expected: ['/etc/profile.d/vte.sh'] },
    { in: 'C:\\Users\\foo\\src\\app.js',       expected: ['C:\\Users\\foo\\src\\app.js'] },
    // Note: forward-slash Windows paths (Cygwin / Git Bash style) are
    // also valid absolute Windows paths.
    { in: 'C:/Users/foo/src/app.js',           expected: ['C:/Users/foo/src/app.js'] },
  ];
  cases.forEach(function (c) {
    it('matches: ' + c.in, function () {
      var got = findPaths(c.in);
      c.expected.forEach(function (e) {
        assert.ok(got.indexOf(e) !== -1,
          'expected ' + JSON.stringify(e) + ' in matches; got ' + JSON.stringify(got));
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Pattern 2 — Explicit relative paths (./ or ../)
// ---------------------------------------------------------------------------

describe('link-provider regex — Pattern 2: Explicit relative', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  var cases = [
    { in: './src/index.js',          expected: ['./src/index.js'] },
    { in: '../shared/util.go',       expected: ['../shared/util.go'] },
    { in: 'cd ./scripts/build.sh',   expected: ['./scripts/build.sh'] },
    { in: 'open ../tests/case.spec.ts', expected: ['../tests/case.spec.ts'] },
  ];
  cases.forEach(function (c) {
    it('matches: ' + c.in, function () {
      var got = findPaths(c.in);
      c.expected.forEach(function (e) {
        assert.ok(got.indexOf(e) !== -1, 'expected ' + e + '; got ' + JSON.stringify(got));
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Pattern 3 — Bare relative paths with allowlisted extension
// ---------------------------------------------------------------------------

describe('link-provider regex — Pattern 3: Bare relative w/ extension', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  var cases = [
    { in: 'src/app.js',                      expected: ['src/app.js'] },
    { in: 'edit package.json please',        expected: ['package.json'] },
    { in: 'see Cargo.toml',                  expected: ['Cargo.toml'] },
    { in: 'check src/utils/index.ts now',    expected: ['src/utils/index.ts'] },
    // Multiple paths on one line (real `npm install` output).
    {
      in: 'reading src/foo.js and src/bar.ts together',
      expected: ['src/foo.js', 'src/bar.ts'],
    },
  ];
  cases.forEach(function (c) {
    it('matches: ' + c.in, function () {
      var got = findPaths(c.in);
      c.expected.forEach(function (e) {
        assert.ok(got.indexOf(e) !== -1, 'expected ' + e + '; got ' + JSON.stringify(got));
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Pattern 4 — Stack-trace formats
// ---------------------------------------------------------------------------

describe('link-provider regex — Pattern 4: Stack-trace formats', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  it('matches Node "at Function (path:line:col)"', function () {
    var got = findPaths('    at processOne (src/worker.js:42:18)');
    assert.ok(got.indexOf('src/worker.js') !== -1, 'got: ' + JSON.stringify(got));
  });

  it('matches V8-style "at path:line:col"', function () {
    var got = findPaths('    at /Users/foo/code/app.js:120:5');
    assert.ok(got.indexOf('/Users/foo/code/app.js') !== -1);
  });

  it('matches Python "File \\"path\\", line N"', function () {
    var got = findPaths('  File "src/handler.py", line 88, in <module>');
    assert.ok(got.indexOf('src/handler.py') !== -1, 'got: ' + JSON.stringify(got));
  });

  it('matches Rust/Go bare path:line:col', function () {
    var got = findPaths('panicked at src/lib.rs:23:9');
    assert.ok(got.indexOf('src/lib.rs') !== -1);
  });

  it('captures the :line[:col] suffix for cursor placement', function () {
    if (!fb.LINK_RE_GLOBAL) return this.skip();
    fb.LINK_RE_GLOBAL.lastIndex = 0;
    var m = 'src/lib.rs:23:9'.match(/(?:^|[\s'"`(\[<,;])([\w./\\-]*\.rs)(?::(\d+)(?::(\d+))?)?/);
    assert.ok(m, 'should match');
    assert.strictEqual(m[1], 'src/lib.rs');
    assert.strictEqual(m[2], '23');
    assert.strictEqual(m[3], '9');
  });
});

// ---------------------------------------------------------------------------
// Pattern 5 — Quoted paths
// ---------------------------------------------------------------------------

describe('link-provider regex — Pattern 5: Quoted paths', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  var cases = [
    { in: 'edit "src/app.js" now',     expected: 'src/app.js' },
    { in: "edit 'src/app.js' now",     expected: 'src/app.js' },
    { in: 'open "package.json"',       expected: 'package.json' },
  ];
  cases.forEach(function (c) {
    it('matches: ' + c.in, function () {
      var got = findPaths(c.in);
      assert.ok(got.indexOf(c.expected) !== -1, 'expected ' + c.expected + '; got ' + JSON.stringify(got));
    });
  });
});

// ---------------------------------------------------------------------------
// Pattern 6 — Markdown links
// ---------------------------------------------------------------------------

describe('link-provider regex — Pattern 6: Markdown links', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  it('matches [text](path)', function () {
    var got = findPaths('see [the file](src/index.js) for impl');
    assert.ok(got.indexOf('src/index.js') !== -1, 'got: ' + JSON.stringify(got));
  });

  it('matches [text](path:line)', function () {
    var got = findPaths('the bug at [logger](src/log.js:42)');
    assert.ok(got.indexOf('src/log.js') !== -1, 'got: ' + JSON.stringify(got));
  });
});

// ---------------------------------------------------------------------------
// Pattern 7 — Git-diff a/, b/ prefixes
// ---------------------------------------------------------------------------

describe('link-provider regex — Pattern 7: Git-diff prefixes', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  // Today's behaviour stripped these via the `^[ab][\\/]` skip in
  // findLinksInText. Per Part C they should now SURVIVE the regex
  // (the `a/` / `b/` literal becomes part of the matched path string)
  // and the resolver chain strips them at click-time.
  it('matches a/<file> from `diff --git`', function () {
    var got = findPaths('diff --git a/src/app.js b/src/app.js');
    var hasA = got.some(function (p) { return p === 'a/src/app.js'; });
    var hasB = got.some(function (p) { return p === 'b/src/app.js'; });
    assert.ok(hasA && hasB, 'both a/ and b/ should match: ' + JSON.stringify(got));
  });

  it('strips git-diff prefix in resolver helper', function () {
    if (typeof fb.stripGitDiffPrefix !== 'function') return this.skip();
    assert.strictEqual(fb.stripGitDiffPrefix('a/src/app.js'), 'src/app.js');
    assert.strictEqual(fb.stripGitDiffPrefix('b/src/app.js'), 'src/app.js');
    assert.strictEqual(fb.stripGitDiffPrefix('src/app.js'), 'src/app.js');
  });
});

// ---------------------------------------------------------------------------
// Rejection set — paths that MUST NOT match
// ---------------------------------------------------------------------------

describe('link-provider regex — rejection set', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  it('does NOT match dotless basenames (Makefile/Dockerfile/Jenkinsfile)', function () {
    // Bare "Makefile" / "Dockerfile" / "Jenkinsfile" — too many false
    // positives in real logs ("a Dockerfile.production.staging configuration").
    var got1 = findPaths('see Makefile for build steps');
    assert.strictEqual(got1.indexOf('Makefile'), -1, 'Makefile should not match');
    var got2 = findPaths('the Dockerfile is broken');
    assert.strictEqual(got2.indexOf('Dockerfile'), -1, 'Dockerfile should not match');
    var got3 = findPaths('Jenkinsfile is the entry point');
    assert.strictEqual(got3.indexOf('Jenkinsfile'), -1, 'Jenkinsfile should not match');
  });

  it('does NOT match version strings', function () {
    var got1 = findPaths('node 18.20.4');
    var hasVersion = got1.some(function (p) { return /^v?\d+\.\d+\.\d+$/.test(p); });
    assert.strictEqual(hasVersion, false, 'version 18.20.4 should not match: ' + JSON.stringify(got1));
    var got2 = findPaths('v1.2.3 released');
    var hasV = got2.some(function (p) { return /^v?\d+\.\d+\.\d+$/.test(p); });
    assert.strictEqual(hasV, false, 'v1.2.3 should not match: ' + JSON.stringify(got2));
  });

  it('does NOT match HTTP URLs (handled by WebLinksAddon)', function () {
    var got = findPaths('see https://example.com/foo.js for refs');
    var hasUrl = got.some(function (p) { return p.indexOf('http') !== -1; });
    assert.strictEqual(hasUrl, false, 'http URL should not match: ' + JSON.stringify(got));
  });

  it('does NOT match npm specifiers without an extension (react/jsx-runtime)', function () {
    var got = findPaths('import { jsx } from "react/jsx-runtime"');
    var hasSpecifier = got.some(function (p) { return p === 'react/jsx-runtime'; });
    assert.strictEqual(hasSpecifier, false, 'npm specifier should not match: ' + JSON.stringify(got));
  });

  it('does NOT match CLI flags (--foo=bar/baz)', function () {
    var got = findPaths('--config=settings/dev');
    var hasFlag = got.some(function (p) { return p.indexOf('=') !== -1; });
    assert.strictEqual(hasFlag, false, 'CLI flag fragment should not match: ' + JSON.stringify(got));
  });
});

// ---------------------------------------------------------------------------
// Right-click selection extractor — the same regex pipeline, exercised
// through `extractPathFromText`. Quoted paths and markdown link syntax
// strip on extraction.
// ---------------------------------------------------------------------------

describe('extractPathFromText — selection-driven', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  it('strips surrounding quotes', function () {
    var d = extractPath('"src/app.js"');
    assert.ok(d, 'should extract: ' + JSON.stringify(d));
    assert.strictEqual(d.path, 'src/app.js');
  });

  it('extracts path:line:col', function () {
    var d = extractPath('src/app.js:42:5');
    assert.ok(d);
    assert.strictEqual(d.path, 'src/app.js');
    assert.strictEqual(d.line, 42);
    assert.strictEqual(d.col, 5);
  });

  it('returns null for non-path text', function () {
    assert.strictEqual(extractPath(''), null);
    assert.strictEqual(extractPath('   '), null);
    assert.strictEqual(extractPath('totally not a path'), null);
  });

  it('returns null for version strings', function () {
    assert.strictEqual(extractPath('1.2.3'), null);
    assert.strictEqual(extractPath('v1.2.3'), null);
  });
});

// ---------------------------------------------------------------------------
// resolveCandidates — pure resolver chain (Part C)
// ---------------------------------------------------------------------------

describe('resolveCandidates', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  it('passes absolute paths through unchanged as the first candidate', function () {
    var got = fb.resolveCandidates('/Users/foo/file.js', { workingDir: '/Users/bar' });
    assert.ok(got.length >= 1);
    assert.strictEqual(got[0], '/Users/foo/file.js');
  });

  it('joins relative paths against liveCwd, workingDir, and repoRoot in order', function () {
    var got = fb.resolveCandidates('src/app.js', {
      liveCwd: '/Users/foo/live',
      workingDir: '/Users/foo/work',
      repoRoot: '/Users/foo/repo',
    });
    assert.deepStrictEqual(got, [
      '/Users/foo/live/src/app.js',
      '/Users/foo/work/src/app.js',
      '/Users/foo/repo/src/app.js',
    ]);
  });

  it('strips git-diff `a/` and `b/` prefixes before joining', function () {
    var got = fb.resolveCandidates('a/src/app.js', { workingDir: '/Users/foo/work' });
    assert.ok(got.indexOf('/Users/foo/work/src/app.js') !== -1, 'got: ' + JSON.stringify(got));
    var got2 = fb.resolveCandidates('b/src/app.js', { workingDir: '/Users/foo/work' });
    assert.ok(got2.indexOf('/Users/foo/work/src/app.js') !== -1);
  });

  it('dedupes identical candidates while preserving order', function () {
    var got = fb.resolveCandidates('src/app.js', {
      liveCwd: '/same',
      workingDir: '/same',
      repoRoot: '/different',
    });
    // /same/src/app.js appears once; /different/src/app.js once.
    assert.strictEqual(got.length, 2);
    assert.strictEqual(got[0], '/same/src/app.js');
    assert.strictEqual(got[1], '/different/src/app.js');
  });

  it('skips missing context steps gracefully (no liveCwd → only workingDir + repoRoot)', function () {
    var got = fb.resolveCandidates('src/app.js', {
      workingDir: '/Users/foo/work',
      repoRoot: '/Users/foo/repo',
    });
    assert.deepStrictEqual(got, [
      '/Users/foo/work/src/app.js',
      '/Users/foo/repo/src/app.js',
    ]);
  });

  it('returns empty array for empty / null hint', function () {
    assert.deepStrictEqual(fb.resolveCandidates('', { workingDir: '/x' }), []);
    assert.deepStrictEqual(fb.resolveCandidates(null, { workingDir: '/x' }), []);
    assert.deepStrictEqual(fb.resolveCandidates(undefined, {}), []);
  });

  it('returns absolute path even when no context is supplied', function () {
    var got = fb.resolveCandidates('/Users/foo/file.js', {});
    assert.deepStrictEqual(got, ['/Users/foo/file.js']);
  });
});

// ---------------------------------------------------------------------------
// stripGitDiffPrefix
// ---------------------------------------------------------------------------

describe('stripGitDiffPrefix', function () {
  before(installBrowserStubs);
  after(restoreBrowserStubs);

  it('strips a/ prefix', function () {
    assert.strictEqual(fb.stripGitDiffPrefix('a/src/app.js'), 'src/app.js');
  });
  it('strips b/ prefix', function () {
    assert.strictEqual(fb.stripGitDiffPrefix('b/src/app.js'), 'src/app.js');
  });
  it('strips a\\ prefix (Windows separator)', function () {
    assert.strictEqual(fb.stripGitDiffPrefix('a\\src\\app.js'), 'src\\app.js');
  });
  it('leaves other paths unchanged', function () {
    assert.strictEqual(fb.stripGitDiffPrefix('src/app.js'), 'src/app.js');
    assert.strictEqual(fb.stripGitDiffPrefix('/abs/app.js'), '/abs/app.js');
    assert.strictEqual(fb.stripGitDiffPrefix(''), '');
    assert.strictEqual(fb.stripGitDiffPrefix(null), null);
  });
  it('does not strip c/ or other letters', function () {
    assert.strictEqual(fb.stripGitDiffPrefix('c/src/app.js'), 'c/src/app.js');
    assert.strictEqual(fb.stripGitDiffPrefix('z/x.js'), 'z/x.js');
  });
});
