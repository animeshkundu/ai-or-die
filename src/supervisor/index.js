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
const { ServiceInstaller, isServiceRuntime } = require('./service-installer');
const { WakeHandler } = require('./wake-handler');
const { FleetClient } = require('./fleet-client');
const KeepaliveManager = require('../keepalive-manager');
const HibernationGuard = require('../hibernation-guard');
const ipc = require('./ipc-protocol');
const { STABLE_SERVER_BIN, supervisorVersion } = require('./constants');

const RESTART_DELAY_MS = parseInt(process.env.RESTART_DELAY_MS, 10) || 1000;
const CRASH_RESTART_DELAY_MS = parseInt(process.env.CRASH_RESTART_DELAY_MS, 10) || 3000;
// Tiered backoff (mirrors bin/supervisor.js PROC-01): tight loop and slow churn.
const TIER1_WINDOW_MS = parseInt(process.env.SUPERVISOR_TIER1_WINDOW_MS, 10) || 30000;
const TIER1_MAX = parseInt(process.env.SUPERVISOR_TIER1_MAX, 10) || 3;
const TIER1_DELAY_MS = parseInt(process.env.SUPERVISOR_TIER1_DELAY_MS, 10) || 60000;
const TIER2_WINDOW_MS = parseInt(process.env.SUPERVISOR_TIER2_WINDOW_MS, 10) || 3600000;
const TIER2_MAX = parseInt(process.env.SUPERVISOR_TIER2_MAX, 10) || 5;
const TIER2_DELAY_MS = parseInt(process.env.SUPERVISOR_TIER2_DELAY_MS, 10) || 300000;
const CRASH_TIMESTAMPS_CAP = parseInt(process.env.SUPERVISOR_CRASH_CAP, 10) || 1024;

class Supervisor {
  constructor(options = {}) {
    this.version = options.version || supervisorVersion();
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
    // Service detection: explicit env (systemd/launchd units) OR the staged
    // stable-supervisor + service.json sentinel (Task Scheduler Exec has no
    // env block, so the task cannot pass AIORDIE_SERVICE=1).
    const isService = options.isService !== undefined
      ? !!options.isService
      : (process.env.AIORDIE_SERVICE === '1' || isServiceRuntime());
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
    this._startKeepaliveWatchdog();
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('message', (msg) => {
      if (msg && msg.type === 'shutdown') this.shutdown('ipc');
    });
  }

  // The keepalive helper can die hours in (AV/EDR kill, CLM block) while the
  // supervisor lives on — and then the machine silently becomes sleepable.
  // Watchdog: every minute, respawn a helper that died without a release.
  // Bounded with backoff: after 5 fast failures (e.g. permanent CLM block),
  // retry every ~10th tick to avoid fork+Add-Type compile spam; the degraded
  // state stays visible via updateStatus()/`service status`.
  _startKeepaliveWatchdog() {
    if (this._keepaliveWatchdog) return;
    this._keepaliveWatchdogFails = 0;
    this._keepaliveWatchdog = setInterval(() => {
      try {
        if (this._shuttingDown) return;
        const km = this.keepaliveManager;
        if (!km || typeof km.isEnabled !== 'function' || typeof km.isActive !== 'function') return;
        if (!km.isEnabled()) return;
        if (km.isActive()) {
          this._keepaliveWatchdogFails = 0;
          return;
        }
        this._keepaliveWatchdogFails += 1;
        if (this._keepaliveWatchdogFails <= 5) {
          console.warn('[supervisor] keepalive helper gone; respawning wake assertion');
        } else if (this._keepaliveWatchdogFails % 10 !== 0) {
          return; // back off: retry ~every 10 min while permanently blocked
        }
        km.start();
      } catch (_) { /* never break the daemon */ }
    }, 60000);
    if (this._keepaliveWatchdog.unref) this._keepaliveWatchdog.unref();
  }

  keepaliveStatus() {
    try {
      const km = this.keepaliveManager;
      if (!km || typeof km.isEnabled !== 'function' || !km.isEnabled()) return { enabled: false };
      const active = typeof km.isActive === 'function' ? km.isActive() : undefined;
      return { enabled: true, active: !!active, watchdogFails: this._keepaliveWatchdogFails || 0 };
    } catch (_) {
      return { enabled: false };
    }
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
        // Coarse activity signal (see maybeAutoApply gate): a session event
        // proves the machine is not idle even when no STATUS frame arrives.
        try { this.autoUpdater.markPtyActivity(); } catch (_) {}
      }
      if (msg.type === 'pty_unregister' && msg.ptyId) {
        // confirmUnregister swallows the old server's post-handoff death
        // rattle (first unregister after a transfer) and reaps the record
        // only on a genuine session end.
        this.ptyManager.confirmUnregister(msg.ptyId);
        try { this.autoUpdater.markPtyActivity(); } catch (_) {}
      }
      if (msg.type === 'update_apply_request') {
        // Legacy fire-and-forget senders omit `id` (no reply possible).
        // New children (SupervisorProxy) attach `id` and await the matching
        // update_apply_response — this is what powers POST /api/update/apply.
        //
        // Delivery subtlety: the requesting HTTP client is pinned to the OLD
        // server's socket, and the swap shuts the old server down. Answering
        // after teardown would hang up, so the provisional result goes out
        // via onPreShutdown while the old child is still alive (the swap is
        // decided by then; only the local promote copy remains). The proxy
        // settles on the first reply and ignores the post-apply send below.
        if (msg.id === null || typeof msg.id === 'undefined') {
          this.applyUpdate().catch(() => { /* surfaced via status endpoint */ });
          return;
        }
        let answered = false;
        const answerEarly = (preview) => {
          if (answered) return;
          answered = true;
          // Micro-race accepted by design: promote (local file copy) runs
          // after this send; on the near-impossible promote failure the
          // pending update is retained, the error is logged, and the status
          // endpoint reports the truth for a retry.
          try {
            proc.send(ipc.updateApplyResponse(msg.id, true, {
              applied: true,
              promoted: true,
              version: preview.version,
              ptys: preview.ptys,
              portTakeover: preview.portTakeover,
            }));
          } catch (_) { /* ignore */ }
        };
        (async () => {
          try {
            const result = await this.applyUpdate({ onPreShutdown: answerEarly });
            if (!answered) {
              answered = true;
              try { proc.send(ipc.updateApplyResponse(msg.id, true, result)); } catch (_) { /* ignore */ }
            }
          } catch (err) {
            if (!answered) {
              answered = true;
              try { proc.send(ipc.updateApplyResponse(msg.id, false, (err && err.message) || 'apply failed')); } catch (_) { /* ignore */ }
            }
          }
        })();
        return;
      }
      if (msg.type === ipc.MSG.UPDATE_STATUS_REQUEST && msg.id !== null && typeof msg.id !== 'undefined') {
        // Synchronous and infallible by construction (updateStatus builds a
        // plain object); still guarded so a bug here can never break IPC.
        try {
          proc.send(ipc.updateStatusResponse(msg.id, true, this.updateStatus()));
        } catch (_) { /* ignore */ }
        return;
      }
      if (msg.type === ipc.MSG.UPDATE_CHECK_REQUEST && msg.id !== null && typeof msg.id !== 'undefined') {
        (async () => {
          try {
            const result = await this.autoUpdater.check();
            try { proc.send(ipc.updateCheckResponse(msg.id, true, result)); } catch (_) { /* ignore */ }
          } catch (err) {
            try { proc.send(ipc.updateCheckResponse(msg.id, false, (err && err.message) || 'check failed')); } catch (_) { /* ignore */ }
          }
        })();
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
    // Intentional restarts (exit 75) are not crashes: counting them would let
    // five routine restarts in an hour push the NEXT genuine crash straight
    // into the Tier-2 5-minute throttle.
    if (code !== 75) {
      this._crashTimestamps.push(now);
    }
    this._crashTimestamps = this._crashTimestamps.filter((t) => now - t < TIER2_WINDOW_MS);
    if (this._crashTimestamps.length > CRASH_TIMESTAMPS_CAP) {
      this._crashTimestamps = this._crashTimestamps.slice(-CRASH_TIMESTAMPS_CAP);
    }
    const tight = this._crashTimestamps.filter((t) => now - t < TIER1_WINDOW_MS).length;
    const sustained = this._crashTimestamps.length;
    let delay;
    if (code === 75) {
      delay = RESTART_DELAY_MS;
    } else if (sustained >= TIER2_MAX) {
      console.error(
        `[supervisor] TIER 2: ${sustained} crashes in 1h; throttling restart to ${Math.round(TIER2_DELAY_MS / 60000)}m`
      );
      delay = TIER2_DELAY_MS;
    } else if (tight >= TIER1_MAX) {
      console.error(
        `[supervisor] TIER 1: ${tight} crashes in 30s; throttling restart to ${Math.round(TIER1_DELAY_MS / 1000)}s`
      );
      delay = TIER1_DELAY_MS;
    } else {
      delay = CRASH_RESTART_DELAY_MS;
    }
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
        // Forward caller hooks (e.g. onPreShutdown for the apply-response
        // flush) alongside the internal wiring below.
        ...(opts || {}),
        // Wire the candidate the moment it is READY (before handoff), so
        // adopt-respawn pty_register frames attribute to the new server.
        // (Re-wiring here post-promote would double-register handlers.)
        onRecord: (rec) => {
          this._wireServerEvents(rec);
          if (opts && typeof opts.onRecord === 'function') {
            try { opts.onRecord(rec); } catch (_) { /* ignore */ }
          }
        },
      }
    );
    await this.fleetClient.reportHealthy().catch(() => { /* ignore */ });
    return result;
  }

  async applyUpdate(opts) {
    const result = await this.autoUpdater.apply(opts);
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
      keepalive: this.keepaliveStatus(),
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
    try { if (this._keepaliveWatchdog) clearInterval(this._keepaliveWatchdog); } catch (_) {}
    this._keepaliveWatchdog = null;
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
