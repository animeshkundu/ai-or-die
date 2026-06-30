'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const installer = require('../src/utils/sidecar-installer');

const { ensureSidecar, sidecarPath, assetName, SidecarError } = installer;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Build a lock whose checksum matches `bytes` for THIS platform's asset.
function lockFor(bytes) {
  const name = assetName();
  return { version: '9.9.9', contentHash: 'deadbeef', assets: { [name]: sha256(bytes) } };
}

// Minimal fetch Response stub with a web ReadableStream body.
function okResponse(bytes) {
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let sent = false;
        return {
          read() {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value: new Uint8Array(bytes) });
          },
        };
      },
    },
  };
}

describe('sidecar-installer', function () {
  let tmpDir, dest, origFetch;
  const BYTES = Buffer.from('fake-sidecar-binary-contents');

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiordie-sidecar-'));
    dest = path.join(tmpDir, `aiordie-mesh${process.platform === 'win32' ? '.exe' : ''}`);
    origFetch = global.fetch;
  });
  afterEach(function () {
    global.fetch = origFetch;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  describe('assetName', function () {
    it('maps the current platform/arch to an asset name', function () {
      const n = assetName();
      if (process.platform === 'win32') assert.ok(/^aiordie-mesh-windows-(amd64|arm64)\.exe$/.test(n), n);
      else if (process.platform === 'darwin') assert.ok(/^aiordie-mesh-darwin-(amd64|arm64)$/.test(n), n);
      else if (process.platform === 'linux') assert.ok(/^aiordie-mesh-linux-(amd64|arm64)$/.test(n), n);
    });
  });

  describe('sidecarPath', function () {
    it('embeds the content hash so installs never collide / overwrite a running exe', function () {
      const p = sidecarPath('abc123');
      assert.ok(p.includes('abc123'), p);
      assert.ok(/aiordie-mesh-abc123(\.exe)?$/.test(p), p);
      assert.ok(p.includes(path.join('ai-or-die', 'bin')) || p.includes(path.join('.ai-or-die', 'bin')), p);
    });
  });

  describe('ensureSidecar', function () {
    it('downloads + verifies against the embedded checksum, writes the dest', async function () {
      global.fetch = async () => okResponse(BYTES);
      const lock = lockFor(BYTES);
      const out = await ensureSidecar(dest, { lock });
      assert.strictEqual(out, dest);
      assert.ok(fs.existsSync(dest));
      assert.strictEqual(sha256(fs.readFileSync(dest)), lock.assets[assetName()]);
    });

    it('fetches from the content-addressed mesh-<hash> release', async function () {
      let requestedUrl = null;
      global.fetch = async (url) => { requestedUrl = url; return okResponse(BYTES); };
      await ensureSidecar(dest, { lock: { ...lockFor(BYTES), contentHash: 'abc123' } });
      assert.ok(/\/releases\/download\/mesh-abc123\//.test(requestedUrl), requestedUrl);
      assert.ok(requestedUrl.endsWith(assetName()), requestedUrl);
    });

    it('rejects a checksum mismatch and leaves no dest behind', async function () {
      global.fetch = async () => okResponse(BYTES);
      const lock = lockFor(Buffer.from('different-bytes')); // wrong hash
      await assert.rejects(ensureSidecar(dest, { lock }), (e) => e instanceof SidecarError && e.code === 'checksum-mismatch');
      assert.ok(!fs.existsSync(dest), 'dest must not exist after a mismatch');
    });

    it('maps a 404 to assets-missing', async function () {
      global.fetch = async () => ({ ok: false, status: 404, body: null });
      await assert.rejects(ensureSidecar(dest, { lock: lockFor(BYTES) }), (e) => e.code === 'assets-missing');
    });

    it('maps a fetch throw to network', async function () {
      global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
      await assert.rejects(ensureSidecar(dest, { lock: lockFor(BYTES) }), (e) => e.code === 'network');
    });

    it('errors lock-unfinalized when the lock has no checksum for this platform', async function () {
      global.fetch = async () => okResponse(BYTES);
      await assert.rejects(ensureSidecar(dest, { lock: { version: '1', contentHash: 'x', assets: {} } }),
        (e) => e.code === 'lock-unfinalized');
    });

    it('short-circuits when a valid file already exists (no download)', async function () {
      fs.writeFileSync(dest, BYTES);
      let called = false;
      global.fetch = async () => { called = true; return okResponse(BYTES); };
      const out = await ensureSidecar(dest, { lock: lockFor(BYTES) });
      assert.strictEqual(out, dest);
      assert.strictEqual(called, false, 'must not fetch when the existing file matches');
    });

    it('replaces an existing file whose checksum no longer matches', async function () {
      fs.writeFileSync(dest, Buffer.from('stale-old-binary'));
      global.fetch = async () => okResponse(BYTES);
      await ensureSidecar(dest, { lock: lockFor(BYTES) });
      assert.strictEqual(sha256(fs.readFileSync(dest)), sha256(BYTES));
    });

    it('honors the AIORDIE_MESH_REF override for the release tag', async function () {
      const prev = process.env.AIORDIE_MESH_REF;
      process.env.AIORDIE_MESH_REF = 'mesh-overridden';
      let requestedUrl = null;
      global.fetch = async (url) => { requestedUrl = url; return okResponse(BYTES); };
      try {
        await ensureSidecar(dest, { lock: lockFor(BYTES) });
        assert.ok(/\/releases\/download\/mesh-overridden\//.test(requestedUrl), requestedUrl);
      } finally {
        if (prev === undefined) delete process.env.AIORDIE_MESH_REF; else process.env.AIORDIE_MESH_REF = prev;
      }
    });

    it('rejects an AIORDIE_MESH_REF with path traversal', async function () {
      const prev = process.env.AIORDIE_MESH_REF;
      process.env.AIORDIE_MESH_REF = 'mesh-../../evil';
      global.fetch = async () => okResponse(BYTES);
      try {
        await assert.rejects(ensureSidecar(dest, { lock: lockFor(BYTES) }), (e) => e instanceof SidecarError);
      } finally {
        if (prev === undefined) delete process.env.AIORDIE_MESH_REF; else process.env.AIORDIE_MESH_REF = prev;
      }
    });
  });

  describe('SidecarError', function () {
    it('carries a machine-readable code', function () {
      const e = new SidecarError('unsupported-platform', 'x');
      assert.strictEqual(e.code, 'unsupported-platform');
      assert.ok(e instanceof Error);
    });
  });
});
