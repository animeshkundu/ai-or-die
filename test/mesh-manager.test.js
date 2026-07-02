const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const testApi = global.describe ? { describe: global.describe, it: global.it } : require('node:test');
const { describe, it } = testApi;
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
      assert.ok(/ai-or-die-mesh(-[0-9a-f]+)?(\.exe)?$/.test(m.sidecar), m.sidecar);
      assert.ok(m.sidecar.includes(path.join('ai-or-die', 'bin')) || m.sidecar.includes(path.join('.ai-or-die', 'bin')));
      assert.ok(/ts-state$/.test(m.stateDir));
    });

    it('launches a stable, hash-free sidecar path (single-file allow-list match)', function() {
      const m = new MeshManager();
      // The manager LAUNCHES the stable path so a WDAC/AppLocker path rule matches
      // the executed image across versions — no embedded content hash (ADR-0036).
      assert.ok(/[/\\]ai-or-die-mesh(\.exe)?$/.test(m.sidecar), m.sidecar);
      assert.ok(!/-[0-9a-f]{16,}/.test(path.basename(m.sidecar)), m.sidecar);
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

    it('captures the app bearer for the sidecar and scrubs inherited env', function() {
      process.env.AIORDIE_PROXY_BEARER = 'env-token';
      const m = new MeshManager({ authToken: 'app-token' });
      assert.strictEqual(m._proxyBearer, 'app-token');
      assert.strictEqual(process.env.AIORDIE_PROXY_BEARER, undefined);
      assert.strictEqual(m._childEnv.AIORDIE_PROXY_BEARER, undefined);
    });
  });

  describe('getStatus', function() {
    it('not running until a name binds', function() {
      assert.deepStrictEqual(new MeshManager().getStatus(), { running: false, publicUrl: null, peers: [] });
    });
    it('reports https url once up', function() {
      const m = new MeshManager(); m.proc = {}; m.dnsName = 'h.tail.ts.net'; m.scheme = 'https';
      assert.deepStrictEqual(m.getStatus(), { running: true, publicUrl: 'https://h.tail.ts.net', peers: [] });
    });
    it('reports the http url when the edge degraded (no certs)', function() {
      const m = new MeshManager(); m.proc = {}; m.dnsName = 'h.tail.ts.net'; m.scheme = 'http';
      assert.deepStrictEqual(m.getStatus(), { running: true, publicUrl: 'http://h.tail.ts.net', peers: [] });
    });
    it('includes cached mesh peers', function() {
      const m = new MeshManager();
      m.peers = { self: { hostname: 'self', dnsName: 'self.tail' }, peers: [{ hostname: 'p', dnsName: 'p.tail', online: true }] };
      assert.deepStrictEqual(m.getStatus().peers, [{ hostname: 'p', dnsName: 'p.tail', online: true }]);
    });
  });

  describe('peer discovery cache', function() {
    function tempManager() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-manager-'));
      const m = new MeshManager({ stateDir: path.join(dir, 'ts-state'), sidecar: path.join(dir, 'ai-or-die-mesh') });
      m._appBase = dir;
      return { m, dir };
    }

    it('parses MESH-PEERS, caches peers, and writes peers.json atomically', function() {
      const { m, dir } = tempManager();
      try {
        const line = 'MESH-PEERS {"self":{"hostname":"self","dnsName":"self.tail"},"peers":[{"hostname":"p1","dnsName":"p1.tail","online":true},{"hostname":"bad","dnsName":"bad.tail","online":"yes"}]}\n';
        m._handleStdoutData(Buffer.from(line));
        assert.deepStrictEqual(m.peers, {
          self: { hostname: 'self', dnsName: 'self.tail' },
          peers: [{ hostname: 'p1', dnsName: 'p1.tail', online: true }],
        });
        const file = m.peersFilePath();
        const written = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(written.version, 1);
        assert.strictEqual(typeof written.updatedAt, 'number');
        assert.deepStrictEqual(written.self, m.peers.self);
        assert.deepStrictEqual(written.peers, m.peers.peers);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps the last-good peers cache on malformed or oversized MESH-PEERS', function() {
      const { m, dir } = tempManager();
      try {
        m._handleStdoutData(Buffer.from('MESH-PEERS {"self":{"hostname":"self","dnsName":"self.tail"},"peers":[]}\n'));
        const lastGood = m.peers;
        m._handleStdoutData(Buffer.from('MESH-PEERS {not json}\n'));
        assert.strictEqual(m.peers, lastGood);
        m._handleStdoutData(Buffer.from('MESH-PEERS {"self":{"hostname":"self"},"peers":[]}\n'));
        assert.strictEqual(m.peers, lastGood);
        m._handleStdoutData(Buffer.from(`MESH-PEERS ${'x'.repeat(256 * 1024 + 1)}\n`));
        assert.strictEqual(m.peers, lastGood);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('deletes peers.json and clears memory on mesh shutdown markers', function() {
      const { m, dir } = tempManager();
      try {
        m._handleStdoutData(Buffer.from('MESH-PEERS {"self":{"hostname":"self","dnsName":"self.tail"},"peers":[]}\n'));
        assert.ok(fs.existsSync(m.peersFilePath()));
        m._handleStdoutData(Buffer.from('MESH-NEEDLOGIN https://login.tailscale.com/admin/settings/keys\n'), () => {});
        assert.strictEqual(m.peers, null);
        assert.strictEqual(fs.existsSync(m.peersFilePath()), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('mesh egress file', function() {
    function tempManager() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-egress-'));
      const m = new MeshManager({ stateDir: path.join(dir, 'ts-state'), sidecar: path.join(dir, 'ai-or-die-mesh') });
      m._appBase = dir;
      return { m, dir };
    }

    it('writes egress.json (0600, with pid) from a valid loopback MESH-EGRESS line', function() {
      const { m, dir } = tempManager();
      try {
        m.proc = { pid: 4242 };
        m._handleStdoutData(Buffer.from('MESH-EGRESS http://127.0.0.1:54321 deadbeefcafe\n'));
        const file = m.egressFilePath();
        assert.ok(fs.existsSync(file), 'egress.json must be written');
        const written = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(written.version, 1);
        assert.strictEqual(written.pid, 4242);
        assert.strictEqual(written.url, 'http://127.0.0.1:54321');
        assert.strictEqual(written.token, 'deadbeefcafe');
        assert.strictEqual(typeof written.updatedAt, 'number');
        if (process.platform !== 'win32') {
          assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'egress.json must be 0600');
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('rejects a non-http / non-loopback / localhost / token-less egress line', function() {
      const { m, dir } = tempManager();
      try {
        m.proc = { pid: 1 };
        for (const bad of [
          'MESH-EGRESS https://127.0.0.1:5 tok',   // not http
          'MESH-EGRESS http://10.0.0.5:5 tok',     // not loopback
          'MESH-EGRESS http://localhost:5 tok',    // localhost — DNS-rebinding risk
          'MESH-EGRESS http://127.0.0.1:5 ',       // no token (regex needs two fields)
          'MESH-EGRESS notaurl tok',               // unparseable url
        ]) {
          m._handleStdoutData(Buffer.from(bad + '\n'));
          assert.strictEqual(fs.existsSync(m.egressFilePath()), false, `must reject: ${bad}`);
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('deletes egress.json on a MESH-NEEDLOGIN marker', function() {
      const { m, dir } = tempManager();
      try {
        m.proc = { pid: 7 };
        m._handleStdoutData(Buffer.from('MESH-EGRESS http://127.0.0.1:9 tok9\n'));
        assert.ok(fs.existsSync(m.egressFilePath()));
        m._handleStdoutData(Buffer.from('MESH-NEEDLOGIN https://login.tailscale.com/admin/settings/keys\n'), () => {});
        assert.strictEqual(fs.existsSync(m.egressFilePath()), false);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('prints the MESH-UNTAGGED hint exactly once', function() {
      const { m, dir } = tempManager();
      const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
      try {
        m._handleStdoutData(Buffer.from('MESH-UNTAGGED false 3 0\n'));
        m._handleStdoutData(Buffer.from('MESH-UNTAGGED false 3 0\n')); // suppressed (one-shot)
      } finally { console.log = orig; fs.rmSync(dir, { recursive: true, force: true }); }
      const out = lines.join('\n');
      assert.ok(/tag:aiordie/.test(out) && /discovery stays EMPTY/i.test(out), out);
      assert.strictEqual((out.match(/tailnet device\(s\) visible/g) || []).length, 1, 'hint must print once');
    });

    it('caches egress + starts a refresh timer, and clears both on shutdown', function() {
      const { m, dir } = tempManager();
      try {
        m.proc = { pid: 55 };
        m._handleStdoutData(Buffer.from('MESH-EGRESS http://127.0.0.1:5 tok5\n'));
        assert.deepStrictEqual(m._egress, { url: 'http://127.0.0.1:5', token: 'tok5' });
        assert.ok(m._egressRefreshTimer, 'refresh timer must be armed');
        m._handleStdoutData(Buffer.from('MESH-NEEDLOGIN https://login.tailscale.com/admin/settings/keys\n'), () => {});
        assert.strictEqual(m._egress, null);
        assert.strictEqual(m._egressRefreshTimer, null, 'refresh timer must be cleared');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('re-stamps a fresher updatedAt on a refresh tick while the sidecar is alive', function() {
      const { m, dir } = tempManager();
      try {
        m.proc = { pid: 66 };
        m._handleStdoutData(Buffer.from('MESH-EGRESS http://127.0.0.1:6 tok6\n'));
        const first = JSON.parse(fs.readFileSync(m.egressFilePath(), 'utf8')).updatedAt;
        // Force a distinct wall-clock, then tick the refresh directly.
        const realNow = Date.now; let t = first + 1000; Date.now = () => t;
        try { m._refreshEgressTick(); } finally { Date.now = realNow; }
        const second = JSON.parse(fs.readFileSync(m.egressFilePath(), 'utf8'));
        assert.ok(second.updatedAt > first, `updatedAt must advance (${first} -> ${second.updatedAt})`);
        assert.strictEqual(second.url, 'http://127.0.0.1:6');
        assert.strictEqual(second.token, 'tok6');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('a refresh tick after the sidecar exits stops the timer (no dead re-stamp)', function() {
      const { m, dir } = tempManager();
      try {
        m.proc = { pid: 77 };
        m._handleStdoutData(Buffer.from('MESH-EGRESS http://127.0.0.1:7 tok7\n'));
        assert.ok(m._egressRefreshTimer);
        m.proc = null; // sidecar gone
        m._refreshEgressTick();
        assert.strictEqual(m._egressRefreshTimer, null, 'timer must stop once the sidecar is gone');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
