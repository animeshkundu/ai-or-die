'use strict';

// MeshManager — permanent reachability over a Tailscale tailnet via the
// ai-or-die-mesh sidecar (tsnet in USERSPACE: no kernel TUN, no admin, no system
// service). Only ai-or-die's own port joins the mesh; the rest of the machine
// stays off it. Mirrors TunnelManager's lifecycle (detect → start → backoff →
// stop) so bin/ai-or-die.js supervises it like the dev tunnel. Verified E2E:
// the sidecar enrolls and reverse-proxies the local port to <host>.ts.net.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const URL_TIMEOUT_MS = 60000;          // enroll + name can take ~30s on first run
const STABILITY_THRESHOLD_MS = 60000;  // 60s up = reset retry budget
const MIN_RESTART_DELAY_MS = 1000;
const MAX_RESTART_DELAY_MS = 30000;
const MAX_RETRIES = 10;
const MESH_PEERS_JSON_MAX = 256 * 1024;
// The sidecar announces MESH-EGRESS once at spawn, but a consumer treats
// egress.json stale past a short TTL (~120s). Re-stamp its updatedAt on this
// cadence while the sidecar lives so a healthy egress never looks stale.
const MESH_EGRESS_REFRESH_MS = 30000;
// Auto-refresh cadence for the sidecar binary (newer Tailscale client). Six
// hours keeps tailnet crypto fresh without release-API hammering; the floor
// stops a mis-set env from hot-looping GitHub. Off via AIORDIE_MESH_NO_REFRESH.
const MESH_REFRESH_INTERVAL_MS = 6 * 3600 * 1000;
const MESH_REFRESH_MIN_INTERVAL_MS = 30 * 60 * 1000;

class MeshManager {
  constructor(options = {}) {
    this.port = options.port || 7777;          // the ai-or-die port to expose
    this.dev = options.dev || false;
    this.onUrl = options.onUrl || (() => {});
    this._proxyBearer = options.authToken || null;
    // Consume the key once and scrub secrets everywhere they could leak.
    this._authKey = options.authKey || process.env.AIORDIE_TS_AUTHKEY || null;
    delete process.env.AIORDIE_TS_AUTHKEY;
    delete process.env.AIORDIE_PROXY_BEARER;
    this._childEnv = { ...process.env };
    delete this._childEnv.AIORDIE_TS_AUTHKEY;
    delete this._childEnv.AIORDIE_PROXY_BEARER;

    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    this._appBase = process.platform === 'win32'
      ? path.join(localApp, 'ai-or-die')
      : path.join(os.homedir(), '.ai-or-die');
    this.stateDir = options.stateDir || path.join(this._appBase, 'ts-state');
    // The sidecar is LAUNCHED from a stable, hash-free path (ai-or-die-mesh[.exe])
    // so a single-file WDAC/AppLocker allow-list rule matches the executed image
    // across versions (ADR-0036). The installer verifies + replaces it in place.
    this._installer = options._installer || require('./utils/sidecar-installer');
    this.sidecar = options.sidecar || this._stableSidecarPath(this._appBase);
    this.hostname = (options.hostname || `aiordie-${os.hostname()}`).toLowerCase().replace(/[^a-z0-9-]/g, '');

    this.proc = null;
    this.dnsName = null;
    this.scheme = null;          // 'https' (edge TLS) or 'http' (degraded)
    this.backend = options.backend || `http://127.0.0.1:${this.port}`;  // mesh serves plaintext loopback
    this._lastError = null;
    this.stopping = false;
    this.retryCount = 0;
    this._totalRestarts = 0;
    this._stabilityTimer = null;
    this._restartDelayTimer = null;
    this._restartDelayResolve = null;
    this._stabilityThresholdMs = options._stabilityThresholdMs || STABILITY_THRESHOLD_MS;
    this._stdoutBuffer = '';
    this.peers = null;
    this._untaggedWarned = false;
    this._egress = null;
    this._egressRefreshTimer = null;
    // Auto-refresh state (newer sidecar / Tailscale client). Versions learn
    // from the child's MESH-VERSION line; the ref learns from provenance.
    this.tsVersion = null;
    this.sidecarHash = null;
    this.sidecarRef = null;
    try {
      const prov = this._installer.loadProvenance
        ? this._installer.loadProvenance(this.sidecar)
        : require('./utils/sidecar-installer').loadProvenance(this.sidecar);
      if (prov && prov.ref) this.sidecarRef = prov.ref;
    } catch (_) {}
    const rawRefresh = parseInt(process.env.AIORDIE_MESH_REFRESH_INTERVAL_MS, 10);
    // Floor both sources (operator input ≥30min; programmatic API ≥1s) so a
    // mis-set value can never hot-loop the releases API.
    this._refreshIntervalMs = Number.isFinite(Number(options.refreshIntervalMs)) && Number(options.refreshIntervalMs) > 0
      ? Math.max(Number(options.refreshIntervalMs), 1000)
      : (Number.isFinite(rawRefresh) ? Math.max(rawRefresh, MESH_REFRESH_MIN_INTERVAL_MS) : MESH_REFRESH_INTERVAL_MS);
    this._noRefresh = options.noRefresh || process.env.AIORDIE_MESH_NO_REFRESH === '1';
    this._fetch = options._fetch || null; // injectable (tests); else global fetch
    this._refreshTimer = null;
    this._refreshInFlight = false;
    this._refreshDisabled = false; // latched after a failed refresh+rollback
    this._refreshOverrideWarned = false;
  }

  /** Never throws — degrades to localhost/devtunnel on any failure. */
  async start() {
    console.log('\n  Connecting mesh (Tailscale userspace)...');
    this.stopping = false;
    this._startRefreshLoop();
    // Clear any egress.json left by a crashed/kill -9'd prior run BEFORE (re)spawn,
    // so a consumer can't route to a freed loopback port a local process squatted.
    this._deleteEgressFile();
    if (!fs.existsSync(this.sidecar)) {
      if (!(await this._ensureSidecar())) { this._printMissing(this._lastError); return; }
    }
    if (!this._authKey && !this._enrolled()) { this._printNotEnrolled(); return; }
    try { fs.mkdirSync(this.stateDir, { recursive: true }); } catch (_) {}
    await this._spawn();
  }

  /** Stable, hash-free sidecar path from the installer; safe fallback. */
  _stableSidecarPath(base) {
    try {
      return this._installer.stableSidecarPath();
    } catch (_) {
      const exe = process.platform === 'win32' ? 'ai-or-die-mesh.exe' : 'ai-or-die-mesh';
      return path.join(base, 'bin', exe);
    }
  }

  /** Download + verify the sidecar from the matching release. Best-effort. */
  async _ensureSidecar() {
    try {
      console.log('  [mesh] fetching sidecar binary...');
      await this._installer.ensureSidecar(this.sidecar);
      this._lastError = null;
      return fs.existsSync(this.sidecar);
    } catch (e) {
      this._lastError = e;
      if (this.dev) console.error('  [mesh] sidecar fetch failed:', e.message);
      return false;
    }
  }

  getStatus() {
    return {
      running: this.proc !== null && !this.stopping && !!this.dnsName,
      publicUrl: this.dnsName ? `${this.scheme}://${this.dnsName}` : null,
      peers: this.peers ? this.peers.peers : [],
      sidecar: {
        ref: this.sidecarRef,
        tsVersion: this.tsVersion,
        contentHash: this.sidecarHash,
        refreshDisabled: this._refreshDisabled,
      },
    };
  }

  peersFilePath() {
    return path.join(this._appBase, 'mesh', 'peers.json');
  }

  async stop() {
    this.stopping = true;
    this._stopCount = (this._stopCount || 0) + 1;
    this._stopRefreshLoop();
    this._deletePeersFile();
    this._deleteEgressFile();
    this._clearStabilityTimer();
    clearTimeout(this._restartDelayTimer);
    if (this._restartDelayResolve) { this._restartDelayResolve(); this._restartDelayResolve = null; }
    if (!this.proc) return;
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch (_) {} resolve(); }, 5000);
      this.proc.once('exit', () => { clearTimeout(t); resolve(); });
      try { this.proc.kill(); } catch (_) {}
    });
  }

  /** State dir already holds a node identity → no key needed. */
  _enrolled() {
    try { return fs.existsSync(path.join(this.stateDir, 'tailscaled.state')); } catch (_) { return false; }
  }

  _spawn() {
    return new Promise((resolve) => {
      const args = ['--port', String(this.port), '--backend', this.backend, '--hostname', this.hostname, '--statedir', this.stateDir];
      // Pass secrets only to the sidecar child; both are stripped from this
      // process + base child env before spawning.
      const env = { ...this._childEnv };
      if (this._authKey) env.TS_AUTHKEY = this._authKey;
      if (this._proxyBearer) env.AIORDIE_PROXY_BEARER = this._proxyBearer;
      this._stdoutBuffer = '';
      this.proc = spawn(this.sidecar, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; console.warn('  \x1b[33mMesh: no URL within 60s — check key/connectivity.\x1b[0m'); resolve(); } }, URL_TIMEOUT_MS);
      this.proc.stdout.on('data', (d) => {
        if (this.dev) process.stdout.write(`  [mesh] ${d}`);
        this._handleStdoutData(d, (line) => {
          if (/^MESH-NOCERT\b/.test(line)) this._printNoCert();
          const url = line.match(/^MESH-URL (https?):\/\/(\S+)/);
          if (url && !this.dnsName) {
            this.scheme = url[1];
            this.dnsName = url[2];
            this._authKey = null;
            this._startStabilityTimer();
            this.onUrl(`${this.scheme}://${this.dnsName}`);
            if (!done) { done = true; clearTimeout(timer); resolve(); }
          }
          if (/^MESH-NEEDLOGIN\b/.test(line)) {
            this._deletePeersFile();
            this._deleteEgressFile();
            this._printNotEnrolled();
            if (!done) { done = true; clearTimeout(timer); resolve(); }
          }
        });
      });
      this.proc.stderr.on('data', (d) => { if (this.dev) process.stderr.write(`  [mesh] ${d}`); });
      this.proc.on('error', (e) => { console.error(`  \x1b[31mmesh sidecar failed: ${e.message}\x1b[0m`); this.proc = null; if (!done) { done = true; clearTimeout(timer); resolve(); } });
      this.proc.on('exit', (code) => {
        this._clearStabilityTimer(); this.proc = null; this.dnsName = null; this._deletePeersFile(); this._deleteEgressFile();
        // Recover on any exit while wanted — a clean exit drops the tailnet
        // path just as surely as a crash. See tunnel-manager: exit code and
        // retry budget never gate automatic recovery.
        if (this._shouldAutoRestart()) this._restart();
      });
    });
  }

  _handleStdoutData(chunk, onLine) {
    try {
      this._stdoutBuffer += chunk.toString();
      const lines = this._stdoutBuffer.split('\n');
      this._stdoutBuffer = lines.pop() || '';
      // Bound the carry-over: a newline-less run longer than any legitimate line
      // (MESH-PEERS is capped well under this) is junk/log-spam — drop it so a
      // misbehaving child can't grow the buffer without limit.
      if (this._stdoutBuffer.length > MESH_PEERS_JSON_MAX) this._stdoutBuffer = '';
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        this._handleStdoutLine(line);
        if (onLine) onLine(line);
      }
    } catch (_) {}
  }

  _handleStdoutLine(line) {
    try {
      const ver = /^MESH-VERSION\s+(\S+)\s+(\S+)\s*$/.exec(line);
      if (ver) {
        // Unstamped local builds report `dev dev` — learn only real stamps so
        // status never presents unknown bytes as a version.
        if (ver[1] !== 'dev' && ver[2] !== 'dev') {
          this.tsVersion = ver[1];
          this.sidecarHash = ver[2];
        }
        return;
      }
      if (/^MESH-NEEDLOGIN\b/.test(line)) { this._deletePeersFile(); this._deleteEgressFile(); return; }
      if (/^MESH-EGRESS\b/.test(line)) { this._handleEgressLine(line); return; }
      if (/^MESH-UNTAGGED\b/.test(line)) { this._handleUntaggedLine(line); return; }
      const match = /^MESH-PEERS\s+(.+)$/.exec(line);
      if (!match) return;
      const raw = match[1];
      if (Buffer.byteLength(raw, 'utf8') > MESH_PEERS_JSON_MAX) {
        if (this.dev) console.debug('  [mesh] ignoring oversized MESH-PEERS payload');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        return;
      }
      const normalized = this._validatePeersPayload(parsed);
      if (!normalized) return;
      this.peers = normalized;
      // Recovered: tagged peers are visible again, so re-arm the untagged warning.
      if (normalized.peers.length > 0) this._untaggedWarned = false;
      this._writePeersFile(normalized);
    } catch (_) {}
  }

  _validatePeersPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const self = payload.self;
    if (!self || typeof self !== 'object' || Array.isArray(self)) return null;
    if (typeof self.hostname !== 'string' || typeof self.dnsName !== 'string') return null;
    if (!Array.isArray(payload.peers)) return null;
    const peers = [];
    for (const p of payload.peers) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
      if (typeof p.hostname !== 'string' || typeof p.dnsName !== 'string' || typeof p.online !== 'boolean') continue;
      peers.push({ hostname: p.hostname, dnsName: p.dnsName, online: p.online });
    }
    return { self: { hostname: self.hostname, dnsName: self.dnsName }, peers };
  }

  _writePeersFile(snapshot) {
    const file = this.peersFilePath();
    const dir = path.dirname(file);
    const tmp = path.join(dir, `peers.json.${process.pid}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        self: snapshot.self,
        peers: snapshot.peers,
      }), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    } catch (_) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    }
  }

  _deletePeersFile() {
    this.peers = null;
    try { fs.rmSync(this.peersFilePath(), { force: true }); } catch (_) {}
  }

  egressFilePath() {
    return path.join(this._appBase, 'mesh', 'egress.json');
  }

  // Parse `MESH-EGRESS <url> <token>` and persist the loopback CONNECT-proxy
  // endpoint + local secret for a same-box conductor (github-router) to consume.
  // Only a loopback http URL is ever accepted; the token is a local credential.
  _handleEgressLine(line) {
    const m = /^MESH-EGRESS\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (!m) return;
    const url = m[1];
    const token = m[2];
    let u;
    try { u = new URL(url); } catch (_) { return; }
    if (u.protocol !== 'http:') return;
    const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
    // Only a numeric loopback literal — never `localhost`, whose resolution a
    // consumer's DNS/hosts config could rebind off-host.
    if (host !== '127.0.0.1' && host !== '::1') return;
    if (!token || /\s/.test(token)) return;
    this._egress = { url, token };
    this._writeEgressFile(url, token);
    this._startEgressRefresh();
  }

  _writeEgressFile(url, token) {
    const file = this.egressFilePath();
    const dir = path.dirname(file);
    // Random, exclusive-create tmp so a pre-planted symlink at a predictable path
    // can't redirect the write (TOCTOU / symlink clobber).
    const tmp = path.join(dir, `egress.json.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        pid: this.proc ? this.proc.pid : process.pid,
        updatedAt: Date.now(),
        url,
        token,
      }), { mode: 0o600, flag: 'wx' });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    } catch (_) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    }
  }

  // Keep egress.json's updatedAt fresh while the sidecar is alive. Without this a
  // consumer's freshness TTL rejects the (write-once) egress after ~2 min of
  // uptime and the mesh silently fails closed. Stops itself once the sidecar exits.
  _startEgressRefresh() {
    if (this._egressRefreshTimer) return;
    this._egressRefreshTimer = setInterval(() => this._refreshEgressTick(), MESH_EGRESS_REFRESH_MS);
    if (this._egressRefreshTimer.unref) this._egressRefreshTimer.unref();
  }

  _refreshEgressTick() {
    if (this.proc && this._egress) this._writeEgressFile(this._egress.url, this._egress.token);
    else this._stopEgressRefresh();
  }

  _stopEgressRefresh() {
    if (this._egressRefreshTimer) { clearInterval(this._egressRefreshTimer); this._egressRefreshTimer = null; }
  }

  _deleteEgressFile() {
    this._egress = null;
    this._stopEgressRefresh();
    try { fs.rmSync(this.egressFilePath(), { force: true }); } catch (_) {}
  }

  // Actionable one-shot hint: tailnet peers exist but none carry tag:aiordie, so
  // fleet discovery will surface nothing until they are tagged. The exact failure
  // this whole path guards against — surfaced, not silent.
  _handleUntaggedLine(line) {
    if (this._untaggedWarned) return;
    const m = /^MESH-UNTAGGED\s+(\S+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) return;
    this._untaggedWarned = true;
    const total = m[2];
    console.log(`\n  \x1b[33mMesh: ${total} tailnet device(s) visible but \x1b[1m0 tagged tag:aiordie\x1b[0m\x1b[33m.\x1b[0m`);
    console.log('    Fleet discovery stays EMPTY until instances carry the tag:');
    console.log('    • enroll with a REUSABLE + TAGGED key (tag:aiordie), or retag each device in the admin console;');
    console.log('    • ensure the ACL allows your conductor → tag:aiordie on the served ports (docs/mesh-acl.example.hujson).');
  }

  _printMissing(err) {
    const code = err && err.code;
    const map = {
      'unsupported-platform': `Mesh: no sidecar build for this platform (${err && err.message}).`,
      'lock-unfinalized': 'Mesh: sidecar checksum missing from this build — upgrade ai-or-die.',
      'assets-missing': 'Mesh: sidecar binaries for this build are not published yet — try again shortly.',
      'network': `Mesh: could not download the sidecar — ${err && err.message}.`,
      'checksum-mismatch': 'Mesh: sidecar checksum mismatch — refusing to run an unverified binary.',
      'locked-binary': `Mesh: ${err && err.message} — stop any running ai-or-die mesh and retry.`,
    };
    const line = (code && map[code]) || 'Mesh: sidecar not installed.';
    console.log(`\n  \x1b[33m${line}\x1b[0m  See docs/specs/mesh.md.`);
    console.log('  Continuing on localhost/devtunnel.\n');
  }

  _printNoCert() {
    console.log('\n  \x1b[33mMesh: tailnet HTTPS certificates are not enabled — serving plain http.\x1b[0m');
    console.log('    Remote microphone (voice) and PWA install need a secure context (https).');
    console.log('    Enable it once: \x1b[1mhttps://login.tailscale.com/admin/dns\x1b[0m → HTTPS Certificates.');
  }

  _printNotEnrolled() {
    const ex = process.platform === 'win32' ? '$env:AIORDIE_TS_AUTHKEY="<key>"; ai-or-die --mesh' : 'AIORDIE_TS_AUTHKEY=<key> ai-or-die --mesh';
    console.log('\n  \x1b[1m\x1b[33mMesh: NOT ENROLLED\x1b[0m — enroll once:');
    console.log('    1. Reusable, tagged key (NOT ephemeral): https://login.tailscale.com/admin/settings/keys');
    console.log(`    2. \x1b[1m${ex}\x1b[0m`);
    console.log('    3. Revoke the key once the machine appears in the console.');
    console.log('  Continuing on localhost/devtunnel meanwhile.\n');
  }

  _startStabilityTimer() {
    this._clearStabilityTimer();
    this._stabilityTimer = setTimeout(() => { this.retryCount = 0; }, this._stabilityThresholdMs);
    if (this._stabilityTimer.unref) this._stabilityTimer.unref();
  }
  _clearStabilityTimer() { if (this._stabilityTimer) { clearTimeout(this._stabilityTimer); this._stabilityTimer = null; } }

  /**
   * Whether a sidecar exit should trigger automatic recovery.
   * Only intentional shutdown gates recovery — never the exit code.
   * The refresh swap holds recovery while it owns the lifecycle (it
   * respawns explicitly after the atomic replace; a concurrent backoff
   * respawn would double-spawn and fight the rollback renames).
   */
  _shouldAutoRestart() {
    return !this.stopping && !this._refreshHold;
  }

  async _restart() {
    this._totalRestarts++; this.retryCount++;
    // Never quits: keep backing off at the capped delay so an unattended
    // daemon recovers on its own. Manual intervention is never required
    // to resume automatic recovery.
    if (this.retryCount > MAX_RETRIES) {
      console.warn(`  [mesh] Still retrying after ${this.retryCount} attempts (lifetime restarts ${this._totalRestarts}) — backoff capped, recovery continues.`);
    }
    const delay = Math.min(2 ** (this.retryCount - 1) * MIN_RESTART_DELAY_MS, MAX_RESTART_DELAY_MS);
    await new Promise((resolve) => { this._restartDelayResolve = resolve; this._restartDelayTimer = setTimeout(resolve, delay); if (this._restartDelayTimer.unref) this._restartDelayTimer.unref(); });
    this._restartDelayResolve = null;
    // Re-check after the delay: a stop(), a refresh swap, or another spawn may
    // have happened while waiting — never double-spawn or resurrect a stopped
    // mesh. (The exit handler consults _shouldAutoRestart, but a _restart
    // already past that gate must still stand down here.)
    if (this.stopping || this._refreshHold || this.proc) return;
    try {
      await this._spawn();
    } catch (err) {
      console.error(`  [mesh] Spawn failed: ${err && err.message}. Will retry with backoff.`);
    }
  }

  // ---- sidecar auto-refresh (newer Tailscale client) -----------------------
  // Polls the mesh-* releases on a slow cadence; when a newer build exists it
  // is downloaded + manifest-verified to temp, the sidecar is stopped, the
  // stable path is swapped atomically (previous kept as .prev for rollback),
  // and the sidecar is respawned — reconnecting with the persisted tailnet
  // identity (no new auth key). A bad build restores .prev once, then latches
  // refresh off for the session. Never throws into the caller.

  _startRefreshLoop() {
    if (this._refreshTimer || this._noRefresh) return;
    this._refreshTimer = setInterval(() => {
      this._refreshTick().catch(() => {});
    }, this._refreshIntervalMs);
    if (this._refreshTimer.unref) this._refreshTimer.unref();
  }

  _stopRefreshLoop() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
  }

  _refreshOverridden() {
    return !!(process.env.AIORDIE_MESH_REF || process.env.AIORDIE_MESH_VERSION);
  }

  // Resolve the ref this binary was verified against: live provenance first.
  // For pre-feature installs (bytes but no record), hash the bytes against
  // the SHIPPED lock — a match proves the bytes are exactly that release.
  // Bytes matching neither are `unknown` (forces one refresh check), never
  // the lock hash as `current` (that would claim newness for old bytes and
  // skip the refresh forever).
  _currentSidecarRef() {
    if (this.sidecarRef) return this.sidecarRef;
    try {
      const prov = this._installer.loadProvenance
        ? this._installer.loadProvenance(this.sidecar)
        : null;
      if (prov && prov.ref) {
        this.sidecarRef = prov.ref;
        return prov.ref;
      }
    } catch (_) {}
    try {
      const lock = this._installer.loadLock ? this._installer.loadLock() : null;
      const assetName = this._installer.assetName
        ? this._installer.assetName()
        : require('./utils/sidecar-installer').assetName();
      const want = lock && lock.assets && assetName && lock.assets[assetName];
      if (want && fs.existsSync(this.sidecar)) {
        const h = crypto.createHash('sha256');
        h.update(fs.readFileSync(this.sidecar));
        if (h.digest('hex').toLowerCase() === String(want).toLowerCase() && lock.contentHash) {
          this.sidecarRef = `mesh-${lock.contentHash}`;
          return this.sidecarRef;
        }
      }
    } catch (_) {}
    return null;
  }

  async _refreshTick() {
    if (this.stopping || this._refreshInFlight || this._refreshDisabled || this._noRefresh) return null;
    if (this._refreshOverridden()) {
      if (!this._refreshOverrideWarned) {
        this._refreshOverrideWarned = true;
        if (this.dev) console.log('  [mesh] auto-refresh skipped (AIORDIE_MESH_REF/VERSION pins a dev ref)');
      }
      return null;
    }
    this._refreshInFlight = true;
    try {
      const installer = this._installer;
      const listReleases = installer.listMeshReleases
        || require('./utils/sidecar-installer').listMeshReleases;
      const releases = await listReleases(this._fetch || undefined);
      const newest = releases && releases[0];
      if (!newest) return { checked: true, update: false };
      const current = this._currentSidecarRef();
      if (current && newest.tag === current) return { checked: true, update: false };
      if (this.dev) console.log(`  [mesh] newer sidecar available: ${newest.tag} (running ${current || 'unknown'}) — refreshing...`);
      else console.log(`  [mesh] newer sidecar available (${newest.tag}) — refreshing and reconnecting...`);
      return await this._refreshToRef(newest.tag);
    } catch (err) {
      if (this.dev) console.error('  [mesh] refresh check failed:', err && err.message);
      return { checked: false, error: err && err.message };
    } finally {
      this._refreshInFlight = false;
    }
  }

  // Download + verify + stop + atomic swap + respawn. Returns a result object,
  // never throws.
  async _refreshToRef(tag) {
    const installer = this._installer;
    const fetchSidecarRef = installer.fetchSidecarRef
      || require('./utils/sidecar-installer').fetchSidecarRef;
    const tmp = `${this.sidecar}.${process.pid}.refresh`;
    let verified = null;
    try {
      verified = await fetchSidecarRef(tag, tmp, { fetch: this._fetch || undefined });
    } catch (err) {
      if (this.dev) console.error('  [mesh] refresh download/verify failed:', err && err.message);
      else console.warn(`  [mesh] sidecar refresh deferred (${err && err.code ? err.code : 'verify failed'}) — still running ${this.sidecarRef || 'current build'}`);
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
      return { checked: true, update: true, refreshed: false, reason: (err && err.code) || 'fetch_failed' };
    }
    // The download is unbounded in time: the operator may have stopped the
    // mesh while it ran. Never resurrect — leave stopped, drop the temp.
    if (this.stopping) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
      return { checked: true, update: true, refreshed: false, reason: 'stopped' };
    }
    // Snapshot current provenance for rollback + sidecar.json update.
    let prevInfo = null;
    try {
      prevInfo = installer.loadProvenance
        ? installer.loadProvenance(this.sidecar)
        : require('./utils/sidecar-installer').loadProvenance(this.sidecar);
    } catch (_) {}
    const oldRef = this.sidecarRef || (prevInfo && prevInfo.ref) || null;
    const prevPath = `${this.sidecar}.prev`;
    // Hold exit-handler recovery while the swap owns the lifecycle (see
    // _shouldAutoRestart); released in the finally below.
    this._refreshHold = true;
    // Stop first: on Windows the running .exe is locked and cannot be renamed.
    // Generation check: our stop() adds exactly one; an operator stop racing
    // us adds another — in which case their intent wins (no respawn).
    const stopCount = this._stopCount || 0;
    await this.stop();
    // Our stop() adds exactly one generation and leaves stopping=true; an
    // operator stop racing us adds another — in which case their intent wins:
    // leave everything stopped (no flag reset, no respawn, no timer re-arm).
    if ((this._stopCount || 0) !== stopCount + 1) {
      this._refreshHold = false;
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
      return { checked: true, update: true, refreshed: false, reason: 'stopped' };
    }
    this.stopping = false; // refresh owns the lifecycle from here (stop() set it)
    this._startRefreshLoop(); // stop() cleared it; re-arm (no-op if disabled)
    try {
      try {
        try { fs.rmSync(prevPath, { force: true }); } catch (_) {}
        fs.renameSync(this.sidecar, prevPath);
      } catch (err) {
        // Could not park the running binary (AV scan / still mapped): put the
        // old binary back in service rather than stranding the mesh down.
        console.warn(`  [mesh] refresh aborted during swap (${err && err.code || err}); restarting current build`);
        try { await this._spawn(); } catch (_) {}
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        return { checked: true, update: true, refreshed: false, reason: 'swap_failed' };
      }
      try {
        fs.renameSync(tmp, this.sidecar);
        if (process.platform !== 'win32') { try { fs.chmodSync(this.sidecar, 0o755); } catch (_) {} }
      } catch (err) {
        try { fs.renameSync(prevPath, this.sidecar); } catch (_) {}
        try { await this._spawn(); } catch (_) {}
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        return { checked: true, update: true, refreshed: false, reason: 'swap_failed' };
      }
      const writeProvenance = installer.writeProvenance
        || require('./utils/sidecar-installer').writeProvenance;
      try {
        writeProvenance(this.sidecar, {
          ref: tag,
          contentHash: String(tag).replace(/^mesh-/, ''),
          sha256: (verified && verified.sha256) || null,
        });
      } catch (_) {}
      this.sidecarRef = tag;
      // Versions re-learn from the new child's MESH-VERSION line; until then
      // the last-good values stand (no null flap for status pollers).
      this.dnsName = null;
      await this._spawn();
      // Verify the new build actually reconnected. A live proc without a URL
      // (e.g. NEEDLOGIN while the operator enrolls) is left alone — the
      // binary works. A dead proc with no URL means a bad build: restore
      // .prev once, then latch refresh off so we never flap.
      if (this.dnsName) {
        console.log(`  [mesh] refreshed to ${tag} and reconnected (${this.scheme}://${this.dnsName})`);
        return { checked: true, update: true, refreshed: true, tag };
      }
      if (this.proc) {
        console.log(`  [mesh] refreshed to ${tag}; sidecar running, awaiting enrollment/URL`);
        return { checked: true, update: true, refreshed: true, tag, reconnecting: true };
      }
      console.error(`  [mesh] refreshed build ${tag} failed to start — rolling back to previous build`);
      let restored = false;
      try { fs.renameSync(prevPath, this.sidecar); restored = true; } catch (_) {}
      try {
        writeProvenance(this.sidecar, prevInfo || { ref: oldRef, contentHash: null, sha256: null });
      } catch (_) {}
      if (oldRef) this.sidecarRef = oldRef;
      this._refreshDisabled = true;
      await this._spawn();
      if (restored && this.dnsName) console.log(`  [mesh] rolled back and reconnected (${this.scheme}://${this.dnsName}); auto-refresh paused for this session`);
      else if (restored) console.error('  [mesh] rollback respawned but no URL yet — automatic recovery continues');
      else console.error('  [mesh] rollback restore failed — automatic recovery continues on the refreshed binary');
      return { checked: true, update: true, refreshed: false, reason: restored ? 'rolled_back' : 'rollback_failed', tag };
    } finally {
      this._refreshHold = false;
    }
  }
}

module.exports = {
  MeshManager,
  _constants: { URL_TIMEOUT_MS, MAX_RETRIES, MESH_REFRESH_INTERVAL_MS, MESH_REFRESH_MIN_INTERVAL_MS },
};
