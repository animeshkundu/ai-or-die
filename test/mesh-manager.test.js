const assert = require('assert');
const os = require('os');
const path = require('path');
const { MeshManager } = require('../src/mesh-manager');

describe('MeshManager', function() {
  describe('constructor', function() {
    it('defaults to port 7777, no proc, no name', function() {
      const m = new MeshManager();
      assert.strictEqual(m.port, 7777);
      assert.strictEqual(m.proc, null);
      assert.strictEqual(m.dnsName, null);
      assert.strictEqual(m.stopping, false);
    });

    it('exposes the configured ai-or-die port', function() {
      assert.strictEqual(new MeshManager({ port: 9090 }).port, 9090);
    });

    it('derives a sanitized tailnet hostname', function() {
      assert.ok(/^aiordie-[a-z0-9-]*$/.test(new MeshManager().hostname));
    });

    it('points sidecar + state under the app dir', function() {
      const m = new MeshManager();
      assert.ok(/aiordie-mesh(-[0-9a-f]+)?(\.exe)?$/.test(m.sidecar), m.sidecar);
      assert.ok(m.sidecar.includes(path.join('ai-or-die', 'bin')) || m.sidecar.includes(path.join('.ai-or-die', 'bin')));
      assert.ok(/ts-state$/.test(m.stateDir));
    });

    it('content-addresses the sidecar path from the lock hash', function() {
      const m = new MeshManager();
      // The committed lock has a 64-hex contentHash → the path embeds it.
      assert.ok(/aiordie-mesh-[0-9a-f]{64}(\.exe)?$/.test(m.sidecar), m.sidecar);
    });

    it('defaults the backend to plaintext loopback on the app port', function() {
      assert.strictEqual(new MeshManager({ port: 8080 }).backend, 'http://127.0.0.1:8080');
    });

    it('captures key from env then scrubs it', function() {
      process.env.AIORDIE_TS_AUTHKEY = 'tskey-x';
      const m = new MeshManager();
      assert.strictEqual(m._authKey, 'tskey-x');
      assert.strictEqual(process.env.AIORDIE_TS_AUTHKEY, undefined);
      assert.strictEqual(m._childEnv.AIORDIE_TS_AUTHKEY, undefined);
    });
  });

  describe('getStatus', function() {
    it('not running until a name binds', function() {
      assert.deepStrictEqual(new MeshManager().getStatus(), { running: false, publicUrl: null });
    });
    it('reports https url once up', function() {
      const m = new MeshManager(); m.proc = {}; m.dnsName = 'h.tail.ts.net'; m.scheme = 'https';
      assert.deepStrictEqual(m.getStatus(), { running: true, publicUrl: 'https://h.tail.ts.net' });
    });
    it('reports the http url when the edge degraded (no certs)', function() {
      const m = new MeshManager(); m.proc = {}; m.dnsName = 'h.tail.ts.net'; m.scheme = 'http';
      assert.deepStrictEqual(m.getStatus(), { running: true, publicUrl: 'http://h.tail.ts.net' });
    });
  });

  describe('diagnostics', function() {
    function capture(fn) {
      const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
      try { fn(); } finally { console.log = orig; }
      return lines.join('\n');
    }
    it('_printMissing states the real cause, not "next release build"', function() {
      const out = capture(() => new MeshManager()._printMissing({ code: 'assets-missing', message: 'HTTP 404' }));
      assert.ok(/not published yet/.test(out), out);
      assert.ok(!/next release build/.test(out), out);
    });
    it('_printMissing surfaces a checksum mismatch as a refusal', function() {
      const out = capture(() => new MeshManager()._printMissing({ code: 'checksum-mismatch', message: 'x' }));
      assert.ok(/checksum mismatch/i.test(out) && /refusing/i.test(out), out);
    });
    it('_printMissing falls back to a generic line for an unknown error', function() {
      const out = capture(() => new MeshManager()._printMissing(null));
      assert.ok(/sidecar not installed/i.test(out), out);
    });
    it('_printNoCert points at the tailnet HTTPS-certs toggle', function() {
      const out = capture(() => new MeshManager()._printNoCert());
      assert.ok(/HTTPS Certificates/i.test(out) && /secure context/i.test(out), out);
    });
  });

  describe('enrollment messaging', function() {
    it('prints copy-paste block, no key leak', function() {
      const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
      try { new MeshManager()._printNotEnrolled(); } finally { console.log = orig; }
      const out = lines.join('\n');
      assert.ok(/NOT ENROLLED/.test(out) && /AIORDIE_TS_AUTHKEY/.test(out) && !/tskey-/.test(out));
    });
  });
});
