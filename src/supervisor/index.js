'use strict';

// Supervisor — the stable anchor for the autoupdating ai-or-die service.
//
// The Supervisor owns what must survive a Server binary update:
//   - PTY processes (PtyManager — Job Objects on Windows, pgroups on POSIX)
//   - the Server child lifecycle + seamless swap (ServerManager)
//   - background update checks/downloads (AutoUpdater, hybrid trigger)
//   - user-level service definition (ServiceInstaller, stable path)
//   - sleep/wake auto-resume (WakeHandler)
//   - fleet-gateway registration/heartbeat (FleetClient)
//   - Windows keep-awake (KeepaliveManager, always ON for service) and
//     hibernation disable (HibernationGuard, DEFAULT ON for Windows service)
//
// Crash discipline follows bin/supervisor.js (PROC-01): tiered backoff, never
// permanent exit — the single-user daemon has no orchestrator above it.

const path = require('path');
const { PtyManager } = require('./pty-manager');
const { ServerManager } = require('./server-manager');
const { AutoUpdater } = require('./autoupdater');
const { ServiceInstaller } = require('./service-installer');
const { WakeHandler } = require('./wake-handler');
const { FleetClient } = require('./fleet-client');
const KeepaliveManager = require('../keepalive-manager');
const HibernationGuard = require('../hibernation-guard');
const ipc = require('./ipc-protocol');
const { STABLE_SERVER_BIN } = require('./constants');

const RESTART_DELAY_MS = parseInt(process.env.RESTART_DELAY_MS, 10) || 1000;
const CRASH_RESTART_DELAY_MS = parseInt(process.env.CRASH_RESTART_DELAY_MS, 10) || 3000;

class Supervisor {
  constructor(options = {}) {
    this.version = options.version || require('../../package.json').version;
    this.serverBinary = options.serverBinary || STABLE_SERVER_BIN;
    this.serverArgs = options.serverArgs || process.argv.slice(2).filter((a) => a !== 'supervise');
    this.ptyManager = options.ptyManager || new PtyManager();
    this.serverManager = options.serverManager || new ServerManager({ ptyManager: this.ptyManager });
    this.autoUpdater = options.autoUpdater || new AutoUpdater({ supervisor: this });
    this.serviceInstaller = options.serviceInstaller || new ServiceInstaller();
    this.wakeHandler = options.wakeHandler || new WakeHandler({
      onWake: ({ gapMs }) => this._onWake(gapMs),
    });
    this.fleetClient = options.fleetClient || new FleetClient({ supervisor: this });
    const isService = process.env.AIORDIE_SERVICE === '1';
    // Windows service: keep-awake always ON; hibernation guard DEFAULT ON
    // (opt OUT with AIORDIE_DISABLE_HIBERNATION=1). Interactive CLI keeps the
    // existing opt-in behavior (--disable-hibernation).
    const hibernationEnabled = process.platform === 'win32'
      && (isService
        ? process.env.AIORDIE_DISABLE_HIBERNATION !== '1'
        : process.env.AIORDIE_DISABLE_HIBERNATION === '1');
    this.keepaliveManager = options.keepaliveManager || new KeepaliveManager({
      enabled: process.platform === 'win32'
        ? (isService || process.env.AIORDIE_DISABLE_KEEPALIVE !== '1')
        : false,
    });
    this.hibernationGuard = options.hibernationGuard || new HibernationGuard({
      enabled: hibernationEnabled,
    });
    this.meshUrl = options.meshUrl || null;
    this._shuttingDown = false;
    this._crashTimestamps = [];
    this._updateListeners = [];
  }

  async start() {
    this.keepaliveManager.start();
    this.hibernationGuard.run();
    this.wakeHandler.start();
    await this._bootServer();
    this.autoUpdater.start();
    // Fleet registration is best-effort; the daemon runs standalone offline.
    this.fleetClient.start().catch(() => { /* ignore */ });
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('message', (msg) => {
      if (msg && msg.type === 'shutdown') this.shutdown('ipc');
    });
  }

  async _bootServer() {
    const record = await this.serverManager.spawnServer(this.serverBinary, this.serverArgs);
    this.serverManager.current = record;
    this._wireServerEvents(record);
    return record;
  }

  _wireServerEvents(record) {
    const proc = record.proc;
    proc.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === ipc.MSG.STATUS && typeof msg.ptyActivityAt === 'number') {
        this.autoUpdater.markPtyActivity();
      }
      if (msg.type === 'pty_register' && msg.ptyId && msg.pid) {
        this.ptyManager.register(msg.ptyId, msg.pid, msg.bridgeType, record.pid);
      }
      if (msg.type === 'pty_unregister' && msg.ptyId) {
        // confirmUnregister swallows the old server's post-handoff death
        // rattle (first unregister after a transfer) and reaps the record
        // only on a genuine session end.
        this.ptyManager.confirmUnregister(msg.ptyId);
      }
      if (msg.type === 'update_apply_request') {
        this.applyUpdate().catch(() => { /* surfaced via status endpoint */ });
      }
    });
    proc.on('exit', (code) => {
      if (this._shuttingDown) return;
      // A superseded record (a swap promoted a newer server while this one
      // was still tearing down) must not trigger respawn logic.
      if (this.serverManager.current && this.serverManager.current.proc !== proc) return;
      const serverPid = record.pid;
      // Reap ONLY PTYs owned by the dead server; handed-off PTYs belong to
      // the new server and survive. During swapServer the records move first.
      if (code !== 75) this.ptyManager.reapServer(serverPid);
      this._scheduleRespawn(code);
    });
  }

  _scheduleRespawn(code) {
    if (this._shuttingDown) return;
    if (code === 78) {
      console.error('[supervisor] server rejected startup; not respawning');
      process.exit(78);
      return;
    }
    const now = Date.now();
    this._crashTimestamps.push(now);
    this._crashTimestamps = this._crashTimestamps.filter((t) => now - t < 3600000);
    const tight = this._crashTimestamps.filter((t) => now - t < 30000).length;
    const delay = code === 75 ? RESTART_DELAY_MS
      : tight >= 3 ? 60000
      : CRASH_RESTART_DELAY_MS;
    setTimeout(() => {
      if (this._shuttingDown) return;
      this._bootServer().catch((err) => {
        console.error('[supervisor] respawn failed:', err && err.message);
        this._scheduleRespawn(1);
      });
    }, delay);
  }

  async swapServer(newBinary, args, env, opts) {
    await this.fleetClient.reportUpdating().catch(() => { /* ignore */ });
    const result = await this.serverManager.swapServer(
      newBinary,
      args || this.serverArgs,
      env || {},
      {
        ...(opts || {}),
        // Wire the candidate the moment it is READY (before handoff), so
        // adopt-respawn pty_register frames attribute to the new server.
        // (Re-wiring here post-promote would double-register handlers.)
        onRecord: (rec) => this._wireServerEvents(rec),
      }
    );
    await this.fleetClient.reportHealthy().catch(() => { /* ignore */ });
    return result;
  }

  async applyUpdate() {
    const result = await this.autoUpdater.apply();
    for (const fn of this._updateListeners) {
      try { fn(result); } catch (_) { /* ignore */ }
    }
    return result;
  }

  onUpdateApplied(fn) {
    // Bounded (north-star invariant): listeners register once per consumer;
    // cap + drop-oldest guards a pathological re-register loop.
    if (typeof fn !== 'function') return;
    if (this._updateListeners.length >= 64) this._updateListeners.shift();
    this._updateListeners.push(fn);
  }

  notifyUpdateReady(version) {
    // Forward to the live Server for WS broadcast to Settings UI.
    const cur = this.serverManager.current;
    if (cur && cur.proc && cur.proc.connected) {
      try { cur.proc.send(ipc.updateReady(version)); } catch (_) { /* ignore */ }
    }
  }

  updateStatus() {
    return {
      currentVersion: this.autoUpdater.currentVersion,
      pending: this.autoUpdater.pendingUpdate,
      idleMs: this.autoUpdater.idleMs(),
      supervisorPid: process.pid,
      serverPid: this.serverManager.current && this.serverManager.current.pid,
      ptys: this.ptyManager.size,
    };
  }

  _onWake(gapMs) {
    console.log(`[supervisor] wake detected after ${Math.round(gapMs / 1000)}s sleep; verifying server`);
    if (!this.serverManager.isRunning()) {
      this._bootServer().catch((err) => console.error('[supervisor] resume respawn failed:', err && err.message));
    }
  }

  async shutdown(reason) {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    console.log(`[supervisor] shutting down (${reason})`);
    this.autoUpdater.stop();
    this.wakeHandler.stop();
    try { await this.fleetClient.stop(); } catch (_) { /* ignore */ }
    const cur = this.serverManager.current;
    if (cur) await this.serverManager.gracefulShutdown(cur, 'user');
    try { this.keepaliveManager.releaseSync(); } catch (_) { /* ignore */ }
    process.exit(0);
  }
}

module.exports = { Supervisor };
