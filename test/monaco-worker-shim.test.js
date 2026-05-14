// Tests for src/public/vendor/monaco-worker-shim.js — the same-origin
// Web Worker that bootstraps Monaco's worker bundle from a CDN.
//
// Per reviewer (HIGH-1 finding): the host-only allowlist that the original
// shim shipped is insufficient. jsdelivr serves /npm/<any-package>/, so any
// path under cdn.jsdelivr.net could host attacker code. The shim now uses
// an exact-prefix allowlist against the full Monaco vs/ base URL.
//
// These tests evaluate the shim's source in a sandboxed Node `vm` context
// with mocked `self` (location, importScripts, MonacoEnvironment) and
// assert that the gate accepts only the canonical Monaco base URL and
// rejects every credible bypass.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SHIM_SRC = fs.readFileSync(
  path.join(__dirname, '../src/public/vendor/monaco-worker-shim.js'),
  'utf8'
);

// Reach into the shim source the same way the alignment test in
// test/file-viewer-monaco.test.js does — we want the test to break loudly
// if the constant is renamed or the format changes.
function getAllowedBases() {
  const m = SHIM_SRC.match(/ALLOWED_BASES\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('ALLOWED_BASES not found in monaco-worker-shim.js');
  return m[1].split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function runShim(workerHref) {
  const importScriptsCalls = [];
  const importScriptsFn = function (url) { importScriptsCalls.push(url); };
  // In a Web Worker, `self` IS the global object. We make the sandbox itself
  // the global, alias `self` to it, and read MonacoEnvironment back via
  // runInContext so we observe the true post-run sandbox state (mutations
  // through `self` may not always be visible on the original sandbox object
  // reference depending on Node version).
  const sandbox = {
    location: { href: workerHref },
    importScripts: importScriptsFn,
    URL: URL,
  };
  vm.createContext(sandbox);
  // Make `self` resolve to the sandbox global, the way it does in workers.
  // Don't pre-declare MonacoEnvironment — leaving it absent lets us
  // distinguish "shim never set it" (typeof undefined) from "shim set it
  // to undefined" (defensive, shouldn't happen).
  vm.runInContext('var self = globalThis;', sandbox);

  let thrown = null;
  try {
    vm.runInContext(SHIM_SRC, sandbox, { filename: 'monaco-worker-shim.js' });
  } catch (err) {
    thrown = err;
  }
  // Read through the context — substitute null for undefined, and JSON-
  // round-trip so the returned object has THIS context's Object.prototype.
  // Without this, deepStrictEqual rejects cross-context object equality
  // even when structure is identical.
  const monacoEnvJson = vm.runInContext(
    '(typeof self.MonacoEnvironment === "undefined" ? "null" : JSON.stringify(self.MonacoEnvironment))',
    sandbox
  );
  const monacoEnv = JSON.parse(monacoEnvJson);
  return { threw: thrown, importScriptsCalls, monacoEnv: monacoEnv };
}

describe('monaco-worker-shim', function () {

  describe('ALLOWED_BASES (HIGH-1 — exact-prefix allowlist)', function () {
    it('exposes a non-empty ALLOWED_BASES array', function () {
      const a = getAllowedBases();
      assert.ok(a.length > 0, 'ALLOWED_BASES must not be empty');
    });

    it('all entries must be https://cdn.jsdelivr.net/npm/monaco-editor@<v>/min/', function () {
      // The fix's whole premise: the allowlist constrains both host AND
      // path. If a future bump moves Monaco off this exact path shape, this
      // test should fail and force a deliberate update.
      const a = getAllowedBases();
      a.forEach(function (b) {
        assert.match(b,
          /^https:\/\/cdn\.jsdelivr\.net\/npm\/monaco-editor@\d+\.\d+\.\d+\/min\/$/,
          'allowlist entry "' + b + '" does not match Monaco vs/ base shape');
      });
    });
  });

  describe('positive: canonical base loads workerMain.js', function () {
    it('accepts the allowlisted base + sets MonacoEnvironment + importScripts', function () {
      const allowed = getAllowedBases();
      const base = allowed[0];
      const r = runShim('https://app.local/vendor/monaco-worker-shim.js?base=' +
                        encodeURIComponent(base) + '&label=editorWorkerService');
      assert.strictEqual(r.threw, null,
        'shim threw on canonical base: ' + (r.threw && r.threw.message));
      assert.deepStrictEqual(r.monacoEnv, { baseUrl: base },
        'MonacoEnvironment.baseUrl must equal the resolved base');
      assert.deepStrictEqual(r.importScriptsCalls,
        [base + 'vs/base/worker/workerMain.js'],
        'importScripts must be called with exactly one URL — Monaco workerMain at the resolved base');
    });

    it('normalises a base missing its trailing slash', function () {
      const base = getAllowedBases()[0];
      const noSlash = base.replace(/\/$/, '');
      const r = runShim('https://app.local/vendor/monaco-worker-shim.js?base=' +
                        encodeURIComponent(noSlash));
      assert.strictEqual(r.threw, null,
        'shim should add the trailing slash and accept: ' + (r.threw && r.threw.message));
      assert.deepStrictEqual(r.importScriptsCalls,
        [base + 'vs/base/worker/workerMain.js']);
    });
  });

  describe('negative: malformed input', function () {
    function expectFail(desc, base) {
      it(desc, function () {
        const r = runShim('https://app.local/vendor/monaco-worker-shim.js?base=' +
                          (base == null ? '' : encodeURIComponent(base)));
        assert.ok(r.threw, 'shim must throw for: ' + desc);
        assert.strictEqual(r.importScriptsCalls.length, 0,
          'shim must NOT call importScripts for: ' + desc);
        assert.strictEqual(r.monacoEnv, null,
          'shim must NOT set MonacoEnvironment for: ' + desc);
      });
    }

    expectFail('missing base parameter', null);
    expectFail('http (not https)',
      'http://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/');
    expectFail('javascript: URL',
      'javascript:alert(1)//');
    expectFail('data: URL',
      'data:text/javascript;base64,YWxlcnQoMSk=');
    expectFail('blob: URL',
      'blob:https://app.local/abc');
    expectFail('attacker host masquerading via userinfo',
      'https://cdn.jsdelivr.net@evil.com/npm/monaco-editor@0.52.2/min/');
  });

  describe('negative: HIGH-1 — wrong path on allowlisted host (the actual bug)', function () {
    function expectReject(desc, base) {
      it(desc, function () {
        const r = runShim('https://app.local/vendor/monaco-worker-shim.js?base=' +
                          encodeURIComponent(base));
        assert.ok(r.threw, 'shim must reject: ' + desc);
        assert.match(r.threw.message, /not in allowlist/,
          'rejection should cite the allowlist for: ' + desc);
        assert.strictEqual(r.importScriptsCalls.length, 0,
          'shim must NOT call importScripts for: ' + desc);
      });
    }

    // The exact attack class HIGH-1 was about: jsdelivr serves any npm
    // package, so a host-only gate would let attacker-published packages
    // execute as same-origin Workers.
    expectReject('attacker npm package on jsdelivr',
      'https://cdn.jsdelivr.net/npm/evil-pkg@1.0.0/');
    expectReject('attacker subpath on jsdelivr',
      'https://cdn.jsdelivr.net/npm/evil-pkg@1.0.0/min/');
    expectReject('different package, same monaco prefix',
      'https://cdn.jsdelivr.net/npm/monaco-evil@0.52.2/min/');
    expectReject('downgraded Monaco version not in allowlist',
      'https://cdn.jsdelivr.net/npm/monaco-editor@0.20.0/min/');
    expectReject('Monaco at jsdelivr root (not /npm/)',
      'https://cdn.jsdelivr.net/monaco-editor/0.52.2/min/');
    expectReject('cdnjs (host not in our pinned allowlist)',
      'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/');
    expectReject('unpkg (host not in our pinned allowlist)',
      'https://unpkg.com/monaco-editor@0.52.2/min/');
    expectReject('attacker origin entirely',
      'https://attacker.example/npm/monaco-editor@0.52.2/min/');
  });
});
