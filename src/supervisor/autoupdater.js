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
    this.intervalMs = options.intervalMs
      || parseInt(process.env.AIORDIE_UPDATE_INTERVAL, 10)
      || DEFAULT_UPDATE_INTERVAL_MS;
    this.autoApplyIdleMs = options.autoApplyIdleMs
      || parseInt(process.env.AIORDIE_AUTO_APPLY_IDLE_MS, 10)
      || DEFAULT_AUTO_APPLY_IDLE_MS;
    this.enabled = process.env.AIORDIE_AUTO_UPDATE !== '0' && options.enabled !== false;
    this.currentVersion = options.currentVersion
      || require('../../package.json').version;
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
      this.check().catch(() => { /* best-effort; next tick retries */ });
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
    const { version, binaryPath } = this.pendingUpdate;
    if (!this._supervisor || typeof this._supervisor.swapServer !== 'function') {
      return { applied: false, reason: 'no_supervisor' };
    }
    const result = await this._supervisor.swapServer(binaryPath, undefined, undefined, opts);
    if (!result || !result.swapped) {
      return { applied: false, reason: (result && result.reason) || 'swap_failed', version };
    }
    try {
      fs.mkdirSync(path.dirname(this._serverBin), { recursive: true });
      fs.copyFileSync(binaryPath, this._serverBin);
      if (process.platform !== 'win32') fs.chmodSync(this._serverBin, 0o755);
    } catch (err) {
      return { applied: true, promoted: false, version, error: err && err.message };
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
   */
  async maybeAutoApply() {
    if (!this.pendingUpdate) return { applied: false, reason: 'nothing_staged' };
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
    // (GitHub TLS already authenticates the channel).
    this.pendingUpdate = { version, binaryPath: dest, downloadedAt: Date.now() };
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
