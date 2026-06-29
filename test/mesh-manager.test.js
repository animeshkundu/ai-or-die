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
      assert.ok(/aiordie-mesh(\.exe)?$/.test(m.sidecar));
      assert.ok(m.sidecar.includes(path.join('ai-or-die', 'bin')) || m.sidecar.includes(path.join('.ai-or-die', 'bin')));
      assert.ok(/ts-state$/.test(m.stateDir));
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
      const m = new MeshManager(); m.proc = {}; m.dnsName = 'h.tail.ts.net';
      assert.deepStrictEqual(m.getStatus(), { running: true, publicUrl: 'https://h.tail.ts.net' });
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
