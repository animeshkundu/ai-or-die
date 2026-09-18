'use strict';

// FleetClient — register the machine with fleet-gateway and keep a heartbeat.
//
// Wire contract (see docs/specs/fleet-gateway.md):
//   POST /api/fleet/register   { machineId, hostname, platform, version,
//                                meshUrl, capabilities } -> { token }
//   PUT  /api/fleet/heartbeat/:machineId { status, version, activeSessions,
//                                          uptimeMs }
//   DELETE /api/fleet/machines/:machineId  (on graceful shutdown)
//
// Status values: healthy | updating | degraded. The gateway treats a missed
// heartbeat window as offline; the client retries with backoff and never
// throws into the supervisor loop.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { FLEET_TOKEN_FILE } = require('./constants');

const HEARTBEAT_INTERVAL_MS = 30000;

class FleetClient {
  constructor(options = {}) {
    this._supervisor = options.supervisor || null;
    this.gatewayUrl = options.gatewayUrl || process.env.AIORDIE_FLEET_GATEWAY || null;
    this._request = options.request || null; // injectable for tests
    this._heartbeatMs = options.heartbeatMs
      || parseInt(process.env.AIORDIE_FLEET_HEARTBEAT, 10)
      || HEARTBEAT_INTERVAL_MS;
    // Test seam: redirect the id/token files into a sandbox dir.
    this._idFile = options.idFile || path.join(path.dirname(FLEET_TOKEN_FILE), 'machine-id');
    this._tokenFile = options.tokenFile || FLEET_TOKEN_FILE;
    this.machineId = options.machineId || this._loadOrGenerateId();
    this.token = options.token || process.env.AIORDIE_FLEET_TOKEN || this._loadToken();
    this._timer = null;
    this._startTime = Date.now();
    this.registered = false;
  }

  get enabled() {
    return !!this.gatewayUrl;
  }

  start() {
    if (!this.enabled || this._timer) return Promise.resolve({ started: false });
    return this.register().then(() => {
      this._timer = setInterval(() => {
        this.heartbeat().catch(() => { /* best-effort; next tick retries */ });
      }, this._heartbeatMs);
      if (this._timer.unref) this._timer.unref();
      return { started: true };
    }).catch((err) => ({ started: false, error: err && err.message }));
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (!this.registered) return Promise.resolve({ deregistered: false });
    return this._call('DELETE', `/api/fleet/machines/${this.machineId}`)
      .then(() => ({ deregistered: true }))
      .catch(() => ({ deregistered: false }));
  }

  async register() {
    if (!this.enabled) return { registered: false, reason: 'no_gateway' };
    const body = {
      machineId: this.machineId,
      hostname: os.hostname(),
      platform: process.platform,
      version: this._version(),
      meshUrl: this._meshUrl(),
      capabilities: ['pty-handoff', 'auto-update', 'update-button', 'wake-resume'],
    };
    const res = await this._call('POST', '/api/fleet/register', body);
    if (res && res.token) {
      this.token = res.token;
      this._saveToken(res.token);
    }
    this.registered = true;
    return { registered: true };
  }

  heartbeat(status) {
    if (!this.enabled || !this.registered) return Promise.resolve({ sent: false });
    return this._call('PUT', `/api/fleet/heartbeat/${this.machineId}`, {
      status: status || (this._updating ? 'updating' : 'healthy'),
      version: this._version(),
      activeSessions: this._activeSessions(),
      uptimeMs: Date.now() - this._startTime,
    }).then(() => ({ sent: true })).catch(() => ({ sent: false }));
  }

  reportUpdating(version) {
    this._updating = true;
    return this.heartbeat('updating').then((r) => ({ ...r, version }));
  }

  reportHealthy() {
    this._updating = false;
    return this.heartbeat('healthy');
  }

  _version() {
    try {
      if (this._supervisor && this._supervisor.version) return this._supervisor.version;
      return require('../../package.json').version;
    } catch (_) {
      return 'unknown';
    }
  }

  _meshUrl() {
    try {
      if (this._supervisor && this._supervisor.meshUrl) return this._supervisor.meshUrl;
      return null;
    } catch (_) {
      return null;
    }
  }

  _activeSessions() {
    try {
      if (this._supervisor && this._supervisor.ptyManager) return this._supervisor.ptyManager.size;
      return 0;
    } catch (_) {
      return 0;
    }
  }

  _call(method, apiPath, body) {
    if (this._request) return this._request(method, apiPath, body);
    const base = String(this.gatewayUrl).replace(/\/+$/, '');
    const url = new URL(base + apiPath);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); }
          } else {
            reject(new Error(`fleet-gateway ${method} ${apiPath} -> HTTP ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { try { req.destroy(); } catch (_) {} reject(new Error('fleet-gateway request timed out')); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  _loadOrGenerateId() {
    const idFile = this._idFile;
    try {
      const existing = fs.readFileSync(idFile, 'utf8').trim();
      if (existing) return existing;
    } catch (_) { /* generate */ }
    const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    try {
      fs.mkdirSync(path.dirname(idFile), { recursive: true });
      fs.writeFileSync(idFile, id, { mode: 0o600 });
    } catch (_) { /* best-effort */ }
    return id;
  }

  _loadToken() {
    try { return fs.readFileSync(this._tokenFile, 'utf8').trim() || null; } catch (_) { return null; }
  }

  _saveToken(token) {
    try {
      fs.mkdirSync(path.dirname(this._tokenFile), { recursive: true });
      fs.writeFileSync(this._tokenFile, token, { mode: 0o600 });
    } catch (_) { /* best-effort */ }
  }
}

module.exports = { FleetClient, HEARTBEAT_INTERVAL_MS };
