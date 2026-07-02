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
  }

  /** Never throws — degrades to localhost/devtunnel on any failure. */
  async start() {
    console.log('\n  Connecting mesh (Tailscale userspace)...');
    this.stopping = false;
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
      publicUrl: this.dnsName ? `${this.scheme || 'https'}://${this.dnsName}` : null,
      peers: this.peers ? this.peers.peers : [],
    };
  }

  peersFilePath() {
    return path.join(this._appBase, 'mesh', 'peers.json');
  }

  async stop() {
    this.stopping = true;
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
        if (!this.stopping && code !== 0) this._restart();
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

  async _restart() {
    this._totalRestarts++; this.retryCount++;
    if (this.retryCount > MAX_RETRIES) { console.error('  \x1b[31mMesh sidecar crashed too many times. Server continues on localhost.\x1b[0m'); return; }
    const delay = Math.min(2 ** (this.retryCount - 1) * MIN_RESTART_DELAY_MS, MAX_RESTART_DELAY_MS);
    await new Promise((resolve) => { this._restartDelayResolve = resolve; this._restartDelayTimer = setTimeout(resolve, delay); if (this._restartDelayTimer.unref) this._restartDelayTimer.unref(); });
    this._restartDelayResolve = null;
    if (this.stopping) return;
    await this._spawn();
  }
}

module.exports = { MeshManager, _constants: { URL_TIMEOUT_MS, MAX_RETRIES } };
