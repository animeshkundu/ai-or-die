'use strict';

// Mesh release-freshness tier (tier 2): newer Tailscale client builds are
// picked up from the mesh-* releases, manifest-verified, staged to .new,
// pre-flighted, and recycled through the shared stage → promote → respawn
// path — with rollback + quarantine on failure.
//
// Tier-1 (lock convergence) coverage lives in test/mesh-manager.test.js;
// installer-level manifest/provenance coverage lives at the bottom of this
// file.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { MeshManager } = require('../src/mesh-manager');
const installer = require('../src/utils/sidecar-installer');
const { ASSET_NAMES } = require('../scripts/mesh-lock');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-refresh-'));
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const OLD_BYTES = 'old-shipped-bytes';
const NEW_BYTES = 'new-release-bytes';
const OLD_CONTENT_HASH = 'oldcontenthash';
const NEW_TAG = 'mesh-newcontenthash';
const NEW_HASH = 'newcontenthash';

// Manifest listing the full matrix, with `assetSha` for this platform's asset.
function manifestFor(assetSha) {
  const name = installer.assetName();
  return `${ASSET_NAMES.map((n) => `${n === name ? assetSha : 'd'.repeat(64)}  ${n}`).join('\n')}\n`;
}

// Stub fetch serving a manifest + asset bytes for the release tier.
function releaseFetch(newBytes) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith('ai-or-die-mesh-checksums.txt')) {
      return { ok: true, status: 200, text: async () => manifestFor(sha256(newBytes)) };
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
              return { done: false, value: Buffer.from(newBytes) };
            },
          };
        },
      },
    };
  };
}

// Manager backed by REAL installer stage/promote/rollback fs logic against a
// temp sidecar, with a stubbed lock (old build) and stubbed child lifecycle.
// The release tier is exercised end-to-end up to the process boundary.
function refreshManager(dir, opts = {}) {
  const sidecar = path.join(dir, 'bin', 'ai-or-die-mesh');
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, opts.oldBytes || OLD_BYTES);
  fs.mkdirSync(path.join(dir, 'ts-state'), { recursive: true });
  const lock = {
    contentHash: OLD_CONTENT_HASH,
    assets: { [installer.assetName()]: sha256(opts.oldBytes || OLD_BYTES) },
  };
  const state = { spawns: 0, spawnMode: opts.spawnMode || 'healthy' };
  const stubInstaller = {
    loadLock: () => lock,
    assetName: installer.assetName,
    sha256File: installer.sha256File,
    stagedSidecarPath: installer.stagedSidecarPath,
    prevSidecarPath: installer.prevSidecarPath,
    loadProvenance: (dest) => installer.loadProvenance(dest || sidecar)
      || { ref: `mesh-${OLD_CONTENT_HASH}`, contentHash: OLD_CONTENT_HASH, sha256: 'x' },
    writeProvenance: (dest, info) => installer.writeProvenance(dest, info),
    stageSidecar: (stable, o) => installer.stageSidecar(stable, { ...(o || {}), lock }),
    promoteStagedSidecar: (stable, o) => installer.promoteStagedSidecar(stable, { ...(o || {}), lock }),
    rollbackSidecar: (stable) => installer.rollbackSidecar(stable),
    listMeshReleases: async () => [{ tag: NEW_TAG, publishedAt: '2026-10-14T00:00:00Z' }],
    fetchSidecarRef: (tag, destPath, o) => installer.fetchSidecarRef(
      tag, destPath, { ...(o || {}), fetch: releaseFetch(NEW_BYTES) }
    ),
  };
  if (opts.fetchFails) {
    const e = new Error('checksum mismatch');
    e.code = 'checksum-mismatch';
    stubInstaller.fetchSidecarRef = async () => { throw e; };
  }
  const m = new MeshManager({
    stateDir: path.join(dir, 'ts-state'),
    sidecar,
    _installer: stubInstaller,
    _updateIntervalMs: 60000,
    _fetch: async () => { throw new Error('no network in tests'); },
    // Pre-flight sees a healthy --version transcript containing the new hash
    // unless the test forces a failure.
    _execFile: () => {
      if (opts.preflightFails) throw new Error('exec blocked');
      return `${NEW_HASH}\ntailscale v9.9.9\n`;
    },
  });
  m._appBase = dir;
  // Running daemon: recycle only proceeds with a live child (otherwise it
  // promotes file-free for the next start, exercising nothing here).
  m.proc = { pid: 1 };
  m.dnsName = 'h.tail.ts.net';
  m.scheme = 'https';
  m._stopSidecarProc = async () => { m.proc = null; m.dnsName = null; };
  m._spawn = async () => {
    state.spawns += 1;
    if (state.spawnMode === 'dead') { m.proc = null; m.dnsName = null; return; }
    m.proc = {};
    if (state.spawnMode === 'nouserl') { m.dnsName = null; return; }
    m.dnsName = 'h.tail.ts.net';
    m.scheme = 'https';
  };
  return { m, dir, sidecar, state, lock };
}

describe('mesh release tier (freshness)', function () {
  it('parses MESH-VERSION and ignores malformed/dev lines', function () {
    const m = new MeshManager({ _updateIntervalMs: 60000 });
    try {
      m._handleStdoutLine('MESH-VERSION v1.104.1 deadbeef');
      assert.strictEqual(m.tsVersion, 'v1.104.1');
      assert.strictEqual(m.sidecarHash, 'deadbeef');
      m._handleStdoutLine('MESH-VERSION garbage');
      assert.strictEqual(m.tsVersion, 'v1.104.1', 'malformed line keeps last-good');
      m._handleStdoutLine('MESH-VERSION dev dev');
      assert.strictEqual(m.tsVersion, 'v1.104.1', 'unstamped builds are not learned');
    } finally {
      m._stopUpdateTimer();
    }
  });

  it('exposes tsVersion + sidecarRef in getStatus', function () {
    const dir = sandbox();
    try {
      const { m } = refreshManager(dir);
      try {
        m._handleStdoutLine('MESH-VERSION v1.104.1 abc123');
        const s = m.getStatus();
        assert.strictEqual(s.tsVersion, 'v1.104.1');
        assert.strictEqual(s.sidecarRef, `mesh-${OLD_CONTENT_HASH}`);
      } finally {
        m._stopUpdateTimer();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no-ops when the newest release matches provenance', async function () {
    const { m, dir } = refreshManager(sandbox());
    try {
      m._installer.listMeshReleases = async () => [{ tag: `mesh-${OLD_CONTENT_HASH}`, publishedAt: 'x' }];
      const r = await m._updateTick();
      assert.strictEqual(r.update, false);
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('swaps + reconnects on a newer build, keeping .prev + provenance', async function () {
    const { m, dir, sidecar, state } = refreshManager(sandbox());
    try {
      const r = await m._updateTick();
      assert.strictEqual(r.update, true);
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), NEW_BYTES);
      assert.strictEqual(fs.readFileSync(`${sidecar}.prev`, 'utf8'), OLD_BYTES);
      assert.strictEqual(m.sidecarRef, NEW_TAG);
      assert.ok(state.spawns >= 1, 'respawned');
      assert.strictEqual(m.dnsName, 'h.tail.ts.net', 'reconnected');
      const prov = installer.loadProvenance(sidecar);
      assert.ok(prov, 'provenance written');
      assert.strictEqual(prov.ref, NEW_TAG);
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the running build when download/verify fails', async function () {
    const { m, dir, sidecar } = refreshManager(sandbox(), { fetchFails: true });
    try {
      m.proc = { fake: true };
      const r = await m._updateTick();
      assert.strictEqual(r.update, false);
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), OLD_BYTES);
      assert.ok(!fs.existsSync(`${sidecar}.prev`), 'no backup on failed fetch');
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pre-flight failure keeps the old child and quarantines the version', async function () {
    const { m, dir, sidecar, state } = refreshManager(sandbox(), { preflightFails: true });
    try {
      m.proc = { fake: true };
      m.dnsName = 'h.tail.ts.net';
      const spawnsBefore = state.spawns;
      const staged = installer.stagedSidecarPath(sidecar);
      const r = await m._updateTick();
      assert.strictEqual(r.update, false);
      assert.strictEqual(r.reason, 'preflight_failed');
      assert.strictEqual(state.spawns, spawnsBefore, 'good child never killed');
      assert.strictEqual(m.dnsName, 'h.tail.ts.net', 'still serving');
      assert.ok(!fs.existsSync(staged), 'bad stage deleted');
      assert.ok(m._failedUpdateVersions.has(NEW_HASH), 'quarantined by hash');
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back to .prev when the new build never comes up, then quarantines', async function () {
    const { m, dir, sidecar } = refreshManager(sandbox(), { spawnMode: 'dead' });
    try {
      const r = await m._updateTick();
      assert.strictEqual(r.update, false);
      assert.strictEqual(r.reason === 'rollback' || r.reason === 'rollback_failed', true, `rollback reason, got ${r.reason}`);
      assert.strictEqual(r.restored, false, 'dead respawn cannot reconnect');
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), OLD_BYTES, 'previous restored');
      assert.ok(m._failedUpdateVersions.has(NEW_HASH), 'quarantined, not latched');
      // Quarantine (not a session latch): the next tick skips the bad tag but
      // a NEWER good tag would still apply.
      const r2 = await m._updateTick();
      assert.strictEqual(r2.update, false);
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a live-but-URL-less child alone (no false rollback)', async function () {
    const { m, dir, sidecar } = refreshManager(sandbox(), { spawnMode: 'nouserl' });
    try {
      let rolledBack = false;
      const origRollback = m._installer.rollbackSidecar;
      m._installer.rollbackSidecar = async (...a) => { rolledBack = true; return origRollback(...a); };
      const r = await m._updateTick();
      assert.strictEqual(r.update, true);
      assert.strictEqual(r.reconnecting, true);
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), NEW_BYTES);
      assert.strictEqual(rolledBack, false, 'live child must not roll back');
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NEEDLOGIN-then-exit after swap rolls back (dead child + no URL)', async function () {
    const { m, dir, sidecar } = refreshManager(sandbox(), { spawnMode: 'dead' });
    try {
      // The new binary printed NEEDLOGIN (key did not carry over) then exited.
      m._handleStdoutLine('MESH-NEEDLOGIN https://login.tailscale.com/admin/settings/keys');
      const r = await m._updateTick();
      assert.strictEqual(r.update, false);
      assert.strictEqual(r.reason === 'rollback' || r.reason === 'rollback_failed', true, `rollback reason, got ${r.reason}`);
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), OLD_BYTES);
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an operator stop during the tick wins (no resurrect)', async function () {
    const { m, dir, sidecar, state } = refreshManager(sandbox());
    try {
      const spawnsBefore = state.spawns;
      const origFetch = m._installer.fetchSidecarRef;
      m._installer.fetchSidecarRef = async (tag, destPath, o) => {
        m.stopping = true; // operator hit stop() mid-download
        return origFetch(tag, destPath, o);
      };
      const r = await m._updateTick();
      assert.strictEqual(r.update, false);
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), OLD_BYTES, 'no swap');
      assert.strictEqual(state.spawns, spawnsBefore, 'no respawn against intent');
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('_restart never double-spawns over a live proc', async function () {
    const m = new MeshManager({ _updateIntervalMs: 60000 });
    try {
      m.proc = { live: true };
      let spawned = false;
      m._spawn = async () => { spawned = true; };
      await m._restart();
      assert.strictEqual(spawned, false, 'live proc blocks a stale restart');
    } finally {
      m._stopUpdateTimer();
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
      const mk = () => {
        const m = new MeshManager({
          stateDir: path.join(dir, 'ts-state'),
          sidecar,
          _updateIntervalMs: 60000,
          _installer: { loadProvenance: () => null, loadLock: () => lock },
        });
        m._appBase = dir;
        return m;
      };
      assert.strictEqual(mk()._currentSidecarRef(), 'mesh-shippedhash');
      fs.writeFileSync(sidecar, 'unknown-bytes');
      assert.strictEqual(mk()._currentSidecarRef(), null, 'unverified bytes force a check');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips the release tier under a dev ref override', async function () {
    const { m, dir } = refreshManager(sandbox());
    try {
      process.env.AIORDIE_MESH_REF = 'mesh-dev';
      let fetched = false;
      const origList = m._installer.listMeshReleases;
      m._installer.listMeshReleases = async (...a) => { fetched = true; return origList(...a); };
      const r = await m._updateTick();
      assert.strictEqual(r.update, false);
      assert.strictEqual(fetched, false, 'no network under override');
    } finally {
      delete process.env.AIORDIE_MESH_REF;
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('floors the update interval against hot-loops', function () {
    const m = new MeshManager({ _updateIntervalMs: 5 });
    try {
      assert.ok(m._updateIntervalMs >= 1000, `option floored, got ${m._updateIntervalMs}`);
    } finally {
      m._stopUpdateTimer();
    }
  });
});

describe('mesh merged-convergence rules', function () {
  it('tier-2 output is a steady state: next tick is up-to-date, no re-download', async function () {
    const { m, dir, sidecar } = refreshManager(sandbox());
    try {
      const first = await m._updateTick();
      assert.strictEqual(first.update, true, 'first tick applies the release');
      let fetches = 0;
      const origFetch = m._installer.fetchSidecarRef;
      m._installer.fetchSidecarRef = async (...a) => { fetches += 1; return origFetch(...a); };
      let stages = 0;
      const origStage = m._installer.stageSidecar;
      m._installer.stageSidecar = async (...a) => { stages += 1; return origStage(...a); };
      const second = await m._updateTick();
      assert.strictEqual(second.update, false, 'no oscillation back toward the lock');
      assert.strictEqual(fetches, 0, 'no re-download');
      assert.strictEqual(stages, 0, 'no re-stage');
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), NEW_BYTES, 'new bytes stand');
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a restart promotes a release-tier stage via the persisted .sha file', async function () {
    const { m, dir, sidecar } = refreshManager(sandbox());
    try {
      // Simulate a stage written before exec died: .new + .sha, lock mismatching.
      const staged = installer.stagedSidecarPath(sidecar);
      fs.writeFileSync(staged, NEW_BYTES);
      fs.writeFileSync(`${staged}.sha256`, sha256(NEW_BYTES));
      const m2 = new MeshManager({
        stateDir: path.join(dir, 'ts-state'),
        sidecar,
        _installer: m._installer,
        _updateIntervalMs: 60000,
        authKey: 'k',
      });
      m2._appBase = dir;
      m2._spawn = async () => { m2.proc = {}; m2.dnsName = 'h'; m2.scheme = 'https'; };
      await m2.start();
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), NEW_BYTES, 'release stage promoted, not deleted');
      assert.ok(!fs.existsSync(`${staged}.sha256`), 'sha sidecar consumed');
      m2._stopUpdateTimer();
      await m2.stop();
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('quarantine persists across restarts; success clears the slate', async function () {
    const { m, dir } = refreshManager(sandbox(), { spawnMode: 'dead' });
    try {
      await m._updateTick(); // rolls back + quarantines NEW_HASH
      const qfile = path.join(dir, 'mesh', 'quarantine.json');
      assert.ok(fs.existsSync(qfile), 'quarantine persisted to disk');
      const m2 = new MeshManager({
        stateDir: path.join(dir, 'ts-state'),
        sidecar: path.join(dir, 'bin', 'ai-or-die-mesh'),
        _installer: m._installer,
        _updateIntervalMs: 60000,
      });
      m2._appBase = dir;
      try {
        assert.ok(m2._isQuarantined(NEW_TAG), 'fresh instance honors the file');
      } finally {
        m2._stopUpdateTimer();
      }
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a promote failure respawns the untouched stable build', async function () {
    const { m, dir, sidecar, state } = refreshManager(sandbox());
    try {
      const spawnsBefore = state.spawns;
      m._installer.promoteStagedSidecar = async () => {
        const e = new Error('locked');
        e.code = 'locked-binary';
        throw e;
      };
      m.proc = { pid: 1 };
      m.dnsName = 'h.tail.ts.net';
      const r = await m._updateTick();
      assert.strictEqual(r.update, false);
      assert.strictEqual(r.reason, 'promote_failed');
      assert.ok(state.spawns > spawnsBefore, 'old build respawned');
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), OLD_BYTES, 'stable bytes never moved');
      assert.strictEqual(m.dnsName, 'h.tail.ts.net', 'still serving');
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stop during rollback stands down without respawning', async function () {
    const { m, dir, sidecar, state } = refreshManager(sandbox(), { spawnMode: 'dead' });
    try {
      const spawnsBefore = state.spawns;
      const stoppedAtSpawn = [];
      const origSpawn = m._spawn;
      m._spawn = async (...a) => { stoppedAtSpawn.push(!!m.stopping); return origSpawn(...a); };
      const origRollback = m._installer.rollbackSidecar;
      m._installer.rollbackSidecar = async (...a) => {
        m.stopping = true; // operator hit stop() mid-rollback
        return origRollback(...a);
      };
      const r = await m._updateTick();
      assert.strictEqual(r.update, false);
      assert.strictEqual(r.reason, 'stopping');
      assert.deepStrictEqual(stoppedAtSpawn, [false], 'only the pre-stop spawn ran; none after');
      assert.strictEqual(state.spawns, spawnsBefore + 1);
      assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), OLD_BYTES, 'rollback completed before standing down');
    } finally {
      m.stopping = false;
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reconnecting recycle records identity: updateAvailable clears', async function () {
    const { m, dir, sidecar } = refreshManager(sandbox(), { spawnMode: 'nouserl' });
    try {
      await m._updateTick();
      const s = m.getStatus();
      assert.deepStrictEqual(Object.keys(s).sort(), [
        'activeVersion', 'lastUpdateCheck', 'lastUpdateResult', 'peers',
        'publicUrl', 'running', 'sidecarRef', 'stagedVersion', 'tsVersion', 'updateAvailable',
      ]);
      assert.strictEqual(s.updateAvailable, false, 'running build is recorded, not pending');
      assert.strictEqual(s.sidecarRef, NEW_TAG);
      let fetches = 0;
      m._installer.fetchSidecarRef = async () => { fetches += 1; throw new Error('must not refetch'); };
      const r2 = await m._updateTick();
      assert.strictEqual(r2.update, false);
      assert.strictEqual(fetches, 0, 'recorded build is not re-fetched');
    } finally {
      m._stopUpdateTimer();
      fs.rmSync(dir, { recursive: true, force: true });
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
