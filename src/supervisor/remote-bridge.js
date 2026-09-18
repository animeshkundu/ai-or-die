'use strict';

// SupervisorProxy — child-side stand-in for the Supervisor object.
//
// Why this exists (Blocker 2 / ADR-0058 follow-up): the Supervisor runs in
// the PARENT process (bin/supervisor-service.js) and the Server runs in the
// CHILD process (bin/ai-or-die.js), so the child can never hold a direct
// reference for setSupervisorBridge(). Before this module, the child's
// /api/update/* routes always saw getSupervisor() === null and reported
// { supervised: false } / 409 — the Settings "Apply Now" button could never
// work in production, for `node bin/ai-or-die.js`, `npx`, or service boots.
//
// The proxy implements the exact bridge interface update-routes.js needs
// ({ updateStatus(), autoUpdater: { check() }, applyUpdate() }) by turning
// each call into an id-correlated IPC round-trip to the parent, which
// answers in Supervisor._wireServerEvents. Timeouts and dead channels
// reject (routes surface 500); wire types are shared with ipc-protocol.js
// and unknown frames are ignored, so old/new binaries interoperate.

const ipc = require('./ipc-protocol');

const DEFAULT_TIMEOUTS = {
  status: 15000,   // local-only on the parent; fast
  check: 180000,   // includes staged binary download over the network
  apply: 180000,   // full swap: READY + handoff + port takeover + shutdown
};

class SupervisorProxy {
  constructor(options = {}) {
    this._send = options.send || ((msg) => process.send(msg));
    this._isConnected = options.isConnected
      || (() => typeof process.send === 'function' && process.connected !== false);
    const on = options.on || ((event, fn) => process.on(event, fn));
    const off = options.off || ((event, fn) => process.removeListener(event, fn));
    this._off = off;
    this._timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeoutMs || {}) };
    this._pending = new Map(); // id -> { resolve, reject, timer, responseType }
    this._nextId = 1;
    // update-routes.js reaches check via bridge.autoUpdater.check().
    this.autoUpdater = { check: () => this._request('check') };
    this._messageListener = (msg) => this._onMessage(msg);
    on('message', this._messageListener);
  }

  dispose() {
    try { this._off('message', this._messageListener); } catch (_) { /* ignore */ }
    for (const [, p] of this._pending) {
      try { clearTimeout(p.timer); } catch (_) { /* ignore */ }
      try { p.reject(new Error('supervisor proxy disposed')); } catch (_) { /* ignore */ }
    }
    this._pending.clear();
  }

  updateStatus() {
    return this._request('status');
  }

  applyUpdate() {
    return this._request('apply');
  }

  _request(kind) {
    const spec = this._specFor(kind);
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        try { fn(value); } catch (_) { /* ignore */ }
      };
      let connected = false;
      try {
        connected = !!this._isConnected();
      } catch (_) {
        connected = false;
      }
      if (!connected) {
        done(reject, new Error('supervisor unreachable'));
        return;
      }
      const id = this._nextId;
      this._nextId += 1;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        done(reject, new Error(`supervisor request timed out (${spec.requestType})`));
      }, spec.timeout);
      if (timer.unref) timer.unref();
      this._pending.set(id, {
        responseType: spec.responseType,
        timer,
        resolve: (v) => { this._pending.delete(id); try { clearTimeout(timer); } catch (_) {} done(resolve, v); },
        reject: (e) => { this._pending.delete(id); try { clearTimeout(timer); } catch (_) {} done(reject, e); },
      });
      try {
        this._send({ type: spec.requestType, id });
      } catch (err) {
        const p = this._pending.get(id);
        if (p) {
          this._pending.delete(id);
          try { clearTimeout(timer); } catch (_) { /* ignore */ }
        }
        done(reject, err instanceof Error ? err : new Error('supervisor send failed'));
      }
    });
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.id === 'undefined') return;
    const pending = this._pending.get(msg.id);
    if (!pending || msg.type !== pending.responseType) return;
    if (msg.ok === false) {
      pending.reject(new Error(msg.error || 'supervisor request failed'));
    } else {
      pending.resolve(msg.result);
    }
  }

  _specFor(kind) {
    return SupervisorProxy._specFor(kind, this._timeouts);
  }

  static _specFor(kind, timeouts) {
    const t = timeouts || DEFAULT_TIMEOUTS;
    if (kind === 'status') {
      return { requestType: ipc.MSG.UPDATE_STATUS_REQUEST, responseType: ipc.MSG.UPDATE_STATUS_RESPONSE, timeout: t.status };
    }
    if (kind === 'check') {
      return { requestType: ipc.MSG.UPDATE_CHECK_REQUEST, responseType: ipc.MSG.UPDATE_CHECK_RESPONSE, timeout: t.check };
    }
    return { requestType: ipc.MSG.UPDATE_APPLY_REQUEST, responseType: ipc.MSG.UPDATE_APPLY_RESPONSE, timeout: t.apply };
  }
}

module.exports = { SupervisorProxy, DEFAULT_TIMEOUTS };
