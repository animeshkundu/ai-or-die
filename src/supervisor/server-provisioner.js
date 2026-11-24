'use strict';

// ServerProvisioner — obtain the runnable Server binary for a service install.
//
// The service definition points at ~/.ai-or-die/bin/ai-or-die-server[.exe]
// (STABLE_SERVER_BIN) forever. Nothing used to create that file at install
// time: only AutoUpdater.apply() writes it, and its asset pattern never matched
// the published release assets, so a fresh `service install` produced a Task
// that started a supervisor which immediately died with
//   Cannot find module '~/.ai-or-die/bin/ai-or-die-server'
// and then `[supervisor-service] failed to start: server exited before READY`.
//
// This module provisions the binary BEFORE any unit file is written, so a
// failed download can never leave a registered task pointing at nothing.
//
// Trust model: GitHub releases are fetched over TLS, and every release asset
// carries a `digest` field ("sha256:<hex>") computed by GitHub on upload. We
// verify that digest before the bytes ever reach the runnable path (download to
// a `.part` file, verify, then rename into place — no TOCTOU window). When a
// release predates asset digests, verification falls back to recomputing the
// hash and recording it in service.json, and the install announces the weaker
// guarantee rather than pretending.
//
// Escape hatches (both persisted in service.json for `service status`):
//   --server-binary <path>  use an operator-supplied binary (verified with
//                           `<bin> --version` before it is installed)
//   --offline               never touch the network; fail with the exact
//                           remediation instead of downloading

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  GITHUB_RELEASES_API,
  GITHUB_OWNER,
  GITHUB_REPO,
  STABLE_SERVER_BIN,
} = require('./constants');

// Fixed release matrix (see .github/workflows/release-on-main.yml). The assets
// are named after the platform, NOT after the "server" role — this is the exact
// mismatch that broke AutoUpdater's platformAssetPattern().
const ASSET_MATRIX = {
  'win32-x64': 'ai-or-die-windows-x64.exe',
  'linux-x64': 'ai-or-die-linux-x64',
};

class ProvisionError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ProvisionError';
    this.code = code; // unsupported-platform | offline | network | no-asset | checksum-mismatch | invalid-binary
    if (detail) this.detail = detail;
  }
}

function assetNameFor(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const name = ASSET_MATRIX[key];
  if (!name) {
    throw new ProvisionError(
      'unsupported-platform',
      `no published ai-or-die server build for ${platform}/${arch} ` +
      `(published: ${Object.keys(ASSET_MATRIX).join(', ')}); ` +
      'pass --server-binary <path> to install a locally built binary'
    );
  }
  return name;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Move `tmp` onto `dest` without ever leaving `dest` missing.
 *
 * Windows cannot rename over a file another process has mapped, and a rename
 * can still fail with EXDEV/EPERM/AV interference after the staging checks. The
 * previous binary is therefore moved ASIDE first and restored if the second
 * rename fails: at no point does `dest` not exist (the installed task execs it).
 */
async function promoteBinary(tmp, dest) {
  const backup = `${dest}.${process.pid}.bak`;
  let moved = false; // the previous binary now lives at `backup`, not at `dest`
  let promoted = false; // `dest` holds the NEW binary (known good)
  let restoreErr = null; // set only when moving the previous binary back failed
  try { fs.rmSync(backup, { force: true }); } catch (_) { /* stale backup */ }
  try {
    if (fs.existsSync(dest)) {
      await fsp.rename(dest, backup);
      moved = true;
    }
    await fsp.rename(tmp, dest);
    promoted = true;
  } catch (err) {
    if (moved) {
      try {
        await fsp.rename(backup, dest);
        moved = false; // restored: `dest` is the known-good previous binary again
      } catch (e) {
        restoreErr = e;
      }
    }
    if (restoreErr) {
      // Promote failed AND the restore failed (EPERM/EBUSY/AV lock on Windows).
      // `dest` is now missing or holds a partial file, so `backup` is the ONLY
      // working copy; deleting it (what the old finally did unconditionally)
      // left the installed task exec'ing nothing at all. Keep it and name it.
      throw new ProvisionError(
        'invalid-binary',
        `could not install ${dest} (${err.code || 'EUNKNOWN'}: ${err.message}) and could not restore ` +
        `the previous binary (${restoreErr.code || 'EUNKNOWN'}: ${restoreErr.message}); ` +
        `the previous binary was kept at ${backup} — move it back to ${dest} by hand ` +
        'once the file lock is released',
        { backup, promote: err.code || null, restore: restoreErr.code || null }
      );
    }
    throw err;
  } finally {
    // Only drop the backup when `dest` is known good: either the new binary was
    // promoted, or the previous binary was moved back (or never moved aside).
    // Otherwise `backup` is the last working copy and must survive the failure.
    if (promoted || !moved) {
      try { if (fs.existsSync(backup)) fs.rmSync(backup, { force: true }); } catch (_) { /* ignore */ }
    }
  }
  return dest;
}

// Each retry costs one filesystem call; 3 keeps a hostile pre-planted name from
// wedging the install while still giving transient EEXIST room to clear.
const STAGE_ATTEMPTS = 3;

function stageCopyError(src, target, err) {
  // Raw EACCES/EISDIR/ENOSPC out of copyFile reached the operator as a bare fs
  // error the CLI renders as "(undefined)". The CLI decodes ProvisionError
  // codes, so every staging failure is mapped to invalid-binary with the source
  // path and the OS code kept for diagnosis.
  return new ProvisionError(
    'invalid-binary',
    `could not copy --server-binary ${src} to ${target} ` +
    `(${(err && err.code) || 'EUNKNOWN'}: ${(err && err.message) || 'copy failed'}); ` +
    'the source must be a readable file (not a directory) and the staging volume must have free space',
    { source: src, code: (err && err.code) || null }
  );
}

/**
 * Copy the operator-supplied binary into the staging directory under a name we
 * created ourselves.
 *
 * The historical name was `<dest>.<pid>.part`, i.e. fully predictable: anyone
 * who can write the staging directory could plant a symlink/junction there and
 * have copyFile truncate the link target. copyFile gets the same guarantee the
 * download path gets from flags: 'wx' — COPYFILE_EXCL fails instead of writing
 * through — and EEXIST is retried under a random suffix rather than "deleted
 * and reused".
 */
async function stageSuppliedBinary(src, stagingDir, destBase) {
  let lastErr = null;
  for (let attempt = 0; attempt < STAGE_ATTEMPTS; attempt += 1) {
    // First attempt keeps the predictable name (so the failure is diagnosable);
    // retries are unguessable, which is what defeats a pre-planted path.
    const suffix = attempt === 0 ? '' : `.${crypto.randomUUID()}`;
    const candidate = path.join(stagingDir, `${destBase}.${process.pid}${suffix}.part`);
    try {
      await fsp.copyFile(src, candidate, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        lastErr = err;
        continue; // occupied/planted path: pick a fresh random name, never overwrite
      }
      throw stageCopyError(src, candidate, err);
    }
    let srcSize;
    let copySize;
    try {
      srcSize = (await fsp.stat(src)).size;
      copySize = (await fsp.stat(candidate)).size;
    } catch (err) {
      try { fs.rmSync(candidate, { force: true }); } catch (_) { /* ignore */ }
      throw stageCopyError(src, candidate, err);
    }
    if (srcSize !== copySize) {
      // A short copy (ENOSPC mid-write, source changing under us) still exists
      // on disk and would be probed and promoted as the runnable binary.
      try { fs.rmSync(candidate, { force: true }); } catch (_) { /* ignore */ }
      throw new ProvisionError(
        'invalid-binary',
        `copy of --server-binary ${src} is ${copySize} bytes but the source is ${srcSize}; ` +
        'the copy is incomplete and was discarded',
        { source: src }
      );
    }
    return candidate;
  }
  throw stageCopyError(src, path.join(stagingDir, `${destBase}.${process.pid}.part`), lastErr);
}

function stripProvenance(file) {
  // Reuse the sidecar helper (single implementation of the MOTW / quarantine
  // strip), else degrade to a direct ADS removal. On Windows a downloaded file
  // carries Zone.Identifier and SmartScreen re-gates the image on every start
  // until it is stripped; the caller has already verified the bytes.
  try {
    const si = require('../utils/sidecar-installer');
    if (si && typeof si.stripProvenance === 'function') return si.stripProvenance(file);
  } catch (_) { /* fall through */ }
  try {
    if (process.platform === 'win32') fs.rmSync(`${file}:Zone.Identifier`, { force: true });
    if (process.platform === 'darwin') {
      try { require('child_process').execFileSync('xattr', ['-d', 'com.apple.quarantine', file], { stdio: 'ignore' }); } catch (_) { /* absent */ }
    }
  } catch (_) { /* best effort */ }
  return undefined;
}

function parseDigest(asset) {
  const raw = asset && (asset.digest || asset.sha256);
  if (!raw || typeof raw !== 'string') return null;
  const m = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(raw.trim());
  return m ? m[1].toLowerCase() : null;
}

// Follow redirects with fetch(); GitHub release assets redirect to a CDN, and a
// plain fetch() follows them for us. Streamed to disk so a 166-208 MB asset
// never lands in memory.
async function defaultDownload(url, dest, options = {}) {
  const timeoutMs = options.timeoutMs || 600000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'ai-or-die-service-provisioner' },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new ProvisionError('network', `download failed: HTTP ${res.status} for ${url}`);
    }
    // 'wx' never follows or truncates a pre-existing file: the staging path is
    // predictable (`<asset>.<pid>.part`), so a plant/symlink there must fail the
    // download rather than receive 166 MB of unverified bytes.
    const body = res.body;
    const expected = Number(options.expectedSize || 0);
    if (body && typeof body.pipeTo === 'function') {
      const out = fs.createWriteStream(dest, { mode: 0o755, flags: 'wx' });
      // web stream -> node stream
      const { Readable } = require('stream');
      await new Promise((resolve, reject) => {
        Readable.fromWeb(body).on('error', reject).pipe(out)
          .on('finish', resolve)
          .on('error', reject);
      });
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(dest, buf, { mode: 0o755, flag: 'wx' });
    }
    // A body that ends early without a stream error still fires 'finish'. The
    // release advertises the exact byte count, so compare it: a truncated SEA
    // hashes fine only if the digest is also missing, and it must never be
    // promoted just because nothing complained.
    if (expected > 0) {
      const actual = (await fsp.stat(dest)).size;
      if (actual !== expected) {
        throw new ProvisionError(
          'network',
          `download of ${dest} is ${actual} bytes but the release says ${expected}; the file is truncated`
        );
      }
    }
    return dest;
  } finally {
    clearTimeout(timer);
  }
}

function defaultFetchReleases() {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get(GITHUB_RELEASES_API, {
      headers: { 'User-Agent': 'ai-or-die-service-provisioner', Accept: 'application/vnd.github+json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new ProvisionError('network', `releases request failed: HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('error', (err) => reject(new ProvisionError('network', `releases request failed: ${err.message}`)));
    req.setTimeout(20000, () => {
      try { req.destroy(); } catch (_) { /* ignore */ }
      reject(new ProvisionError('network', 'releases request timed out'));
    });
  });
}

function pickRelease(releases, wantVersion) {
  const list = Array.isArray(releases) ? releases : [];
  const usable = list.filter((r) => r && !r.draft && !r.prerelease);
  if (wantVersion) {
    const want = String(wantVersion).replace(/^v/, '');
    const exact = usable.find((r) => String(r.tag_name || '').replace(/^v/, '') === want);
    if (!exact) {
      throw new ProvisionError(
        'no-asset',
        `release v${want} not found among published releases (newest: ${usable.map((r) => r.tag_name).slice(0, 3).join(', ') || 'none'})`
      );
    }
    return exact;
  }
  return usable[0] || null;
}

function assertRunnableBinary(binPath, options = {}) {
  // A .js file is NOT a valid server binary: the supervisor execs this path
  // directly (no node in front), so shipping a script here produced the
  // "server exited before READY" death loop. Probe it before installing.
  if (/\.(c?js|mjs|json)$/i.test(binPath)) {
    throw new ProvisionError(
      'invalid-binary',
      `${binPath} is a JavaScript file, not a runnable server binary; ` +
      'pass --server-binary <path-to-exe> instead'
    );
  }
  // Verification is skipped in unit tests and on hosts where executing the
  // freshly written file is impossible; the shape check above still applies.
  if (options.verify === false) return { version: null, skipped: true };
  const execFileSyncImpl = options.execFileSync || execFileSync;
  try {
    const out = String(execFileSyncImpl(binPath, ['--version'], {
      encoding: 'utf8',
      timeout: options.timeoutMs || 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) || '').trim();
    return { version: out.split(/\r?\n/)[0] || null };
  } catch (err) {
    throw new ProvisionError(
      'invalid-binary',
      `${binPath} does not run (${(err && err.message) || 'exec failed'}); ` +
      'expecting a published ai-or-die server binary',
      { stderr: err && err.stderr ? String(err.stderr).slice(0, 400) : undefined }
    );
  }
}

/**
 * Ensure STABLE_SERVER_BIN exists and is runnable.
 *
 * @returns {{provisioned: boolean, path: string, version: string|null,
 *            sha256: string|null, verified: 'digest'|'local'|'supplied'|'existing',
 *            releaseTag: string|null}}
 */
async function provisionServerBinary(options = {}) {
  const dest = options.dest || STABLE_SERVER_BIN;
  const stagingDir = options.stagingDir || path.join(path.dirname(dest), '..', 'staging');
  const logger = options.logger || console;
  const offline = !!options.offline;
  const serverBinaryPath = options.serverBinaryPath || null;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // 1. Operator-supplied binary.
  if (serverBinaryPath) {
    const src = path.resolve(serverBinaryPath);
    if (!fs.existsSync(src)) {
      throw new ProvisionError('invalid-binary', `--server-binary not found: ${src}`);
    }
    // Validate the SOURCE cheaply (a .js path is rejected without touching
    // anything), then validate the COPY: the source can change between the two
    // reads, and the copy is what the service will exec.
    assertRunnableBinary(src, { ...options, verify: false });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Copy through a temp file on the destination volume and rename: a failed
    // or interrupted copy must not destroy the working binary already at
    // `dest` (that is the binary the installed task launches).
    fs.mkdirSync(stagingDir, { recursive: true });
    let tmpSupply = null;
    let probe;
    try {
      // Exclusive staging copy: never delete-and-reuse a predictable path.
      tmpSupply = await stageSuppliedBinary(src, stagingDir, path.basename(dest));
      if (process.platform !== 'win32') { try { await fsp.chmod(tmpSupply, 0o755); } catch (_) {} }
      stripProvenance(tmpSupply);
      probe = assertRunnableBinary(tmpSupply, options);
      await promoteBinary(tmpSupply, dest);
    } finally {
      // Only ever remove the file we created; a planted file at another
      // candidate name is left for the operator to inspect.
      try { if (tmpSupply && fs.existsSync(tmpSupply)) fs.rmSync(tmpSupply, { force: true }); } catch (_) { /* ignore */ }
    }
    if (process.platform !== 'win32') { try { await fsp.chmod(dest, 0o755); } catch (_) {} }
    const sha256 = await sha256File(dest);
    return { provisioned: true, path: dest, version: probe.version, sha256, verified: 'supplied', releaseTag: null };
  }

  // 2. Already in place (reinstall) — keep it, it is what the updater manages.
  if (options.reuseExisting !== false && fs.existsSync(dest) && options.force !== true) {
    let existing = null;
    try { existing = assertRunnableBinary(dest, options); } catch (_) { existing = null; }
    if (existing) {
      let sha256 = null;
      try { sha256 = await sha256File(dest); } catch (_) { /* ignore */ }
      return {
        provisioned: false,
        path: dest,
        version: existing.version,
        sha256,
        verified: 'existing',
        releaseTag: options.existingReleaseTag || null,
      };
    }
    try { logger.warn?.(`service install: existing ${dest} is not runnable; re-provisioning`); } catch (_) {}
  }

  if (offline) {
    throw new ProvisionError(
      'offline',
      `--offline was given but ${dest} is missing or not runnable; ` +
      'download it once with `ai-or-die service install --server-binary <path>` ' +
      'or drop the binary at that path and retry'
    );
  }

  // 3. Download the pinned release.
  const assetName = assetNameFor(platform, arch);
  const fetchReleases = options.fetchReleases || defaultFetchReleases;
  const releases = await fetchReleases();
  const release = pickRelease(releases, options.releaseVersion);
  if (!release) throw new ProvisionError('no-asset', 'no published release found on GitHub');
  const tag = String(release.tag_name || '');
  const asset = (release.assets || []).find((a) => a && a.name === assetName);
  if (!asset) {
    throw new ProvisionError(
      'no-asset',
      `release ${tag} has no asset named ${assetName} ` +
      `(assets: ${(release.assets || []).map((a) => a.name).join(', ') || 'none'})`
    );
  }
  const want = parseDigest(asset);
  fs.mkdirSync(stagingDir, { recursive: true });
  const tmp = path.join(stagingDir, `${assetName}.${process.pid}.part`);
  const download = options.download || defaultDownload;
  try {
    try { logger.log?.(`  downloading ${assetName} from ${tag} (${Math.round((asset.size || 0) / 1048576)} MB)`); } catch (_) {}
    if (!want && options.allowUndigested !== true) {
      // No digest in the release metadata means the bytes cannot be
      // authenticated at all. Promoting them would make unverified network
      // content executable; refuse and say which escape hatch exists.
      throw new ProvisionError(
        'checksum-mismatch',
        `release ${tag} publishes no sha256 digest for ${assetName}, so the download ` +
        'cannot be verified; upgrade the ai-or-die package, pass --server-binary <path> ' +
        'with a trusted build, or set AIORDIE_ALLOW_UNDIGESTED_SERVER=1 to accept it unverified'
      );
    }
    await download(asset.browser_download_url, tmp, {
      ...options,
      // Advisory only (a proxy can still lie), but it catches the common
      // truncated-transfer case before paying for a full sha256 pass.
      expectedSize: asset.size,
    });
    // Byte count check belongs HERE, not only in defaultDownload(): the
    // downloader is an injectable seam, and a custom one must not be able to
    // hand a truncated payload to the promote step.
    const expectedSize = Number(asset.size || 0);
    if (expectedSize > 0) {
      const actualSize = (await fsp.stat(tmp)).size;
      if (actualSize !== expectedSize) {
        throw new ProvisionError(
          'checksum-mismatch',
          `downloaded ${assetName} is ${actualSize} bytes but the release says ${expectedSize}; ` +
          'the transfer was truncated'
        );
      }
    }
    const actual = await sha256File(tmp);
    if (want && actual !== want) {
      throw new ProvisionError(
        'checksum-mismatch',
        `checksum mismatch for ${assetName}: got ${actual}, release digest is ${want}`
      );
    }
    stripProvenance(tmp);
    if (process.platform !== 'win32') { try { await fsp.chmod(tmp, 0o755); } catch (_) {} }
    // Verify it actually runs BEFORE promoting (a truncated SEA still hashes
    // fine if the digest matched a bad upload — this catches that class).
    const probe = assertRunnableBinary(tmp, options);
    await promoteBinary(tmp, dest);
    return {
      provisioned: true,
      path: dest,
      version: probe.version,
      sha256: actual,
      verified: want ? 'digest' : 'local',
      releaseTag: tag,
    };
  } finally {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  promoteBinary,
  provisionServerBinary,
  assetNameFor,
  assertRunnableBinary,
  parseDigest,
  sha256File,
  stripProvenance,
  pickRelease,
  defaultDownload,
  ProvisionError,
  ASSET_MATRIX,
  // Re-exported so callers do not have to know the matrix or the owner/repo.
  GITHUB_OWNER,
  GITHUB_REPO,
};
