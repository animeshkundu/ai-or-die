'use strict';

// Mesh sidecar auto-refresh: newer Tailscale client builds are picked up from
// the mesh-* releases, manifest-verified, swapped atomically, and reconnected
// — with a one-shot rollback to the previous binary on failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { MeshManager } = require('../src/mesh-manager');
const installer = require('../src/utils/sidecar-installer');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-refresh-'));
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Manager with a stubbed installer backend + stubbed lifecycle, backed by a
// real temp sidecar file so the atomic renames are exercised for real.
function refreshManager(dir, opts = {}) {
  const sidecar = path.join(dir, 'bin', 'ai-or-die-mesh');
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, opts.oldBytes || 'old-binary');
  const state = { stops: 0, spawns: 0, spawnMode: opts.spawnMode || 'healthy' };
  const stubInstaller = {
    loadProvenance: () => ({ ref: 'mesh-old', contentHash: 'old', sha256: 'x' }),
    loadLock: () => ({ contentHash: 'old', assets: {} }),
    listMeshReleases: async () => [{ tag: 'mesh-new', publishedAt: '2026-10-14T00:00:00Z' }],
    fetchSidecarRef: async (tag, tmp) => {
      if (opts.fetchFails) {
        const e = new Error('checksum mismatch');
        e.code = 'checksum-mismatch';
        throw e;
      }
      fs.writeFileSync(tmp, opts.newBytes || 'new-binary');
      return { path: tmp, sha256: 'y', ref: tag };
    },
    writeProvenance: () => {},
  };
  const m = new MeshManager({
    stateDir: path.join(dir, 'ts-state'),
    sidecar,
    _installer: stubInstaller,
    refreshIntervalMs: 50,
    _fetch: async () => { throw new Error('no network in tests'); },
  });
  m._appBase = dir;
  // Mirror the stop() contract: stopping=true, one stop generation, proc gone.
  m.stop = async () => {
    state.stops += 1;
    m.stopping = true;
    m._stopCount = (m._stopCount || 0) + 1;
    m.proc = null;
    m.dnsName = null;
  };
  m._spawn = async () => {
    state.spawns += 1;
    if (state.spawnMode === 'dead') { m.proc = null; m.dnsName = null; return; }
    m.proc = {};
    if (state.spawnMode === 'nouserl') { m.dnsName = null; return; }
    m.dnsName = 'h.tail.ts.net';
    m.scheme = 'https';
  };
  return { m, dir, sidecar, state };
}

describe('mesh auto-refresh', function () {
  it('parses MESH-VERSION and ignores malformed lines', function () {
    const m = new MeshManager({ refreshIntervalMs: 50 });
    try {
      m._handleStdoutLine('MESH-VERSION v1.104.1 deadbeef');
      assert.strictEqual(m.tsVersion, 'v1.104.1');
      assert.strictEqual(m.sidecarHash, 'deadbeef');
      m._handleStdoutLine('MESH-VERSION garbage');
      assert.strictEqual(m.tsVersion, 'v1.104.1', 'malformed line keeps last-good');
    } finally {
      m._stopRefreshLoop();
    }
  });

  it('no-ops when the newest release matches provenance', async function () {
    const { m, dir } = refreshManager(sandbox());
    try {
      m._installer.listMeshReleases = async () => [{ tag: 'mesh-old', publishedAt: 'x' }];
      const r = await m._refreshTick();
      assert.deepStrictEqual(r, { checked: true, update: false });
    } finally {
      m._stopRefreshLoop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('swaps + reconnects on a newer build, keeping .prev', async function () {
    const { m, dir, sidecar, state } = refreshManager(sandbox());
    try {
      const r = await m._refreshTick();
      assert.strictEqual(r.refreshed, true);
      assert.strictEqual(r.tag, 'mesh-new');
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), 'new-binary');
      assert.strictEqual(fs.readFileSync(`${sidecar}.prev`, 'utf8'), 'old-binary');
      assert.strictEqual(m.sidecarRef, 'mesh-new');
      assert.ok(state.stops >= 1 && state.spawns >= 1, 'stop then respawn');
      assert.strictEqual(m.dnsName, 'h.tail.ts.net', 'reconnected');
    } finally {
      m._stopRefreshLoop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the running build when download/verify fails', async function () {
    const { m, dir, sidecar } = refreshManager(sandbox(), { fetchFails: true });
    try {
      m.proc = { fake: true };
      const r = await m._refreshTick();
      assert.strictEqual(r.refreshed, false);
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), 'old-binary');
      assert.ok(!fs.existsSync(`${sidecar}.prev`), 'no backup on failed fetch');
    } finally {
      m._stopRefreshLoop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back to .prev when the new build never comes up, then latches off', async function () {
    const { m, dir, sidecar } = refreshManager(sandbox(), { spawnMode: 'dead' });
    try {
      const r = await m._refreshTick();
      assert.strictEqual(r.refreshed, false);
      assert.strictEqual(r.reason, 'rolled_back');
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), 'old-binary', 'previous restored');
      assert.strictEqual(m._refreshDisabled, true, 'latched off so we never flap');
      const r2 = await m._refreshTick();
      assert.strictEqual(r2, null, 'latched: no further checks');
    } finally {
      m._stopRefreshLoop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a live-but-URL-less child alone (no false rollback)', async function () {
    const { m, dir, sidecar } = refreshManager(sandbox(), { spawnMode: 'nouserl' });
    try {
      const r = await m._refreshTick();
      assert.strictEqual(r.refreshed, true);
      assert.strictEqual(r.reconnecting, true);
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), 'new-binary');
      assert.strictEqual(m._refreshDisabled, false);
    } finally {
      m._stopRefreshLoop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NEEDLOGIN-then-exit after swap rolls back (dead child + no URL)', async function () {
    const { m, dir, sidecar } = refreshManager(sandbox(), { spawnMode: 'dead' });
    try {
      // The new binary printed NEEDLOGIN (key did not carry over) then exited.
      m._handleStdoutLine('MESH-NEEDLOGIN https://login.tailscale.com/admin/settings/keys');
      const r = await m._refreshTick();
      assert.strictEqual(r.refreshed, false);
      assert.strictEqual(r.reason, 'rolled_back');
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), 'old-binary');
    } finally {
      m._stopRefreshLoop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an operator stop during download wins (no resurrect)', async function () {
    const { m, dir, sidecar, state } = refreshManager(sandbox());
    try {
      const spawnsBefore = state.spawns;
      m._installer.fetchSidecarRef = async (tag, tmp) => {
        m.stopping = true; // operator hit stop() mid-download
        m._stopCount = (m._stopCount || 0) + 1;
        m.proc = null;
        fs.writeFileSync(tmp, 'new-binary');
        return { path: tmp, sha256: 'y', ref: tag };
      };
      const r = await m._refreshTick();
      assert.strictEqual(r.refreshed, false);
      assert.strictEqual(r.reason, 'stopped');
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), 'old-binary', 'no swap');
      assert.strictEqual(state.spawns, spawnsBefore, 'no respawn against intent');
      assert.strictEqual(m.stopping, true, 'left stopped');
      assert.strictEqual(m._refreshTimer, null, 'loop not re-armed');
    } finally {
      m._stopRefreshLoop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('_shouldAutoRestart stands down under the refresh hold', function () {
    const m = new MeshManager({ refreshIntervalMs: 50 });
    try {
      assert.strictEqual(m._shouldAutoRestart(), true);
      m._refreshHold = true;
      assert.strictEqual(m._shouldAutoRestart(), false);
    } finally {
      m._stopRefreshLoop();
    }
  });

  it('_restart never double-spawns over a live proc', async function () {
    const m = new MeshManager({ refreshIntervalMs: 50 });
    try {
      m.proc = { live: true };
      let spawned = false;
      m._spawn = async () => { spawned = true; };
      await m._restart();
      assert.strictEqual(spawned, false, 'live proc blocks a stale restart');
    } finally {
      m._stopRefreshLoop();
    }
  });

  it('_currentSidecarRef verifies bytes against the shipped lock', function () {
    const dir = sandbox();
    try {
      const sidecar = path.join(dir, 'bin', 'ai-or-die-mesh');
      fs.mkdirSync(path.dirname(sidecar), { recursive: true });
      const bytes = 'exact-shipped-bytes';
      fs.writeFileSync(sidecar, bytes);
      const lock = {
        contentHash: 'shippedhash',
        assets: { [installer.assetName()]: sha256(bytes) },
      };
      const m = new MeshManager({
        stateDir: path.join(dir, 'ts-state'),
        sidecar,
        refreshIntervalMs: 50,
        _installer: {
          loadProvenance: () => null,
          loadLock: () => lock,
        },
      });
      m._appBase = dir;
      assert.strictEqual(m._currentSidecarRef(), 'mesh-shippedhash');
      fs.writeFileSync(sidecar, 'unknown-bytes');
      const m2 = new MeshManager({
        stateDir: path.join(dir, 'ts-state'),
        sidecar,
        refreshIntervalMs: 50,
        _installer: {
          loadProvenance: () => null,
          loadLock: () => lock,
        },
      });
      m2._appBase = dir;
      assert.strictEqual(m2._currentSidecarRef(), null, 'unverified bytes force a check');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips entirely under a dev ref override or opt-out', async function () {
    const { m, dir } = refreshManager(sandbox());
    try {
      process.env.AIORDIE_MESH_REF = 'mesh-dev';
      let fetched = false;
      m._installer.listMeshReleases = async () => { fetched = true; return []; };
      const r = await m._refreshTick();
      assert.strictEqual(r, null);
      assert.strictEqual(fetched, false, 'no network under override');
    } finally {
      delete process.env.AIORDIE_MESH_REF;
      m._stopRefreshLoop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const m2 = new MeshManager({ refreshIntervalMs: 50, noRefresh: true });
    try {
      m2._startRefreshLoop();
      assert.strictEqual(m2._refreshTimer, null, 'no timer when opted out');
    } finally {
      m2._stopRefreshLoop();
    }
  });
});

describe('sidecar-installer refresh helpers', function () {
  it('parseChecksums handles sha256sum lines, stars, comments', function () {
    const text = [
      '# manifest',
      '',
      `${'a'.repeat(64)}  ai-or-die-mesh-linux-amd64`,
      `${'b'.repeat(64)} *ai-or-die-mesh-windows-amd64.exe`,
      'not-a-line',
    ].join('\n');
    const out = installer.parseChecksums(text);
    assert.strictEqual(out['ai-or-die-mesh-linux-amd64'], 'a'.repeat(64));
    assert.strictEqual(out['ai-or-die-mesh-windows-amd64.exe'], 'b'.repeat(64));
    assert.strictEqual(Object.keys(out).length, 2);
  });

  it('fetchSidecarRef rejects a truncated manifest without touching disk', async function () {
    const dir = sandbox();
    try {
      const baby = `${'c'.repeat(64)}  ai-or-die-mesh-linux-amd64\n`;
      const fakeFetch = async (url) => {
        if (String(url).endsWith('ai-or-die-mesh-checksums.txt')) {
          return { ok: true, status: 200, text: async () => baby };
        }
        throw new Error(`unexpected fetch ${url}`);
      };
      await assert.rejects(
        installer.fetchSidecarRef('mesh-abc', path.join(dir, 'x'), { fetch: fakeFetch }),
        /incomplete/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fetchSidecarRef rejects a full-count manifest missing a platform (by NAME)', async function () {
    const dir = sandbox();
    try {
      const asset = installer.assetName();
      // Six entries, victim present — but another expected platform absent.
      // A count check would pass; the name check must fail.
      const lines = [
        `${sha256('x')}  ${asset}`,
        `${'e'.repeat(64)}  filler-1`,
        `${'e'.repeat(64)}  filler-2`,
        `${'e'.repeat(64)}  filler-3`,
        `${'e'.repeat(64)}  filler-4`,
        `${'e'.repeat(64)}  filler-5`,
      ];
      const fakeFetch = async (url) => {
        if (String(url).endsWith('ai-or-die-mesh-checksums.txt')) {
          return { ok: true, status: 200, text: async () => `${lines.join('\n')}\n` };
        }
        throw new Error(`unexpected fetch ${url}`);
      };
      await assert.rejects(
        installer.fetchSidecarRef('mesh-abc', path.join(dir, 'x'), { fetch: fakeFetch }),
        /incomplete/
      );
      assert.ok(!fs.existsSync(path.join(dir, 'x')), 'nothing staged');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fetchSidecarRef verifies bytes against the manifest', async function () {
    const dir = sandbox();
    try {
      const { ASSET_NAMES } = require('../scripts/mesh-lock');
      const asset = installer.assetName();
      const good = 'real-bytes';
      const lines = ASSET_NAMES.map((n) => `${n === asset ? sha256(good) : 'd'.repeat(64)}  ${n}`);
      const fakeFetch = async (url) => {
        if (String(url).endsWith('ai-or-die-mesh-checksums.txt')) {
          return { ok: true, status: 200, text: async () => `${lines.join('\n')}\n` };
        }
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => {
              let sent = false;
              return {
                read: async () => {
                  if (sent) return { done: true, value: undefined };
                  sent = true;
                  return { done: false, value: Buffer.from('tampered-bytes') };
                },
              };
            },
          },
        };
      };
      await assert.rejects(
        installer.fetchSidecarRef('mesh-abc', path.join(dir, 'x'), { fetch: fakeFetch }),
        /checksum mismatch/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ensureSidecar backfills provenance on the valid fast path', async function () {
    const dir = sandbox();
    try {
      const dest = path.join(dir, 'bin', 'ai-or-die-mesh');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const bytes = 'pinned-bytes';
      fs.writeFileSync(dest, bytes);
      const lock = { contentHash: 'hash1', assets: { [installer.assetName()]: sha256(bytes) } };
      const got = await installer.ensureSidecar(dest, { lock });
      assert.strictEqual(got, dest);
      const prov = installer.loadProvenance(dest);
      assert.ok(prov, 'provenance written');
      assert.strictEqual(prov.sha256, sha256(bytes));
      assert.strictEqual(prov.contentHash, 'hash1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
