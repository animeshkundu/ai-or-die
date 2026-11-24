'use strict';

// Coverage for install-time Server provisioning.
//
// Background: `service install` used to write a unit that pointed at
// ~/.ai-or-die/bin/ai-or-die-server, which NOTHING created. The service booted,
// failed with MODULE_NOT_FOUND, and the task sat there looking installed. These
// tests pin the behaviour that replaced it: download the published SEA, verify
// GitHub's per-asset sha256 digest BEFORE it becomes runnable, promote
// atomically, and fail loudly (never silently) when the network is unavailable.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const {
  promoteBinary,
  provisionServerBinary,
  assetNameFor,
  assertRunnableBinary,
  parseDigest,
  sha256File,
  pickRelease,
  ProvisionError,
} = require('../src/supervisor/server-provisioner');
const { platformAssetPattern } = require('../src/supervisor/autoupdater');

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-prov-'));
}

// A fake executable that answers `--version`. On POSIX it needs the x bit, and
// on Windows it must not look like JavaScript (the provisioner refuses .js).
function writeFakeExe(file, version = '0.1.112') {
  if (process.platform === 'win32') {
    // A .cmd shim is not directly executable by plain spawn, so use a tiny
    // node-free probe instead: the provisioner's verify step is injectable and
    // these tests pass `verify: false` where a real exec is impossible.
    fs.writeFileSync(file, 'not-a-script');
    return file;
  }
  fs.writeFileSync(file, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  return file;
}

function fakeRelease(options = {}) {
  const { platform = 'linux', arch = 'x64', overrides = {} } = options;
  const body = Buffer.from('fake-sea-payload-' + Math.random());
  return {
    body,
    release: {
      tag_name: 'v0.1.112',
      draft: false,
      prerelease: false,
      assets: [{
        name: assetNameFor(platform, arch),
        size: body.length,
        digest: `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`,
        browser_download_url: 'https://example.invalid/asset',
      }],
      ...overrides,
    },
  };
}

describe('service/server-provisioner', function () {
  it('names the published release assets, not a server-role fiction', function () {
    assert.strictEqual(assetNameFor('win32', 'x64'), 'ai-or-die-windows-x64.exe');
    assert.strictEqual(assetNameFor('linux', 'x64'), 'ai-or-die-linux-x64');
    assert.throws(() => assetNameFor('darwin', 'arm64'), /no published ai-or-die server build/);
    assert.throws(() => assetNameFor('win32', 'arm64'), /--server-binary/);
  });

  it('the updater pattern matches what the release actually publishes', function () {
    assert.ok(platformAssetPattern('win32', 'x64').test('ai-or-die-windows-x64.exe'));
    assert.ok(platformAssetPattern('linux', 'x64').test('ai-or-die-linux-x64'));
    // The historical (broken) names must NOT match.
    assert.ok(!platformAssetPattern('win32', 'x64').test('ai-or-die-server-win32-x64.exe'));
    assert.ok(!platformAssetPattern('linux', 'x64').test('ai-or-die-server-linux-x64'));
  });

  it('parses release digests and rejects malformed ones', function () {
    const hex = 'a'.repeat(64);
    assert.strictEqual(parseDigest({ digest: `sha256:${hex}` }), hex);
    assert.strictEqual(parseDigest({ digest: hex }), hex);
    assert.strictEqual(parseDigest({ digest: 'sha512:abc' }), null);
    assert.strictEqual(parseDigest({}), null);
  });

  it('downloads, verifies the digest and promotes atomically', async function () {
    const dir = sandbox();
    try {
      const { body, release } = fakeRelease();
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      const staging = path.join(dir, 'staging');
      const seen = [];
      const result = await provisionServerBinary({
        dest,
        stagingDir: staging,
        logger: silent,
        platform: 'linux',
        arch: 'x64',
        verify: false,
        fetchReleases: async () => [release],
        download: async (url, target) => { seen.push(url); fs.writeFileSync(target, body); return target; },
      });
      assert.strictEqual(result.provisioned, true);
      assert.strictEqual(result.verified, 'digest');
      assert.strictEqual(result.releaseTag, 'v0.1.112');
      assert.strictEqual(result.sha256, crypto.createHash('sha256').update(body).digest('hex'));
      assert.ok(fs.existsSync(dest), 'binary promoted into place');
      assert.deepStrictEqual(fs.readdirSync(staging), [], 'no .part file left behind');
      assert.deepStrictEqual(seen, ['https://example.invalid/asset']);
      assert.strictEqual(await sha256File(dest), result.sha256);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to promote a download the release cannot authenticate', async function () {
    const dir = sandbox();
    try {
      const { body, release } = fakeRelease();
      // A release that publishes no digest: the bytes cannot be authenticated,
      // so they must never become the executable the installed task launches.
      delete release.assets[0].digest;
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      await assert.rejects(
        () => provisionServerBinary({
          dest,
          stagingDir: path.join(dir, 'staging'),
          logger: silent,
          platform: 'linux',
          arch: 'x64',
          verify: false,
          fetchReleases: async () => [release],
          download: async (url, target) => { fs.writeFileSync(target, body); return target; },
        }),
        (err) => err.code === 'checksum-mismatch'
          && /no sha256 digest/.test(err.message)
          && /AIORDIE_ALLOW_UNDIGESTED_SERVER=1/.test(err.message)
      );
      assert.ok(!fs.existsSync(dest), 'nothing was promoted');
      // The escape hatch is explicit, not default.
      const ok = await provisionServerBinary({
        dest,
        stagingDir: path.join(dir, 'staging'),
        logger: silent,
        platform: 'linux',
        arch: 'x64',
        verify: false,
        allowUndigested: true,
        fetchReleases: async () => [release],
        download: async (url, target) => { fs.writeFileSync(target, body); return target; },
      });
      assert.strictEqual(ok.verified, 'local');
      assert.ok(fs.existsSync(dest));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a truncated transfer even when the digest is missing', async function () {
    const dir = sandbox();
    try {
      const { body, release } = fakeRelease();
      delete release.assets[0].digest;
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      await assert.rejects(
        () => provisionServerBinary({
          dest,
          stagingDir: path.join(dir, 'staging'),
          logger: silent,
          platform: 'linux',
          arch: 'x64',
          verify: false,
          allowUndigested: true,
          fetchReleases: async () => [release],
          // Half the bytes, no error: 'finish' still fires on the stream.
          download: async (url, target) => { fs.writeFileSync(target, body.slice(0, 5)); return target; },
        }),
        (err) => err.code === 'checksum-mismatch' && /truncated/.test(err.message)
      );
      assert.ok(!fs.existsSync(dest), 'a short file is never promoted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed promote restores the working binary (Windows rename rules)', async function () {
    const dir = sandbox();
    try {
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeFakeExe(dest, '1.0.0');
      const before = fs.readFileSync(dest, 'utf8');
      const tmp = path.join(dir, 'staging', 'incoming');
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      writeFakeExe(tmp, '2.0.0');
      // Simulate the Windows case: dest cannot be replaced (mapped by a running
      // process / AV lock). The old binary must survive.
      const origRename = fsp.rename;
      let calls = 0;
      fsp.rename = async (from, to) => {
        calls += 1;
        // First call moves dest -> backup (allowed), second (backup -> dest
        // restore) is what we let through; fail the promote itself.
        if (calls === 2) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        return origRename(from, to);
      };
      try {
        await assert.rejects(() => promoteBinary(tmp, dest), /EPERM/);
      } finally {
        fsp.rename = origRename;
      }
      assert.strictEqual(fs.readFileSync(dest, 'utf8'), before, 'the previous binary is back in place');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the backup and names it when the promote AND the restore both fail', async function () {
    const dir = sandbox();
    try {
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeFakeExe(dest, '1.0.0');
      const before = fs.readFileSync(dest, 'utf8');
      const tmp = path.join(dir, 'staging', 'incoming');
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      writeFakeExe(tmp, '2.0.0');
      const backup = `${dest}.${process.pid}.bak`;
      // The exact Windows case: dest is locked (mapped image / AV scan) so the
      // promote fails, and the restore hits the same lock. Deleting the backup
      // here would leave BOTH dest and the backup gone — nothing left to exec.
      const origRename = fsp.rename;
      let calls = 0;
      fsp.rename = async (from, to) => {
        calls += 1;
        if (calls >= 2) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        return origRename(from, to);
      };
      let failed;
      try {
        await assert.rejects(() => promoteBinary(tmp, dest), (err) => { failed = err; return true; });
      } finally {
        fsp.rename = origRename;
      }
      // The old bytes must still exist somewhere an operator can find them.
      const survivors = [dest, backup].filter((p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8') === before);
      assert.strictEqual(survivors.length >= 1, true, `previous binary survived at ${survivors.join(', ') || 'NOWHERE'}`);
      assert.ok(fs.existsSync(backup), 'the backup is kept, not swept up by the finally block');
      assert.ok(failed.message.includes(backup), `message names the backup path: ${failed.message}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never copies --server-binary over a pre-planted staging path', async function () {
    const dir = sandbox();
    try {
      const supplied = writeFakeExe(path.join(dir, 'custom-server'), '9.9.9');
      const suppliedBytes = fs.readFileSync(supplied);
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      const staging = path.join(dir, 'staging');
      fs.mkdirSync(staging, { recursive: true });
      // The staging name used to be fully predictable: delete-then-copyFile
      // meant a file planted here was destroyed, and a symlink/junction here
      // would have its TARGET truncated. Both are now impossible.
      const planted = path.join(staging, `${path.basename(dest)}.${process.pid}.part`);
      fs.writeFileSync(planted, 'planted-do-not-touch');
      const flagsSeen = [];
      const origCopy = fsp.copyFile;
      fsp.copyFile = async (from, to, flags) => {
        flagsSeen.push(flags);
        return origCopy(from, to, flags);
      };
      let result;
      try {
        result = await provisionServerBinary({
          dest,
          stagingDir: staging,
          logger: silent,
          platform: 'linux',
          arch: 'x64',
          serverBinaryPath: supplied,
          execFileSync: () => '9.9.9\n',
          reuseExisting: false,
        });
      } finally {
        fsp.copyFile = origCopy;
      }
      assert.strictEqual(fs.readFileSync(planted, 'utf8'), 'planted-do-not-touch', 'planted file untouched');
      assert.ok(flagsSeen.every((f) => (f & fs.constants.COPYFILE_EXCL) !== 0), 'every copy is exclusive (wx-equivalent)');
      assert.strictEqual(result.verified, 'supplied');
      assert.ok(fs.readFileSync(dest).equals(suppliedBytes), 'the fresh name carried the real payload into place');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a directory --server-binary as a ProvisionError, not a bare fs error', async function () {
    const dir = sandbox();
    try {
      const srcDir = path.join(dir, 'supplied-dir');
      fs.mkdirSync(srcDir);
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      let failed;
      await assert.rejects(
        () => provisionServerBinary({
          dest,
          logger: silent,
          platform: 'linux',
          arch: 'x64',
          serverBinaryPath: srcDir,
          execFileSync: () => '9.9.9\n',
          reuseExisting: false,
        }),
        (err) => { failed = err; return true; }
      );
      // A raw EISDIR/EPERM reaching the CLI printed "(undefined)": the CLI only
      // decodes ProvisionError codes, so the copy failure must be wrapped.
      assert.ok(failed instanceof ProvisionError, `expected ProvisionError, got ${failed && failed.name}: ${failed && failed.code}`);
      assert.strictEqual(failed.code, 'invalid-binary');
      assert.ok(failed.message.includes(srcDir), `message names the source: ${failed.message}`);
      assert.ok(/EISDIR|EPERM|EACCES|ENOTDIR/.test(failed.message), `message keeps the OS code: ${failed.message}`);
      assert.ok(!fs.existsSync(dest), 'nothing was promoted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a short --server-binary copy instead of promoting it', async function () {
    const dir = sandbox();
    try {
      const supplied = writeFakeExe(path.join(dir, 'custom-server'), '9.9.9');
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      const staging = path.join(dir, 'staging');
      const origCopy = fsp.copyFile;
      // ENOSPC mid-copy still leaves a file behind that would probe fine and be
      // promoted: the size comparison is the only thing that catches it.
      fsp.copyFile = async (from, to) => { fs.writeFileSync(to, 'short'); };
      let failed;
      try {
        await assert.rejects(
          () => provisionServerBinary({
            dest,
            stagingDir: staging,
            logger: silent,
            platform: 'linux',
            arch: 'x64',
            serverBinaryPath: supplied,
            execFileSync: () => '9.9.9\n',
            reuseExisting: false,
          }),
          (err) => { failed = err; return true; }
        );
      } finally {
        fsp.copyFile = origCopy;
      }
      assert.strictEqual(failed.code, 'invalid-binary');
      assert.ok(/incomplete/.test(failed.message), `message says the copy is incomplete: ${failed.message}`);
      assert.ok(!fs.existsSync(dest), 'a short copy is never promoted');
      const leftover = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
      assert.deepStrictEqual(leftover, [], 'the short copy is discarded');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a payload whose bytes do not match the release digest', async function () {
    const dir = sandbox();
    try {
      const { release } = fakeRelease();
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      await assert.rejects(
        () => provisionServerBinary({
          dest,
          stagingDir: path.join(dir, 'staging'),
          logger: silent,
          platform: 'linux',
          arch: 'x64',
          verify: false,
          fetchReleases: async () => [release],
          // Tampered payload: same shape, different bytes.
          download: async (url, target) => { fs.writeFileSync(target, Buffer.from('tampered')); return target; },
        }),
        (err) => err instanceof ProvisionError && err.code === 'checksum-mismatch'
      );
      assert.ok(!fs.existsSync(dest), 'nothing promoted on a checksum failure');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--offline fails with an actionable message instead of downloading', async function () {
    const dir = sandbox();
    try {
      let touched = false;
      await assert.rejects(
        () => provisionServerBinary({
          dest: path.join(dir, 'bin', 'ai-or-die-server'),
          stagingDir: path.join(dir, 'staging'),
          logger: silent,
          offline: true,
          fetchReleases: async () => { touched = true; return []; },
        }),
        (err) => err.code === 'offline' && /--server-binary/.test(err.message)
      );
      assert.strictEqual(touched, false, 'offline never reaches the network');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--server-binary copies an operator-supplied binary and verifies it runs', async function () {
    const dir = sandbox();
    try {
      const supplied = writeFakeExe(path.join(dir, 'custom-server'), '9.9.9');
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      const result = await provisionServerBinary({
        dest,
        logger: silent,
        platform: 'linux',
        arch: 'x64',
        serverBinaryPath: supplied,
        execFileSync: () => '9.9.9\n',
      });
      assert.strictEqual(result.verified, 'supplied');
      assert.strictEqual(result.version, '9.9.9');
      assert.ok(fs.existsSync(dest));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed --server-binary copy leaves the working binary intact', async function () {
    const dir = sandbox();
    try {
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeFakeExe(dest, '1.0.0');
      const before = fs.readFileSync(dest, 'utf8');
      // The supplied source disappears between "exists" and "copy": the copy
      // must fail without having already truncated the installed binary, or
      // the machine is left with a registered task pointing at nothing.
      const supplied = writeFakeExe(path.join(dir, 'vanishing-server'), '9.9.9');
      const origCopy = fsp.copyFile;
      try {
        fsp.copyFile = async () => { throw Object.assign(new Error('ENOENT: source vanished'), { code: 'ENOENT' }); };
        await assert.rejects(() => provisionServerBinary({
          dest,
          logger: silent,
          platform: 'linux',
          arch: 'x64',
          serverBinaryPath: supplied,
          execFileSync: () => '9.9.9\n',
          reuseExisting: false,
        }), /source vanished/);
      } finally {
        fsp.copyFile = origCopy;
      }
      assert.strictEqual(fs.readFileSync(dest, 'utf8'), before, 'the previous binary is untouched');
      const staging = path.join(dir, 'staging');
      const leftover = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
      assert.deepStrictEqual(leftover, [], 'no partial copy left behind');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a JavaScript file as the server binary', function () {
    assert.throws(
      () => assertRunnableBinary('/repo/bin/ai-or-die.js', { verify: false }),
      /is a JavaScript file, not a runnable server binary/
    );
  });

  it('rejects a binary that cannot run before it is promoted', async function () {
    const dir = sandbox();
    try {
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      // The deliverable matches its digest but is not executable: this is the
      // shape of a corrupted upload or an AV-mangled payload.
      const payload = Buffer.from('junk-that-is-not-an-executable');
      const { release } = fakeRelease();
      // Keep the advertised size consistent with the payload: this test is
      // about the runnable probe, not about a truncated transfer.
      release.assets[0].size = payload.length;
      release.assets[0].digest = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
      await assert.rejects(
        () => provisionServerBinary({
          dest,
          stagingDir: path.join(dir, 'staging'),
          logger: silent,
          platform: 'linux',
          arch: 'x64',
          fetchReleases: async () => [release],
          download: async (url, target) => { fs.writeFileSync(target, payload); return target; },
          verify: true,
          execFileSync: () => { throw new Error('ENOEXEC'); },
        }),
        (err) => err.code === 'invalid-binary'
      );
      assert.ok(!fs.existsSync(dest), 'unrunnable binary is never promoted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses an existing runnable binary on reinstall (no second download)', async function () {
    const dir = sandbox();
    try {
      const dest = path.join(dir, 'bin', 'ai-or-die-server');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'existing-binary');
      const result = await provisionServerBinary({
        dest,
        logger: silent,
        platform: 'linux',
        arch: 'x64',
        execFileSync: () => '0.1.100\n',
        fetchReleases: async () => { throw new Error('must not fetch'); },
      });
      assert.strictEqual(result.provisioned, false);
      assert.strictEqual(result.verified, 'existing');
      assert.strictEqual(result.version, '0.1.100');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors clearly when the release has no matching asset', async function () {
    const { release } = fakeRelease();
    release.assets = [{ name: 'something-else.zip', browser_download_url: 'x' }];
    assert.throws(() => pickRelease([release], 'v9.9.9'), /release v9\.9\.9 not found/);
    const dir = sandbox();
    try {
      await assert.rejects(
        () => provisionServerBinary({
          dest: path.join(dir, 'bin', 'ai-or-die-server'),
          stagingDir: path.join(dir, 'staging'),
          logger: silent,
          platform: 'linux',
          arch: 'x64',
          verify: false,
          fetchReleases: async () => [release],
          download: async () => { throw new Error('must not download'); },
        }),
        (err) => err.code === 'no-asset' && /has no asset named/.test(err.message)
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins an explicit --release-version', async function () {
    const older = fakeRelease().release;
    older.tag_name = 'v0.1.90';
    const newer = fakeRelease().release;
    newer.tag_name = 'v0.1.112';
    assert.strictEqual(pickRelease([newer, older]).tag_name, 'v0.1.112');
    assert.strictEqual(pickRelease([newer, older], 'v0.1.90').tag_name, 'v0.1.90');
    assert.strictEqual(pickRelease([newer, older], '0.1.90').tag_name, 'v0.1.90');
  });
});
