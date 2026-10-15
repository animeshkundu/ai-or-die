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
// Auto-update poll: converge the running sidecar to the build pinned by the
// installed npm lock, then check the mesh-* releases for a newer build
// (a Tailscale client bump always publishes one). 24h is enough — restart-time
// verify (start()) covers fresh launches; this covers long-lived daemons
// upgraded underneath via `npm i -g`. Jitter spreads fleet fetch; env override
// is a test seam. Floors stop a mis-set value hot-looping the releases API.
const MESH_UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;
const MESH_UPDATE_JITTER_MS = 15 * 60 * 1000;
const MESH_UPDATE_MIN_INTERVAL_MS = 30 * 60 * 1000;
// Persistent quarantine entries older than this are pruned (a build that was
// bad a month ago may be fine after operator intervention; and a newer build
// clears the slate on success anyway).
const QUARANTINE_TTL_MS = 30 * 24 * 3600 * 1000;

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
    // Auto-update state. ON by default; kill-switches AIORDIE_MESH_AUTO_UPDATE=0
    // (specific) and AIORDIE_AUTO_UPDATE=0 (existing global updater flag).
    this._updating = false;
    this._updateTimer = null;
    this._stagedHash = null;         // lock contentHash of the staged .new build
    this._activeHash = null;         // lock contentHash the stable build verified against
    this._lastUpdateCheck = null;
    this._lastUpdateResult = null;
    this._failedUpdateVersions = new Set();
    this._tickInFlight = false;
    this._stagedTier = null;         // 'lock' | 'release' — origin of the staged .new
    this._stagedExpectedSha = null;  // manifest sha for release-tier stages
    // Build identity, learned from the child's MESH-VERSION line and install
    // provenance (used by the release-freshness tier + status).
    this.tsVersion = null;
    this.sidecarHash = null;
    this.sidecarRef = null;
    try {
      const prov = this._installer.loadProvenance
        ? this._installer.loadProvenance(this.sidecar)
        : null;
      if (prov && prov.ref) this.sidecarRef = prov.ref;
    } catch (_) {}
    const rawInterval = parseInt(process.env.AIORDIE_MESH_UPDATE_INTERVAL_MS, 10);
    const optInterval = Number(options._updateIntervalMs);
    this._updateIntervalMs = Number.isFinite(optInterval) && optInterval > 0
      ? Math.max(optInterval, 1000)
      : (Number.isFinite(rawInterval) ? Math.max(rawInterval, MESH_UPDATE_MIN_INTERVAL_MS) : MESH_UPDATE_CHECK_MS);
    this._autoUpdateEnabled = options.autoUpdate !== false
      && process.env.AIORDIE_MESH_AUTO_UPDATE !== '0'
      && process.env.AIORDIE_AUTO_UPDATE !== '0';
    this._execFile = options._execFile || null; // injectable pre-flight runner (tests)
    this._fetch = options._fetch || null; // injectable releases fetch (tests)
  }

  /** Never throws — degrades to localhost/devtunnel on any failure. */
  async start() {
    console.log('\n  Connecting mesh (Tailscale userspace)...');
    this.stopping = false;
    this._updating = false;
    try {
      // Re-hydrate the persistent quarantine fast path (a bad build stays
      // stood down across restarts until a newer one succeeds).
      for (const k of Object.keys(this._readQuarantineFile())) this._failedUpdateVersions.add(k);
    } catch (_) {}
    // Clear any egress.json left by a crashed/kill -9'd prior run BEFORE (re)spawn,
    // so a consumer can't route to a freed loopback port a local process squatted.
    this._deleteEgressFile();
    // Activate a previously staged update while the image is free (prior sidecar
    // has exited at process start — on Windows a running .exe cannot be renamed).
    await this._promoteStagedIfValid();
    // Always verify: a stale binary must not survive `npm i -g` + restart.
    // ensureSidecar short-circuits with no network when the file already matches.
    if (!(await this._ensureSidecar())) { this._printMissing(this._lastError); return; }
    this._recordActiveHash();
    if (!this._authKey && !this._enrolled()) { this._printNotEnrolled(); this._startUpdateTimer(); return; }
    try { fs.mkdirSync(this.stateDir, { recursive: true }); } catch (_) {}
    await this._spawn();
    this._startUpdateTimer();
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
      if (this.dev) console.log('  [mesh] verifying sidecar binary...');
      await this._installer.ensureSidecar(this.sidecar);
      this._lastError = null;
      return fs.existsSync(this.sidecar);
    } catch (e) {
      this._lastError = e;
      if (this.dev) console.error('  [mesh] sidecar fetch failed:', e.message);
      return false;
    }
  }

  /** Best-effort promotion of a staged (.new) build. Never throws. */
  async _promoteStagedIfValid(promoteOpts) {
    try {
      if (typeof this._installer.promoteStagedSidecar !== 'function') return { promoted: false };
      // A restart-persisted expected hash (written at stage time) keeps the
      // same trust basis across exec: without it a release-tier stage would
      // be deleted as lock-mismatched instead of promoted.
      let opts = promoteOpts;
      if (!opts) {
        try {
          const sha = this._readStageSha();
          if (sha) opts = { expectedSha256: sha };
        } catch (_) {}
      }
      const res = await this._installer.promoteStagedSidecar(this.sidecar, opts);
      if (res && res.promoted) {
        try {
          const { shaFile } = this._stagedPaths();
          if (shaFile) fs.rmSync(shaFile, { force: true });
        } catch (_) {}
        this._stagedHash = null;
        this._stagedTier = null;
        this._stagedExpectedSha = null;
        this._recordActiveHash();
        console.log('  [mesh] sidecar updated to staged build.');
      }
      return res || { promoted: false };
    } catch (e) {
      this._lastError = e;
      if (this.dev) console.error('  [mesh] staged promote failed:', e && e.message);
      return { promoted: false, error: e };
    }
  }

  /** Record the lock contentHash the current install verified against. */
  _recordActiveHash() {
    try {
      const lock = this._installer.loadLock ? this._installer.loadLock() : null;
      if (lock && typeof lock.contentHash === 'string' && lock.contentHash) {
        this._activeHash = lock.contentHash;
      }
    } catch (_) { /* lock mid-write during npm upgrade — keep last known */ }
  }

  getStatus() {
    return {
      running: this.proc !== null && !this.stopping && !!this.dnsName,
      publicUrl: this.dnsName ? `${this.scheme || 'https'}://${this.dnsName}` : null,
      peers: this.peers ? this.peers.peers : [],
      activeVersion: this._activeHash || null,
      stagedVersion: this._stagedHash || null,
      updateAvailable: !!this._stagedHash && this._stagedHash !== this._activeHash,
      lastUpdateCheck: this._lastUpdateCheck || null,
      lastUpdateResult: this._lastUpdateResult || null,
      tsVersion: this.tsVersion || null,
      sidecarRef: this.sidecarRef || null,
    };
  }

  peersFilePath() {
    return path.join(this._appBase, 'mesh', 'peers.json');
  }

  async stop() {
    this.stopping = true;
    this._stopUpdateTimer();
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
   * Only intentional shutdown (stop()) or an in-flight versioned update gates
   * recovery — never the exit code.
   */
  _shouldAutoRestart() {
    return !this.stopping && !this._updating;
  }

  // Stop ONLY the sidecar child (server stays up). Unlike stop(), this does not
  // set stopping, clear the update timer, or delete files directly — the exit
  // handler does the cleanup, and _updating suppresses the crash-restart.
  _stopSidecarProc() {
    if (!this.proc) return Promise.resolve();
    return new Promise((resolve) => {
      const child = this.proc;
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      try { child.kill(); } catch (_) {}
    });
  }

  _startUpdateTimer() {
    if (!this._autoUpdateEnabled || this._updateTimer) return;
    const jitter = Math.floor(Math.random() * MESH_UPDATE_JITTER_MS);
    const ms = this._updateIntervalMs + jitter;
    this._updateTimer = setInterval(() => { this._updateTick().catch(() => {}); }, ms);
    if (this._updateTimer.unref) this._updateTimer.unref();
  }

  _stopUpdateTimer() {
    if (this._updateTimer) { clearInterval(this._updateTimer); this._updateTimer = null; }
  }

  _autoUpdateDisabled() {
    return !this._autoUpdateEnabled;
  }

  // 24h poll: converge the running sidecar (tier 1: lock; tier 2: newest
  // release), then recycle ONLY the sidecar. Never throws; any failure keeps
  // the old sidecar running for the next cycle.
  async _updateTick() {
    if (!this._autoUpdateEnabled || this.stopping || this._updating) return { checked: false };
    if (this._tickInFlight) return { checked: false };
    this._tickInFlight = true;
    this._lastUpdateCheck = Date.now();
    try {
      let lock;
      try {
        lock = this._installer.loadLock ? this._installer.loadLock() : null;
      } catch (_) {
        this._lastUpdateResult = { ok: false, reason: 'lock-unreadable' };
        return { checked: true, update: false };
      }
      if (!lock || typeof lock !== 'object') {
        this._lastUpdateResult = { ok: false, reason: 'lock-unreadable' };
        return { checked: true, update: false };
      }
      const name = this._installer.assetName ? this._installer.assetName() : null;
      const want = name && lock.assets ? (lock.assets[name] || '').toLowerCase() : '';
      if (!want) {
        this._lastUpdateResult = { ok: false, reason: 'lock-unfinalized' };
        return { checked: true, update: false };
      }
      const wantVersion = typeof lock.contentHash === 'string' ? lock.contentHash : null;
      if (wantVersion && this._isQuarantined(wantVersion)) {
        this._lastUpdateResult = { ok: false, reason: 'version-failed-before', version: wantVersion };
        return { checked: true, update: false };
      }
      let current = null;
      try {
        current = this._installer.sha256File
          ? (await this._installer.sha256File(this.sidecar)).toLowerCase()
          : null;
      } catch (_) { current = null; }
      if (this.stopping) return { checked: false };
      if (current === want) {
        this._recordActiveHash();
        if (this._stagedHash && this._stagedHash !== this._activeHash && this._stagedTier !== 'release') {
          // Stable caught up via another path (e.g. restart-time promote) —
          // drop the redundant lock-tier stage best-effort. A release-tier
          // stage belongs to the freshness check below, not to us.
          this._clearStagedState(true);
        }
        this._lastUpdateResult = { ok: true, upToDate: true };
        return await this._runReleaseTier();
      }
      if (current) {
        // Newer-than-lock steady state? When the running bytes are exactly the
        // provenance-recorded build (tier-2 output or a prior recycle), the
        // image is intentional — reverting toward the older lock would flap
        // every cycle. Treat as current and let the release tier decide.
        const prov = this._readProvenance();
        if (prov && prov.sha256 && current === String(prov.sha256).toLowerCase()) {
          this._activeHash = prov.contentHash || want;
          if (prov.ref) this.sidecarRef = prov.ref;
          this._lastUpdateResult = { ok: true, upToDate: true, via: 'provenance' };
          return await this._runReleaseTier();
        }
      }
      if (typeof this._installer.stageSidecar !== 'function') {
        this._lastUpdateResult = { ok: false, reason: 'no-stage-support' };
        return { checked: true, update: false };
      }
      await this._installer.stageSidecar(this.sidecar);
      if (this.stopping) {
        this._clearStagedState(false); // keep files: next start() promotes
        return { checked: false };
      }
      this._stagedHash = wantVersion;
      this._stagedTier = 'lock';
      this._stagedExpectedSha = null; // lock-tier promote verifies against the lock
      this._writeStageSha(want);
      this._lastUpdateResult = { ok: true, staged: true, version: wantVersion };
      if (this.dev) console.log(`  [mesh] staged sidecar update ${(wantVersion || '').slice(0, 12)} — recycling sidecar.`);
      return await this._recycleVerdict(await this._recycleSidecarForUpdate(wantVersion));
    } catch (e) {
      this._lastUpdateResult = { ok: false, reason: (e && e.code) || 'error', message: e && e.message };
      if (this.dev) console.error('  [mesh] update check failed:', e && e.message);
      return { checked: true, update: false };
    } finally {
      this._tickInFlight = false;
    }
  }

  // Normalize a recycle verdict into a tick result (C2: no unconditional
  // update:true — stand-downs and failures propagate truthfully).
  _recycleVerdict(res) {
    if (res && (res.recycled || res.reconnecting)) {
      const out = { checked: true, update: true };
      if (res.reconnecting) out.reconnecting = true;
      return out;
    }
    const out = { checked: true, update: false, reason: (res && res.reason) || 'not_recycled' };
    if (res && res.restored !== undefined) out.restored = res.restored;
    return out;
  }

  // Tier-2 runner shared by the lock-current and provenance-current paths.
  // Soft failure keeps the caller's up-to-date result; only acted outcomes
  // (recycle verdicts with reasons) propagate.
  async _runReleaseTier() {
    try {
      const tier2 = await this._releaseTierCheck();
      if (tier2 && tier2.update) return tier2;
      if (tier2 && tier2.reason) {
        const out = { checked: true, update: false, reason: tier2.reason };
        if (tier2.restored !== undefined) out.restored = tier2.restored;
        return out;
      }
    } catch (_) { /* tier 2 never breaks tier 1 */ }
    return { checked: true, update: false };
  }

  // Quarantine keys are bare content hashes: tier 1 uses the lock hash, tier 2
  // uses `mesh-<hash>` tags — normalize so one bad build is quarantined once.
  _quarantineKey(v) {
    try {
      return String(v || '').replace(/^mesh-/, '') || null;
    } catch (_) {
      return null;
    }
  }

  // Persistent quarantine (mesh/quarantine.json): a rolled-back or
  // pre-flight-rejected build stays stood down across restarts — otherwise a
  // restart re-applies a known-bad build whose only backup was already
  // consumed. Entries expire after 30 days; any successful recycle clears the
  // slate (a good build proves the pipeline healthy again).
  _quarantineFile() {
    try {
      return path.join(this._appBase, 'mesh', 'quarantine.json');
    } catch (_) {
      return null;
    }
  }

  _readQuarantineFile() {
    try {
      const f = this._quarantineFile();
      if (!f) return {};
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!raw || typeof raw !== 'object') return {};
      const now = Date.now();
      const out = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object') continue;
        if (typeof v.at === 'number' && now - v.at > QUARANTINE_TTL_MS) continue;
        out[k] = v;
      }
      return out;
    } catch (_) {
      return {};
    }
  }

  _writeQuarantineFile(entries) {
    try {
      const f = this._quarantineFile();
      if (!f) return;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(entries, null, 2), { mode: 0o600 });
    } catch (_) { /* best-effort */ }
  }

  _isQuarantined(v) {
    const key = this._quarantineKey(v);
    if (!key) return false;
    if (this._failedUpdateVersions.has(key)) return true;
    try {
      const entries = this._readQuarantineFile();
      if (entries[key]) {
        this._failedUpdateVersions.add(key); // re-hydrate memory fast path
        return true;
      }
    } catch (_) {}
    return false;
  }

  _addQuarantine(v, reason) {
    const key = this._quarantineKey(v);
    if (!key) return;
    this._failedUpdateVersions.add(key);
    try {
      const entries = this._readQuarantineFile();
      entries[key] = { at: Date.now(), reason: reason || 'failed' };
      this._writeQuarantineFile(entries);
    } catch (_) {}
  }

  _clearQuarantine() {
    this._failedUpdateVersions.clear();
    try {
      const f = this._quarantineFile();
      if (f) fs.rmSync(f, { force: true });
    } catch (_) {}
  }

  // Staged-state bookkeeping: the in-memory triple always describes the .new
  // file (when one exists). deleteFiles=true also removes .new + .sha256.
  _stagedPaths() {
    try {
      const staged = this._installer.stagedSidecarPath
        ? this._installer.stagedSidecarPath(this.sidecar)
        : `${this.sidecar}.new`;
      return { staged, shaFile: `${staged}.sha256` };
    } catch (_) {
      return { staged: null, shaFile: null };
    }
  }

  _clearStagedState(deleteFiles) {
    this._stagedHash = null;
    this._stagedTier = null;
    this._stagedExpectedSha = null;
    if (deleteFiles) {
      try {
        const { staged, shaFile } = this._stagedPaths();
        if (staged) fs.rmSync(staged, { force: true });
        if (shaFile) fs.rmSync(shaFile, { force: true });
      } catch (_) {}
    }
  }

  // Record the expected hash of a freshly staged build so a restart can
  // promote it with the same trust basis (lock sha for tier 1, manifest sha
  // for tier 2) instead of deleting it as lock-mismatched.
  _writeStageSha(sha) {
    try {
      if (!sha) return;
      const { shaFile } = this._stagedPaths();
      if (!shaFile) return;
      fs.writeFileSync(shaFile, String(sha).toLowerCase(), { mode: 0o600 });
    } catch (_) {}
  }

  _readStageSha() {
    try {
      const { staged, shaFile } = this._stagedPaths();
      if (!staged || !shaFile) return null;
      if (!fs.existsSync(staged) || !fs.existsSync(shaFile)) return null;
      const sha = String(fs.readFileSync(shaFile, 'utf8')).trim().toLowerCase();
      return /^[0-9a-f]{64}$/.test(sha) ? sha : null;
    } catch (_) {
      return null;
    }
  }

  _readProvenance() {
    try {
      const load = this._installer.loadProvenance;
      if (typeof load !== 'function') return null;
      return load(this.sidecar);
    } catch (_) {
      return null;
    }
  }

  // Resolve the ref the running binary was verified against: live provenance
  // first. For pre-feature installs (bytes but no record), hash the bytes
  // against the SHIPPED lock — a match proves the bytes are exactly that
  // release. Bytes matching neither are `null` (forces one freshness check),
  // never the lock hash as `current` (that would claim newness for old bytes
  // and skip the refresh forever).
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
      if (want && lock.contentHash && fs.existsSync(this.sidecar)) {
        const h = crypto.createHash('sha256');
        h.update(fs.readFileSync(this.sidecar));
        if (h.digest('hex').toLowerCase() === String(want).toLowerCase()) {
          this.sidecarRef = `mesh-${lock.contentHash}`;
          return this.sidecarRef;
        }
      }
    } catch (_) {}
    return null;
  }

  // TIER 2 — release freshness: when tier 1 is current, check the mesh-*
  // releases for a newer build (a Tailscale client bump always publishes one)
  // and roll forward to it through the same stage → preflight → recycle path.
  // Best-effort: returns null when skipped or on soft failure (tier 1's result
  // stands), { checked, update } when it acted. Never throws.
  async _releaseTierCheck() {
    const installer = this._installer;
    if (typeof installer.listMeshReleases !== 'function'
      || typeof installer.fetchSidecarRef !== 'function') {
      return null; // capability absent (e.g. stubbed installer) — stay offline
    }
    if (process.env.AIORDIE_MESH_REF || process.env.AIORDIE_MESH_VERSION) {
      return null; // dev ref pinning wins over freshness
    }
    let releases = null;
    try {
      releases = await installer.listMeshReleases(this._fetch || undefined);
    } catch (_) {
      return null;
    }
    const newest = releases && releases[0];
    const current = this._currentSidecarRef();
    if (current && newest.tag === current) return null;
    if (this._isQuarantined(newest.tag)) return null;
    const stagedPath = installer.stagedSidecarPath
      ? installer.stagedSidecarPath(this.sidecar)
      : `${this.sidecar}.new`;
    let verified = null;
    try {
      verified = await installer.fetchSidecarRef(newest.tag, stagedPath, { fetch: this._fetch || undefined });
    } catch (e) {
      if (this.dev) console.error('  [mesh] release-tier fetch failed:', e && e.message);
      return null;
    }
    const hash = String(newest.tag).replace(/^mesh-/, '');
    this._stagedHash = hash;
    this._stagedTier = 'release';
    this._stagedExpectedSha = (verified && verified.sha256) || null;
    // sidecarRef keeps the old value until recycle succeeds (success and
    // rollback paths both set it truthfully); status never flaps to null.
    if (this.dev) console.log(`  [mesh] staged release-tier update ${newest.tag} — recycling sidecar.`);
    const res = await this._recycleSidecarForUpdate(newest.tag, { expectedSha256: this._stagedExpectedSha });
    if (res && (res.recycled || res.reconnecting)) {
      return { checked: true, update: true, reconnecting: !!res.reconnecting };
    }
    // Recycle stood down or failed — report no update, preserving the
    // recycle's reason + restore accounting for status/tests.
    const out = { checked: true, update: false, reason: (res && res.reason) || 'not_recycled' };
    if (res && res.restored !== undefined) out.restored = res.restored;
    return out;
  }

  // Pre-flight a staged build BEFORE killing the good child: execute
  // `<staged> --version` and require exit 0 with the expected content hash in
  // the output. Skipped when no staged file exists (stubbed installers in
  // tests); the promote step re-verifies checksums regardless. Never throws —
  // returns false on any failure (caller quarantines + keeps old running).
  _preflightStaged(staged, expectedHash) {
    try {
      if (!staged || !fs.existsSync(staged)) return true; // nothing to check; promote validates
      const execFile = this._execFile || require('child_process').execFileSync;
      const out = String(execFile(staged, ['--version'], { encoding: 'utf8', timeout: 30000 }));
      if (expectedHash && !out.includes(expectedHash)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  // Sidecar-only recycle: stop old child (frees the image lock on Windows),
  // promote staged → stable, respawn. Server, sessions and localhost clients
  // never drop; only the tailnet path blips. Rolls back to .prev once when the
  // new build fails to report MESH-URL. Never throws.
  async _recycleSidecarForUpdate(wantVersion, opts = {}) {
    if (this._updating || this.stopping) return { recycled: false, reason: 'busy' };
    if (!this.proc) {
      // Not running (not enrolled / degraded) — promote file-free now; the
      // next start() spawns the new build.
      await this._promoteStagedIfValid(opts.expectedSha256 ? { expectedSha256: opts.expectedSha256 } : undefined);
      this._clearStagedState(false);
      return { recycled: false, reason: 'not_running' };
    }
    try {
      if (!fs.existsSync(this.stateDir)) {
        this._lastUpdateResult = { ok: false, reason: 'no-state-dir' };
        this._clearStagedState(false);
        return { recycled: false, reason: 'no-state-dir' };
      }
    } catch (_) {
      this._lastUpdateResult = { ok: false, reason: 'no-state-dir' };
      this._clearStagedState(false);
      return { recycled: false, reason: 'no-state-dir' };
    }
    // Pre-flight the staged build BEFORE killing the good child. A corrupt or
    // AV-blocked binary fails here with the old sidecar untouched. This is a
    // liveness gate, not a trust gate (checksums were already verified); the
    // synchronous spawn is bounded (30s), runs at most once a day, and avoids
    // off-thread ordering complexity before a destructive swap.
    try {
      const staged = this._installer.stagedSidecarPath
        ? this._installer.stagedSidecarPath(this.sidecar)
        : `${this.sidecar}.new`;
      const expectedHash = String(wantVersion || '').replace(/^mesh-/, '');
      if (!this._preflightStaged(staged, expectedHash)) {
        this._clearStagedState(true); // delete the unproven stage
        this._addQuarantine(wantVersion, 'preflight_failed');
        this._lastUpdateResult = { ok: false, reason: 'preflight_failed', version: wantVersion };
        console.warn('  [mesh] staged build failed pre-flight — keeping current sidecar.');
        return { recycled: false, reason: 'preflight_failed' };
      }
    } catch (_) { /* pre-flight is advisory; promote re-verifies checksums */ }
    this._updating = true;
    const prevDns = this.dnsName;
    // Saved BEFORE the swap so rollback restores truthful provenance: without
    // this, sidecar.json would keep claiming the new ref over old bytes and
    // every future tick would conclude "already current" forever.
    const oldRef = this.sidecarRef;
    try {
      await this._stopSidecarProc();
      if (this.stopping) {
        this._clearStagedState(false); // keep files: next start() promotes
        return { recycled: false, reason: 'stopping' };
      }
      const promo = await this._promoteStagedIfValid(
        opts.expectedSha256 ? { expectedSha256: opts.expectedSha256 } : undefined
      );
      if (typeof this._installer.promoteStagedSidecar === 'function'
        && (!promo || (!promo.promoted && promo.reason !== 'already_current')) && !this.stopping) {
        // The stage did not become the stable image (checksum mismatch deleted
        // it, or the file is locked): respawn the untouched stable build and
        // stand down. Bytes on disk never changed, so no rollback is needed.
        this._addQuarantine(wantVersion, (promo && promo.reason) || 'promote_failed');
        this._clearStagedState(false);
        try { await this._spawn(); } catch (_) {}
        const ok = !!this.dnsName;
        this._lastUpdateResult = { ok, reason: 'promote_failed', restored: ok };
        return { recycled: false, reason: 'promote_failed', restored: ok };
      }
      if (this.stopping) {
        this._clearStagedState(false);
        return { recycled: false, reason: 'stopping' };
      }
      await this._spawn();
      if (this.stopping) {
        try { await this._stopSidecarProc(); } catch (_) {}
        this._clearStagedState(false);
        return { recycled: false, reason: 'stopping' };
      }
      const normHash = String(wantVersion || '').replace(/^mesh-/, '');
      const tag = /^mesh-/.test(String(wantVersion || '')) ? wantVersion : `mesh-${normHash}`;
      const recordIdentity = () => {
        this._activeHash = normHash || null;
        this._clearStagedState(false);
        this._clearQuarantine(); // a running build proves the pipeline healthy
        try {
          const wp = this._installer.writeProvenance;
          if (typeof wp === 'function') {
            wp(this.sidecar, { ref: tag, contentHash: normHash || null, sha256: opts.expectedSha256 || null });
          }
        } catch (_) {}
        this.sidecarRef = tag;
      };
      if (this.dnsName) {
        recordIdentity();
        const sameUrl = prevDns ? prevDns === this.dnsName : null;
        this._lastUpdateResult = { ok: true, updated: true, reconnected: true, sameUrl };
        console.log(`  [mesh] sidecar updated, tailnet path re-established (${this.scheme}://${this.dnsName}).`);
        return { recycled: true };
      }
      if (this.proc) {
        // Live child, no URL yet (e.g. NEEDLOGIN while the operator enrolls):
        // the binary works — leave it alone, never roll back a running child.
        // Identity is recorded (this build IS running) so updateAvailable
        // clears and the next tick does not re-fetch it.
        recordIdentity();
        this._lastUpdateResult = { ok: true, updated: true, reconnected: false, awaitingUrl: true };
        console.log('  [mesh] sidecar updated; new child running, awaiting tailnet URL.');
        return { recycled: true, reconnecting: true };
      }
      // Dead child, no URL — bad build. Roll back to .prev once.
      console.warn('  [mesh] updated sidecar failed to come up — rolling back.');
      try { await this._stopSidecarProc(); } catch (_) {}
      if (this.stopping) {
        this._clearStagedState(false);
        return { recycled: false, reason: 'stopping' };
      }
      let rollbackOk = false;
      try {
        if (typeof this._installer.rollbackSidecar === 'function') {
          const rb = await this._installer.rollbackSidecar(this.sidecar);
          rollbackOk = !!(rb && rb.restored === true);
        }
      } catch (e) {
        if (this.dev) console.error('  [mesh] rollback failed:', e && e.message);
      }
      if (this.stopping) {
        this._clearStagedState(false); // keep files: next start() promotes
        return { recycled: false, reason: 'stopping' };
      }
      this._addQuarantine(wantVersion, rollbackOk ? 'rollback' : 'rollback_failed');
      this._clearStagedState(false);
      try {
        const wp = this._installer.writeProvenance;
        if (typeof wp === 'function' && oldRef) {
          const normOld = String(oldRef).replace(/^mesh-/, '');
          wp(this.sidecar, { ref: oldRef, contentHash: normOld || null, sha256: null });
        }
      } catch (_) {}
      if (oldRef) this.sidecarRef = oldRef;
      await this._spawn();
      if (this.stopping) {
        try { await this._stopSidecarProc(); } catch (_) {}
        return { recycled: false, reason: 'stopping' };
      }
      const restored = rollbackOk && !!this.dnsName;
      this._lastUpdateResult = { ok: false, reason: rollbackOk ? 'rollback' : 'rollback_failed', restored };
      if (restored) this._recordActiveHash();
      return { recycled: false, reason: rollbackOk ? 'rollback' : 'rollback_failed', restored };
    } finally {
      this._updating = false;
    }
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
    // Re-check after the delay: a stop(), a recycle, or another spawn may have
    // happened while waiting — never double-spawn or resurrect. (The exit
    // handler consults _shouldAutoRestart, but a _restart already past that
    // gate must still stand down here.)
    if (this.stopping || this._updating || this.proc) return;
    try {
      await this._spawn();
    } catch (err) {
      console.error(`  [mesh] Spawn failed: ${err && err.message}. Will retry with backoff.`);
    }
  }
}

module.exports = { MeshManager, _constants: { URL_TIMEOUT_MS, MAX_RETRIES, MESH_UPDATE_CHECK_MS, MESH_UPDATE_JITTER_MS } };
