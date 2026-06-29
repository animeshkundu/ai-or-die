'use strict';

// MeshManager — permanent reachability over a Tailscale tailnet via the
// aiordie-mesh sidecar (tsnet in USERSPACE: no kernel TUN, no admin, no system
// service). Only ai-or-die's own port joins the mesh; the rest of the machine
// stays off it. Mirrors TunnelManager's lifecycle (detect → start → backoff →
// stop) so bin/ai-or-die.js supervises it like the dev tunnel. Verified E2E:
// the sidecar enrolls and reverse-proxies the local port to <host>.ts.net.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const URL_TIMEOUT_MS = 60000;          // enroll + name can take ~30s on first run
const STABILITY_THRESHOLD_MS = 60000;  // 60s up = reset retry budget
const MIN_RESTART_DELAY_MS = 1000;
const MAX_RESTART_DELAY_MS = 30000;
const MAX_RETRIES = 10;

class MeshManager {
  constructor(options = {}) {
    this.port = options.port || 7777;          // the ai-or-die port to expose
    this.dev = options.dev || false;
    this.onUrl = options.onUrl || (() => {});
    // Consume the key once and scrub it everywhere it could leak.
    this._authKey = options.authKey || process.env.AIORDIE_TS_AUTHKEY || null;
    delete process.env.AIORDIE_TS_AUTHKEY;
    this._childEnv = { ...process.env };
    delete this._childEnv.AIORDIE_TS_AUTHKEY;

    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const base = process.platform === 'win32'
      ? path.join(localApp, 'ai-or-die')
      : path.join(os.homedir(), '.ai-or-die');
    this.stateDir = options.stateDir || path.join(base, 'ts-state');
    const exe = process.platform === 'win32' ? 'aiordie-mesh.exe' : 'aiordie-mesh';
    this.sidecar = options.sidecar || path.join(base, 'bin', exe);
    this.hostname = (options.hostname || `aiordie-${os.hostname()}`).toLowerCase().replace(/[^a-z0-9-]/g, '');

    this.proc = null;
    this.dnsName = null;
    this.stopping = false;
    this.retryCount = 0;
    this._totalRestarts = 0;
    this._stabilityTimer = null;
    this._restartDelayTimer = null;
    this._restartDelayResolve = null;
    this._stabilityThresholdMs = options._stabilityThresholdMs || STABILITY_THRESHOLD_MS;
  }

  /** Never throws — degrades to localhost/devtunnel on any failure. */
  async start() {
    console.log('\n  Connecting mesh (Tailscale userspace)...');
    this.stopping = false;
    if (!fs.existsSync(this.sidecar)) { this._printMissing(); return; }
    if (!this._authKey && !this._enrolled()) { this._printNotEnrolled(); return; }
    try { fs.mkdirSync(this.stateDir, { recursive: true }); } catch (_) {}
    await this._spawn();
  }

  getStatus() {
    return { running: this.proc !== null && !this.stopping && !!this.dnsName, publicUrl: this.dnsName ? `https://${this.dnsName}` : null };
  }

  async stop() {
    this.stopping = true;
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
      const args = ['--port', String(this.port), '--hostname', this.hostname, '--statedir', this.stateDir];
      this.proc = spawn(this.sidecar, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this._childEnv });
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; console.warn('  \x1b[33mMesh: no URL within 60s — check key/connectivity.\x1b[0m'); resolve(); } }, URL_TIMEOUT_MS);
      this.proc.stdout.on('data', (d) => {
        const out = d.toString();
        if (this.dev) process.stdout.write(`  [mesh] ${out}`);
        const url = out.match(/MESH-URL (https:\/\/\S+)/);
        if (url && !this.dnsName) {
          this.dnsName = url[1].replace(/^https:\/\//, '');
          this._authKey = null;
          this._startStabilityTimer();
          this.onUrl(`https://${this.dnsName}`);
          if (!done) { done = true; clearTimeout(timer); resolve(); }
        }
        if (/MESH-NEEDLOGIN/.test(out)) { this._printNotEnrolled(); if (!done) { done = true; clearTimeout(timer); resolve(); } }
      });
      this.proc.stderr.on('data', (d) => { if (this.dev) process.stderr.write(`  [mesh] ${d}`); });
      this.proc.on('error', (e) => { console.error(`  \x1b[31mmesh sidecar failed: ${e.message}\x1b[0m`); this.proc = null; if (!done) { done = true; clearTimeout(timer); resolve(); } });
      this.proc.on('exit', (code) => {
        this._clearStabilityTimer(); this.proc = null; this.dnsName = null;
        if (!this.stopping && code !== 0) this._restart();
      });
    });
  }

  _printMissing() {
    console.log('\n  \x1b[33mMesh: sidecar not installed.\x1b[0m  Fetched on next release build; see docs/specs/mesh.md.');
    console.log('  Continuing on localhost/devtunnel.\n');
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
