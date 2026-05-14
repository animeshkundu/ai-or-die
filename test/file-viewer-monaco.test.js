// Tests for src/public/file-viewer-monaco.js — the Monaco AMD loader,
// theme map, language map, and label normalisation. Browser-DOM-bound code
// (loadMonaco, createCodeViewer) is exercised in the Playwright e2e suite;
// these tests cover the deterministic pure-JS surface that runs in Node.

const assert = require('assert');
const monaco = require('../src/public/file-viewer-monaco');

describe('file-viewer-monaco', function () {

  // -------------------------------------------------------------------------
  // Constants & exports
  // -------------------------------------------------------------------------

  describe('exports', function () {
    it('should pin a Monaco version string', function () {
      assert.strictEqual(typeof monaco.MONACO_VERSION, 'string');
      assert.match(monaco.MONACO_VERSION, /^\d+\.\d+\.\d+$/);
    });

    it('should expose a CDN base ending in slash', function () {
      assert.strictEqual(typeof monaco.MONACO_BASE, 'string');
      assert.ok(monaco.MONACO_BASE.startsWith('https://'));
      assert.ok(monaco.MONACO_BASE.endsWith('/'));
      assert.ok(monaco.MONACO_BASE.includes(monaco.MONACO_VERSION));
    });

    it('should expose worker shim path under /vendor/', function () {
      assert.strictEqual(monaco.WORKER_SHIM_PATH, '/vendor/monaco-worker-shim.js');
    });

    it('should expose public API functions', function () {
      assert.strictEqual(typeof monaco.loadMonaco, 'function');
      assert.strictEqual(typeof monaco.createCodeViewer, 'function');
      assert.strictEqual(typeof monaco.renderPlainTextFallback, 'function');
      assert.strictEqual(typeof monaco.getMonacoLanguage, 'function');
      assert.strictEqual(typeof monaco.resolveMonacoTheme, 'function');
      assert.strictEqual(typeof monaco.applyThemeToAll, 'function');
    });
  });

  // -------------------------------------------------------------------------
  // Worker label allowlist — defends the worker shim's ?label= query param
  // from being polluted by future Monaco labels we haven't audited.
  // -------------------------------------------------------------------------

  describe('_normaliseLabel', function () {
    it('should pass through known labels', function () {
      ['editor', 'json', 'css', 'html', 'typescript', 'javascript'].forEach(function (l) {
        assert.strictEqual(monaco._normaliseLabel(l), l, l + ' should pass through');
      });
    });

    it('should fall back to "editor" for unknown labels', function () {
      assert.strictEqual(monaco._normaliseLabel('mystery'), 'editor');
      assert.strictEqual(monaco._normaliseLabel(''), 'editor');
      assert.strictEqual(monaco._normaliseLabel(null), 'editor');
      assert.strictEqual(monaco._normaliseLabel(undefined), 'editor');
    });

    it('should fall back to "editor" for path-traversal-shaped labels', function () {
      assert.strictEqual(monaco._normaliseLabel('../../evil'), 'editor');
      assert.strictEqual(monaco._normaliseLabel('http://attacker'), 'editor');
    });
  });

  // -------------------------------------------------------------------------
  // Language map — Monaco's IDs differ from Ace's at several known points
  // (cpp not c_cpp, go not golang, shell not sh, bat not batchfile, etc.)
  // -------------------------------------------------------------------------

  describe('getMonacoLanguage', function () {
    it('should map common code extensions', function () {
      assert.strictEqual(monaco.getMonacoLanguage('.js'), 'javascript');
      assert.strictEqual(monaco.getMonacoLanguage('.mjs'), 'javascript');
      assert.strictEqual(monaco.getMonacoLanguage('.cjs'), 'javascript');
      assert.strictEqual(monaco.getMonacoLanguage('.jsx'), 'javascript');
      assert.strictEqual(monaco.getMonacoLanguage('.ts'), 'typescript');
      assert.strictEqual(monaco.getMonacoLanguage('.tsx'), 'typescript');
      assert.strictEqual(monaco.getMonacoLanguage('.py'), 'python');
      assert.strictEqual(monaco.getMonacoLanguage('.go'), 'go');     // not 'golang'
      assert.strictEqual(monaco.getMonacoLanguage('.rs'), 'rust');
      assert.strictEqual(monaco.getMonacoLanguage('.cpp'), 'cpp');   // not 'c_cpp'
      assert.strictEqual(monaco.getMonacoLanguage('.h'), 'cpp');
      assert.strictEqual(monaco.getMonacoLanguage('.cs'), 'csharp');
      assert.strictEqual(monaco.getMonacoLanguage('.sh'), 'shell');  // not 'sh'
      assert.strictEqual(monaco.getMonacoLanguage('.ps1'), 'powershell');
      assert.strictEqual(monaco.getMonacoLanguage('.bat'), 'bat');   // not 'batchfile'
    });

    it('should map markup / data extensions', function () {
      assert.strictEqual(monaco.getMonacoLanguage('.md'), 'markdown');
      assert.strictEqual(monaco.getMonacoLanguage('.mdx'), 'markdown');
      assert.strictEqual(monaco.getMonacoLanguage('.json'), 'json');
      assert.strictEqual(monaco.getMonacoLanguage('.json5'), 'json');
      assert.strictEqual(monaco.getMonacoLanguage('.yaml'), 'yaml');
      assert.strictEqual(monaco.getMonacoLanguage('.yml'), 'yaml');
      assert.strictEqual(monaco.getMonacoLanguage('.html'), 'html');
      assert.strictEqual(monaco.getMonacoLanguage('.css'), 'css');
      assert.strictEqual(monaco.getMonacoLanguage('.scss'), 'scss');
      assert.strictEqual(monaco.getMonacoLanguage('.svg'), 'xml');
    });

    it('should be case-insensitive', function () {
      assert.strictEqual(monaco.getMonacoLanguage('.JS'), 'javascript');
      assert.strictEqual(monaco.getMonacoLanguage('.PY'), 'python');
      assert.strictEqual(monaco.getMonacoLanguage('.MD'), 'markdown');
    });

    it('should fall back to plaintext for unknown extensions', function () {
      assert.strictEqual(monaco.getMonacoLanguage('.xyz'), 'plaintext');
      assert.strictEqual(monaco.getMonacoLanguage('.unknown'), 'plaintext');
    });

    it('should return plaintext for empty / null input', function () {
      assert.strictEqual(monaco.getMonacoLanguage(''), 'plaintext');
      assert.strictEqual(monaco.getMonacoLanguage(null), 'plaintext');
      assert.strictEqual(monaco.getMonacoLanguage(undefined), 'plaintext');
    });

    it('should accept a full path, not just an extension', function () {
      assert.strictEqual(monaco.getMonacoLanguage('src/index.js'), 'javascript');
      assert.strictEqual(monaco.getMonacoLanguage('/abs/path/file.py'), 'python');
      assert.strictEqual(monaco.getMonacoLanguage('C:\\Users\\me\\file.cs'), 'csharp');
    });

    it('should map extensionless filenames (Dockerfile, Makefile)', function () {
      assert.strictEqual(monaco.getMonacoLanguage('Dockerfile'), 'dockerfile');
      assert.strictEqual(monaco.getMonacoLanguage('dockerfile'), 'dockerfile');
      assert.strictEqual(monaco.getMonacoLanguage('Makefile'), 'makefile');
      assert.strictEqual(monaco.getMonacoLanguage('makefile'), 'makefile');
      assert.strictEqual(monaco.getMonacoLanguage('GNUmakefile'), 'makefile');
    });
  });

  // -------------------------------------------------------------------------
  // Theme map — every app theme must resolve to a Monaco theme name; the
  // four custom themes must use names beginning with "aod-" so we can
  // identify them later if a theme registration fails.
  // -------------------------------------------------------------------------

  describe('resolveMonacoTheme', function () {
    it('should map midnight + classic-dark to vs-dark', function () {
      assert.strictEqual(monaco.resolveMonacoTheme('midnight'), 'vs-dark');
      assert.strictEqual(monaco.resolveMonacoTheme('classic-dark'), 'vs-dark');
    });

    it('should map classic-light to vs', function () {
      assert.strictEqual(monaco.resolveMonacoTheme('classic-light'), 'vs');
    });

    it('should map monokai/nord/solarized to custom aod- themes', function () {
      assert.strictEqual(monaco.resolveMonacoTheme('monokai'), 'aod-monokai');
      assert.strictEqual(monaco.resolveMonacoTheme('nord'), 'aod-nord');
      assert.strictEqual(monaco.resolveMonacoTheme('solarized-dark'), 'aod-solarized-dark');
      assert.strictEqual(monaco.resolveMonacoTheme('solarized-light'), 'aod-solarized-light');
    });

    it('should fall back to vs-dark for unknown themes', function () {
      assert.strictEqual(monaco.resolveMonacoTheme('mystery'), 'vs-dark');
    });

    it('should cover every theme exposed by the app (no missing entries)', function () {
      // Mirror the app themes documented in tokens.css. If a new theme is
      // added there, this test will fail and force an update here.
      var appThemes = ['midnight', 'classic-dark', 'classic-light', 'monokai',
                       'nord', 'solarized-dark', 'solarized-light'];
      appThemes.forEach(function (t) {
        var resolved = monaco.resolveMonacoTheme(t);
        assert.ok(resolved && resolved !== 'vs-dark' || t === 'midnight' || t === 'classic-dark',
          'theme ' + t + ' must resolve explicitly, not via the unknown-theme fallback');
        assert.ok(['vs', 'vs-dark'].indexOf(resolved) !== -1 ||
                  resolved.indexOf('aod-') === 0,
          'theme ' + t + ' resolved to "' + resolved + '" which is neither built-in nor custom');
      });
    });
  });

  // -------------------------------------------------------------------------
  // CDN base — MUST exactly equal one of the entries in the worker shim's
  // ALLOWED_BASES list. Host-only matching is insufficient: jsdelivr serves
  // /npm/<any-package>/, so a host-only allowlist would let any attacker-
  // published npm package execute as a same-origin Worker. This test reads
  // the worker-shim source directly and parses out ALLOWED_BASES so the
  // two files cannot drift apart.
  // -------------------------------------------------------------------------

  describe('worker shim ALLOWED_BASES alignment', function () {
    var shimSource;
    var allowedBases;

    before(function () {
      var fs = require('fs');
      var path = require('path');
      shimSource = fs.readFileSync(
        path.join(__dirname, '../src/public/vendor/monaco-worker-shim.js'),
        'utf8'
      );
      // Parse the literal array. We deliberately avoid eval — the array is
      // a list of plain string literals; a regex is enough and side-effect-free.
      var match = shimSource.match(/ALLOWED_BASES\s*=\s*\[([\s\S]*?)\]/);
      assert.ok(match, 'monaco-worker-shim.js must define ALLOWED_BASES');
      allowedBases = match[1].split(',')
        .map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); })
        .filter(Boolean);
    });

    it('MONACO_BASE must be present verbatim in the worker shim allowlist', function () {
      assert.ok(allowedBases.indexOf(monaco.MONACO_BASE) !== -1,
        'MONACO_BASE "' + monaco.MONACO_BASE + '" not in shim ALLOWED_BASES; ' +
        'either bump both or fix the drift');
    });

    it('MONACO_BASE must be https', function () {
      var url = new URL(monaco.MONACO_BASE);
      assert.strictEqual(url.protocol, 'https:');
    });

    it('every ALLOWED_BASES entry must end with a trailing slash', function () {
      // The shim normalises trailing slashes on input but not on the
      // allowlist entries themselves; mismatched trailing slashes would
      // cause a silent "everything fails" state.
      allowedBases.forEach(function (b) {
        assert.strictEqual(b.charAt(b.length - 1), '/', b + ' must end with /');
      });
    });

    it('shim must reject host-only-allowlist patterns (path required)', function () {
      // Sanity: ALLOWED_BASES must not be the bare host. The whole point
      // of HIGH-1 was that 'https://cdn.jsdelivr.net/' is too coarse.
      allowedBases.forEach(function (b) {
        var u = new URL(b);
        assert.ok(u.pathname.length > 1,
          b + ' has empty path — that defeats the exact-prefix gate');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Subresource Integrity — MUST be set on the dynamically injected
  // loader.js script tag, mitigates CDN compromise / TLS MITM.
  // -------------------------------------------------------------------------

  describe('Monaco loader SRI', function () {
    it('MONACO_LOADER_INTEGRITY must be a sha384 base64 string', function () {
      assert.strictEqual(typeof monaco.MONACO_LOADER_INTEGRITY, 'string');
      assert.match(monaco.MONACO_LOADER_INTEGRITY,
        /^sha384-[A-Za-z0-9+/]{64}={0,2}$/,
        'MONACO_LOADER_INTEGRITY "' + monaco.MONACO_LOADER_INTEGRITY +
        '" is not a sha384 base64 string');
    });

    it('loader.js script tag must be wired with integrity attribute', function () {
      // Read the source rather than executing — this keeps the test pure
      // Node and side-effect-free.
      var fs = require('fs');
      var path = require('path');
      var src = fs.readFileSync(
        path.join(__dirname, '../src/public/file-viewer-monaco.js'),
        'utf8'
      );
      assert.ok(src.indexOf('s.integrity = MONACO_LOADER_INTEGRITY') !== -1,
        'expected `s.integrity = MONACO_LOADER_INTEGRITY` on the loader.js script tag');
      assert.ok(src.indexOf("s.crossOrigin = 'anonymous'") !== -1,
        'expected `s.crossOrigin = \'anonymous\'` on the loader.js script tag (required for SRI)');
    });
  });
});
