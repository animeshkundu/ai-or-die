'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { AutoUpdater, compareVersions, platformAssetPattern } = require('../src/supervisor/autoupdater');
const { assetNameFor } = require('../src/supervisor/server-provisioner');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-updater-'));
}

describe('supervisor/autoupdater', function () {
  it('compareVersions orders semver correctly', function () {
    assert.strictEqual(compareVersions('0.1.109', '0.1.108') > 0, true);
    assert.strictEqual(compareVersions('0.1.108', '0.1.108'), 0);
    assert.strictEqual(compareVersions('0.2.0', '0.10.0') < 0, true);
    assert.strictEqual(compareVersions('v0.1.109', '0.1.108') > 0, true);
  });

  it('platformAssetPattern matches this platform’s published asset', function () {
    // Live release assets are ai-or-die-windows-x64.exe / ai-or-die-linux-x64.
    // The old ai-or-die-server-<plat>-<arch> pattern matched nothing published,
    // which is why the staged server binary never appeared.
    const name = assetNameFor(process.platform, process.arch);
    assert.strictEqual(platformAssetPattern().test(name), true);
    assert.strictEqual(platformAssetPattern().test('ai-or-die-server-solaris-sparc'), false);
    assert.strictEqual(platformAssetPattern().test('ai-or-die-server-win32-x64.exe'), false);
  });

  it('check() stages a newer release and reports staged', async function () {
    const dir = sandbox();
    try {
      // Staged binaries carry .exe on Windows (mirrors _stageRelease).
      const stagedFile = path.join(dir, 'staging',
        `ai-or-die-server-0.1.109${process.platform === 'win32' ? '.exe' : ''}`);
      const payload = Buffer.from('binary');
      const assetName = assetNameFor(process.platform, process.arch);
      const updater = new AutoUpdater({
        currentVersion: '0.1.108',
        stagingDir: path.join(dir, 'staging'),
        serverBin: path.join(dir, 'bin', 'ai-or-die-server'),
        fetch: async () => [{
          tag_name: 'v0.1.109',
          prerelease: false,
          draft: false,
          assets: [{
            name: assetName,
            browser_download_url: 'https://example.invalid/x',
            digest: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
          }],
        }],
        download: async (url, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, payload); },
      });
      let notified = null;
      updater._supervisor = { notifyUpdateReady: (v) => { notified = v; } };
      const result = await updater.check();
      assert.strictEqual(result.staged, true);
      assert.strictEqual(result.version, '0.1.109');
      assert.strictEqual(notified, '0.1.109');
      assert.ok(fs.existsSync(stagedFile));
      assert.strictEqual(
        updater.pendingUpdate.releaseSha256,
        crypto.createHash('sha256').update(payload).digest('hex'),
        'release digest recorded for apply()'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('check() discards a download whose bytes fail the release digest', async function () {
    const dir = sandbox();
    try {
      const updater = new AutoUpdater({
        currentVersion: '0.1.108',
        stagingDir: path.join(dir, 'staging'),
        serverBin: path.join(dir, 'bin', 'ai-or-die-server'),
        fetch: async () => [{
          tag_name: 'v0.1.109',
          prerelease: false,
          draft: false,
          assets: [{
            name: assetNameFor(process.platform, process.arch),
            browser_download_url: 'https://example.invalid/x',
            digest: `sha256:${'0'.repeat(64)}`,
          }],
        }],
        download: async (url, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'tampered'); },
      });
      await assert.rejects(() => updater.check(), /checksum mismatch|digest/i);
      assert.strictEqual(updater.pendingUpdate, null, 'nothing staged from bad bytes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('check() ignores older and prerelease versions', async function () {
    const dir = sandbox();
    try {
      const updater = new AutoUpdater({
        currentVersion: '0.1.108',
        stagingDir: path.join(dir, 'staging'),
        serverBin: path.join(dir, 'bin', 'ai-or-die-server'),
        fetch: async () => [
          { tag_name: 'v0.1.107', prerelease: false, draft: false, assets: [] },
          { tag_name: 'v0.2.0-beta', prerelease: true, draft: false, assets: [] },
        ],
      });
      const result = await updater.check();
      assert.strictEqual(result.update || false, false);
      assert.strictEqual(updater.pendingUpdate, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('apply() swaps via the supervisor and promotes the binary', async function () {
    const dir = sandbox();
    try {
      const staged = path.join(dir, 'staging', 'ai-or-die-server-0.1.109');
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.writeFileSync(staged, 'new-binary');
      let swappedWith = null;
      const updater = new AutoUpdater({
        currentVersion: '0.1.108',
        stagingDir: path.join(dir, 'staging'),
        serverBin: path.join(dir, 'bin', 'ai-or-die-server'),
        supervisor: {
          swapServer: async (bin) => { swappedWith = bin; return { swapped: true, ptys: 3 }; },
          onUpdateApplied: () => {},
        },
      });
      updater.pendingUpdate = { version: '0.1.109', binaryPath: staged, downloadedAt: Date.now() };
      const result = await updater.apply();
      assert.strictEqual(result.applied, true);
      assert.strictEqual(result.promoted, true);
      assert.strictEqual(result.ptys, 3);
      assert.strictEqual(swappedWith, staged);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'bin', 'ai-or-die-server'), 'utf8'), 'new-binary');
      assert.strictEqual(updater.pendingUpdate, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('apply() keeps the old server when the swap fails (rollback)', async function () {
    const dir = sandbox();
    try {
      const staged = path.join(dir, 'staging', 'ai-or-die-server-0.1.109');
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.writeFileSync(staged, 'bad-binary');
      const updater = new AutoUpdater({
        currentVersion: '0.1.108',
        stagingDir: path.join(dir, 'staging'),
        serverBin: path.join(dir, 'bin', 'ai-or-die-server'),
        supervisor: {
          swapServer: async () => ({ swapped: false, reason: 'handoff_failed' }),
          onUpdateApplied: () => {},
        },
      });
      updater.pendingUpdate = { version: '0.1.109', binaryPath: staged, downloadedAt: Date.now() };
      const result = await updater.apply();
      assert.strictEqual(result.applied, false);
      assert.ok(updater.pendingUpdate, 'staged binary retained for inspection');
      assert.ok(!fs.existsSync(path.join(dir, 'bin', 'ai-or-die-server')), 'old binary untouched');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('apply(opts) forwards swap options (e.g. onPreShutdown) to the supervisor', async function () {
    const dir = sandbox();
    try {
      const staged = path.join(dir, 'staging', 'ai-or-die-server-0.1.109');
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.writeFileSync(staged, 'new-binary');
      let seenOpts = null;
      const updater = new AutoUpdater({
        currentVersion: '0.1.108',
        stagingDir: path.join(dir, 'staging'),
        serverBin: path.join(dir, 'bin', 'ai-or-die-server'),
        supervisor: {
          swapServer: async (bin, args, env, opts) => { seenOpts = opts; return { swapped: true, ptys: 0 }; },
          onUpdateApplied: () => {},
        },
      });
      updater.pendingUpdate = { version: '0.1.109', binaryPath: staged, downloadedAt: Date.now() };
      const hook = () => {};
      const result = await updater.apply({ onPreShutdown: hook });
      assert.strictEqual(result.applied, true);
      assert.strictEqual(seenOpts && seenOpts.onPreShutdown, hook, 'hook threaded through');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maybeAutoApply() waits for the idle window', async function () {
    const updater = new AutoUpdater({
      currentVersion: '0.1.108',
      autoApplyIdleMs: 60 * 1000,
      supervisor: { swapServer: async () => ({ swapped: true }) },
    });
    updater.pendingUpdate = { version: '0.1.109', binaryPath: '/tmp/x', downloadedAt: Date.now() };
    updater.markPtyActivity(); // just now: not idle
    const result = await updater.maybeAutoApply();
    assert.deepStrictEqual(result, { applied: false, reason: 'not_idle' });
  });
});
