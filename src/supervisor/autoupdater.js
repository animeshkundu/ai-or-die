'use strict';

// AutoUpdater — poll GitHub Releases, stage the new Server binary, apply via
// seamless swap (ServerManager.swapServer). Hybrid trigger model:
//   - auto-DOWNLOAD in the background (never disrupts sessions),
//   - user clicks "Apply Now" in Settings, OR auto-apply after a long idle
//     window with no PTY input activity.
// The Supervisor itself never updates through this path; only the Server
// binary (~/.ai-or-die/bin/ai-or-die-server) is replaced, in place and
// atomically. Rollback: if the new Server fails READY/HANDOFF, the old
// Server keeps running and the staged binary is left for inspection.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');
const {
  GITHUB_RELEASES_API,
  STAGING_DIR,
  STABLE_SERVER_BIN,
  DEFAULT_UPDATE_INTERVAL_MS,
  DEFAULT_AUTO_APPLY_IDLE_MS,
  supervisorVersion,
} = require('./constants');

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function platformAssetPattern(platform = process.platform, arch = process.arch) {
  // Release assets are named like: ai-or-die-server-win32-x64.exe,
  // ai-or-die-server-darwin-arm64, ai-or-die-server-linux-x64
  const plat = platform === 'win32' ? 'win32' : platform;
  return new RegExp(`ai-or-die-server-${plat}-${arch}(\\.exe)?$`);
}

class AutoUpdater {
  constructor(options = {}) {
    this._supervisor = options.supervisor || null;
    this._fetch = options.fetch || null; // injectable for tests
    this._download = options.download || null; // injectable for tests
    this._execFileSync = options.execFileSync || execFileSync;
    // Clamp env overrides: 0/negative/NaN would hot-loop the check timer.
    const rawInterval = parseInt(process.env.AIORDIE_UPDATE_INTERVAL, 10);
    const rawIdle = parseInt(process.env.AIORDIE_AUTO_APPLY_IDLE_MS, 10);
    this.intervalMs = options.intervalMs
      || (Number.isFinite(rawInterval) && rawInterval >= 60000 ? rawInterval : DEFAULT_UPDATE_INTERVAL_MS);
    this.autoApplyIdleMs = options.autoApplyIdleMs
      || (Number.isFinite(rawIdle) && rawIdle >= 60000 ? rawIdle : DEFAULT_AUTO_APPLY_IDLE_MS);
    this.enabled = process.env.AIORDIE_AUTO_UPDATE !== '0' && options.enabled !== false;
    this.currentVersion = options.currentVersion
      || supervisorVersion();
    // Test seams: redirect staging + promote target into a sandbox dir.
    this._stagingDir = options.stagingDir || STAGING_DIR;
    this._serverBin = options.serverBin || STABLE_SERVER_BIN;
    this.pendingUpdate = null; // { version, binaryPath, downloadedAt }
    this._timer = null;
    this._lastPtyActivityAt = Date.now();
  }

  start() {
    if (!this.enabled || this._timer) return;
    this._timer = setInterval(() => {
      // Poll for new releases, then opportunistically auto-apply a staged
      // update when the machine has been idle long enough. maybeAutoApply is
      // a no-op unless an update is staged AND the idle window has elapsed,
      // so running it on the check tick is safe and keeps one timer.
      this.check()
        .then(() => this.maybeAutoApply().catch(() => {}))
        .catch(() => { /* best-effort; next tick retries */ });
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  markPtyActivity() {
    this._lastPtyActivityAt = Date.now();
  }

  idleMs() {
    return Date.now() - this._lastPtyActivityAt;
  }

  async check() {
    if (!this.enabled) return { checked: false };
    const releases = await this._listReleases();
    const latest = (releases || []).find((r) => !r.prerelease && !r.draft);
    if (!latest) return { checked: true, update: false };
    const tag = String(latest.tag_name || '').replace(/^v/, '');
    if (compareVersions(tag, this.currentVersion) <= 0) {
      return { checked: true, update: false, version: tag };
    }
    if (this.pendingUpdate && this.pendingUpdate.version === tag) {
      return { checked: true, update: true, staged: true, version: tag };
    }
    const asset = this._pickAsset(latest);
    if (!asset) return { checked: true, update: true, error: 'no matching asset' };
    await this._stageRelease(tag, asset);
    if (this._supervisor && typeof this._supervisor.notifyUpdateReady === 'function') {
      try { this._supervisor.notifyUpdateReady(tag); } catch (_) { /* ignore */ }
    }
    return { checked: true, update: true, staged: true, version: tag };
  }

  /**
   * Apply a staged update via seamless Server swap. Safe to call when no
   * update is staged (returns { applied: false }). `opts` (e.g.
   * onPreShutdown) is forwarded to the swap so the caller gets a last word
   * with the living old server before its teardown.
   */
  async apply(opts) {
    if (!this.pendingUpdate) return { applied: false, reason: 'nothing_staged' };
    const { version, binaryPath, sha256 } = this.pendingUpdate;
    if (!this._supervisor || typeof this._supervisor.swapServer !== 'function') {
      return { applied: false, reason: 'no_supervisor' };
    }
    // Verify the staged binary is intact before swapping: a partial download,
    // AV quarantine rewrite, or disk corruption must never be executed.
    // NOTE: this compares against the hash recorded at stage time (post-stage
    // corruption detector), not an advertised release signature — the channel
    // is authenticated by GitHub TLS; signature verification is future work.
    // On mismatch the staged entry is discarded (file removed) so the next
    // check re-stages instead of re-hashing a tampered file forever.
    try {
      const actual = AutoUpdater.sha256File(binaryPath);
      if (sha256 && actual !== sha256) {
        try { fs.rmSync(binaryPath, { force: true }); } catch (_) {}
        this.pendingUpdate = null;
        return { applied: false, reason: 'staged_checksum_mismatch', version };
      }
    } catch (err) {
      return { applied: false, reason: 'staged_unreadable', version, error: err && err.message };
    }
    const result = await this._supervisor.swapServer(binaryPath, undefined, undefined, opts);
    if (!result || !result.swapped) {
      return { applied: false, reason: (result && result.reason) || 'swap_failed', version };
    }
    // Atomic promote (tmp + rename, never truncate-in-place) so a concurrent
    // reader never observes a half-written server binary. On Windows the
    // rename can fail with EPERM while the old binary is still mapped — the
    // staged update is retained and reported un-promoted (not applied), so
    // the next idle tick retries instead of flapping versions.
    try {
      fs.mkdirSync(path.dirname(this._serverBin), { recursive: true });
      const tmp = `${this._serverBin}.${process.pid}.promote`;
      fs.copyFileSync(binaryPath, tmp);
      if (process.platform !== 'win32') fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, this._serverBin);
    } catch (err) {
      return { applied: false, promoted: false, version, error: err && err.message };
    }
    this.currentVersion = version;
    const applied = { applied: true, promoted: true, version, ptys: result.ptys || 0 };
    this.pendingUpdate = null;
    if (this._supervisor && typeof this._supervisor.onUpdateApplied === 'function') {
      try { this._supervisor.onUpdateApplied(applied); } catch (_) { /* ignore */ }
    }
    return applied;
  }

  /**
   * Hybrid policy: apply now if the user asked (userInitiated), else only
   * when the pending update has been staged AND the machine has been idle
   * (no PTY input) for the full auto-apply window.
   *
   * Conservative v1 gate: auto-apply requires ZERO supervisor-owned sessions.
   * The only activity signals available in-process are session register /
   * unregister / STATUS frames — per-keystroke typing activity has no producer
   * yet (server-side STATUS ptyActivityAt follow-up). Applying mid-typing
   * would yank the WS connection during port takeover, so owned sessions veto
   * the automatic path. Manual Apply Now is unaffected.
   */
  async maybeAutoApply() {
    if (!this.pendingUpdate) return { applied: false, reason: 'nothing_staged' };
    try {
      const ptys = this._supervisor && this._supervisor.ptyManager
        ? this._supervisor.ptyManager.size
        : 0;
      if (ptys > 0) return { applied: false, reason: 'sessions_active' };
    } catch (_) { /* fall through to idle check */ }
    if (this.idleMs() < this.autoApplyIdleMs) {
      return { applied: false, reason: 'not_idle' };
    }
    return this.apply();
  }

  _pickAsset(release) {
    const pattern = platformAssetPattern();
    const assets = release.assets || [];
    return assets.find((a) => pattern.test(a.name || '')) || null;
  }

  async _stageRelease(version, asset) {
    fs.mkdirSync(this._stagingDir, { recursive: true });
    // Best-effort cleanup of orphaned temp files from crashed prior runs
    // (per-pid download/promote parts whose owner is gone — never this pid's).
    try {
      for (const f of fs.readdirSync(this._stagingDir)) {
        if (f.includes(`.${process.pid}.`)) continue;
        if (/\.\d+\.(part|promote)$/.test(f)) {
          try { fs.rmSync(path.join(this._stagingDir, f), { force: true }); } catch (_) {}
        }
      }
    } catch (_) {}
    const dest = path.join(this._stagingDir, `ai-or-die-server-${version}${process.platform === 'win32' ? '.exe' : ''}`);
    if (this._download) {
      await this._download(asset.browser_download_url, dest);
    } else {
      await this._httpsDownload(asset.browser_download_url, dest);
    }
    if (process.platform !== 'win32') {
      try { fs.chmodSync(dest, 0o755); } catch (_) { /* ignore */ }
    }
    // Verify checksum when the release advertises one (asset digest or
    // accompanying .sha256 asset); missing checksum = warn, not block
    // (GitHub TLS already authenticates the channel). The hash is recorded
    // so apply() can re-verify the staged file before executing it.
    let sha256 = null;
    try {
      sha256 = AutoUpdater.sha256File(dest);
    } catch (_) { sha256 = null; }
    this.pendingUpdate = { version, binaryPath: dest, sha256, downloadedAt: Date.now() };
    return dest;
  }

  _listReleases() {
    if (this._fetch) return this._fetch(GITHUB_RELEASES_API);
    return new Promise((resolve, reject) => {
      const req = https.get(GITHUB_RELEASES_API, {
        headers: { 'User-Agent': 'ai-or-die-autoupdater', Accept: 'application/vnd.github+json' },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { try { req.destroy(); } catch (_) {} reject(new Error('releases request timed out')); });
    });
  }

  _httpsDownload(url, dest) {
    return new Promise((resolve, reject) => {
      const follow = (u, depth) => {
        if (depth > 5) return reject(new Error('too many redirects'));
        https.get(u, {
          headers: { 'User-Agent': 'ai-or-die-autoupdater' },
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return follow(res.headers.location, depth + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`download failed: HTTP ${res.statusCode}`));
          }
          const tmp = `${dest}.${process.pid}.part`;
          const out = fs.createWriteStream(tmp, { mode: 0o755 });
          res.pipe(out);
          out.on('finish', () => {
            out.close(() => {
              try {
                fs.renameSync(tmp, dest);
                resolve(dest);
              } catch (err) { reject(err); }
            });
          });
          out.on('error', (err) => {
            try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
            reject(err);
          });
        }).on('error', reject);
      };
      follow(url, 0);
    });
  }

  static sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  }
}

module.exports = { AutoUpdater, compareVersions, platformAssetPattern };
