'use strict';

// Heartbeat file for the user-level service.
//
// The Task/systemd/launchd definitions can restart a process that EXITED. None
// of them can tell "alive and serving" from "alive but wedged" — a supervisor
// blocked in an event-loop stall, or one whose server child died and whose own
// respawn logic is stuck, looks identical to a healthy process to every
// process-level supervisor. A file the daemon rewrites on a timer gives an
// out-of-process observer (src/supervisor/service-watchdog.js, run by a second
// scheduled task) a liveness signal that is independent of process state.
//
// Contract:
//   - write() is atomic (tmp + rename) and mode 0600; a reader never sees a
//     half-written file.
//   - write() never throws: a heartbeat problem must never break the daemon.
//   - the timer is unref()'d, so it can never hold the process open.
//   - the payload is small and diagnostic-only. It carries no secrets: pid,
//     phase, server pid, version, timestamps.

const fs = require('fs');
const path = require('path');

const DEFAULT_INTERVAL_MS = 15000;

function heartbeatFile(options = {}) {
  if (options.file) return options.file;
  try {
    return require('./constants').HEARTBEAT_FILE;
  } catch (_) {
    return path.join(process.env.AI_OR_DIE_HOME || '.', 'run', 'heartbeat.json');
  }
}

function writeHeartbeat(payload, options = {}) {
  const file = heartbeatFile(options);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify({
      pid: process.pid,
      ...payload,
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now(),
    });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

function readHeartbeat(options = {}) {
  const file = heartbeatFile(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/** Age of the heartbeat in ms, or Infinity when missing/unparseable. */
function heartbeatAgeMs(options = {}) {
  const hb = readHeartbeat(options);
  if (!hb) return Infinity;
  const at = Number.isFinite(hb.updatedAtMs) ? hb.updatedAtMs : Date.parse(hb.updatedAt || '');
  if (!Number.isFinite(at)) return Infinity;
  return Math.max(0, Date.now() - at);
}

class Heartbeat {
  constructor(options = {}) {
    this._fileOptions = options.file ? { file: options.file } : {};
    // Boot identity: the watchdog needs to tell "restarted recently and still
    // starting" (never restart) from "has been in a boot phase for minutes"
    // (a wedged boot: no server, no sessions, restart is safe and necessary).
    this.startedAtMs = Date.now();
    const raw = parseInt(
      options.intervalMs || process.env.AIORDIE_HEARTBEAT_MS, 10
    );
    this.intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_INTERVAL_MS;
    this._timer = null;
    this._phase = 'init';
    this._extra = {};
    this._resolveStatus = options.status || null;
  }

  /** Write one heartbeat now. `phase` is a short label (boot/ready/shutdown). */
  beat(phase, extra) {
    if (phase) this._phase = phase;
    if (extra && typeof extra === 'object') this._extra = { ...this._extra, ...extra };
    let status = null;
    if (typeof this._resolveStatus === 'function') {
      try { status = this._resolveStatus(); } catch (_) { status = null; }
    }
    return writeHeartbeat(
      {
        phase: this._phase,
        startedAtMs: this.startedAtMs,
        ...this._extra,
        ...(status && typeof status === 'object' ? { status } : {}),
      },
      this._fileOptions
    );
  }

  start(phase) {
    if (this._timer) return this;
    this.beat(phase || this._phase);
    this._timer = setInterval(() => this.beat(), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = {
  Heartbeat,
  heartbeatFile,
  writeHeartbeat,
  readHeartbeat,
  heartbeatAgeMs,
  DEFAULT_INTERVAL_MS,
};
