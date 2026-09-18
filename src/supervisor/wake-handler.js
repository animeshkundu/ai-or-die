'use strict';

// WakeHandler — detect sleep/wake cycles and auto-resume the Server.
//
// The user-level service definition (systemd --user / launchd / Task
// Scheduler) already restarts the supervisor on wake in most cases; this
// module covers the gap where the supervisor SURVIVED the sleep but the
// Server child did not (or the 30s autosave timer jumped the clock and the
// watchdog needs a grace window).
//
// Detection strategy per platform:
//   linux  -> timer-gap heuristic on the supervisor heartbeat (delta >
//             WAKE_GAP_MS for a short-cadence tick implies suspend/resume),
//             plus systemd inhibitor + OnWake at the unit level.
//   darwin -> same timer-gap heuristic (launchd StartCalendarInterval +
//             PowerNap at the unit level).
//   win32  -> same timer-gap heuristic (Task Scheduler unlock trigger at
//             the unit level). The KeepaliveManager assertion cannot block a
//             host-initiated hibernate, so resume-after-wake is the contract.

const WAKE_GAP_MS = 60000; // a tick delayed >60s implies suspend/resume
const RESUME_GRACE_MS = 15000; // mirrors server._systemResumeGraceUntil

class WakeHandler {
  constructor(options = {}) {
    this._platform = options.platform || process.platform;
    this._now = options.now || Date.now;
    this._onWake = options.onWake || null;
    this._wakeGapMs = options.wakeGapMs || parseInt(process.env.AIORDIE_WAKE_GAP_MS, 10) || WAKE_GAP_MS;
    this._resumeGraceMs = options.resumeGraceMs || parseInt(process.env.AIORDIE_WAKE_GRACE_MS, 10) || RESUME_GRACE_MS;
    this._lastTick = null;
    this._timer = null;
    this.wakeCount = 0;
    this.resumeGraceUntil = 0;
  }

  start(intervalMs = 30000) {
    if (this._timer) return;
    this._lastTick = this._now();
    this._timer = setInterval(() => this.tick(), intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /**
   * One heartbeat tick. Returns { woke: boolean, gapMs }.
   * Pure enough to unit-test by injecting `now`.
   */
  tick(now = this._now()) {
    if (this._lastTick === null) {
      this._lastTick = now;
      return { woke: false, gapMs: 0 };
    }
    const gap = now - this._lastTick;
    this._lastTick = now;
    if (gap > this._wakeGapMs) {
      this.wakeCount += 1;
      this.resumeGraceUntil = now + this._resumeGraceMs;
      if (typeof this._onWake === 'function') {
        try { this._onWake({ gapMs: gap, wakeCount: this.wakeCount }); } catch (_) { /* ignore */ }
      }
      return { woke: true, gapMs: gap };
    }
    return { woke: false, gapMs: gap };
  }

  inResumeGrace(now = this._now()) {
    return now < this.resumeGraceUntil;
  }
}

module.exports = { WakeHandler, WAKE_GAP_MS, RESUME_GRACE_MS };
