'use strict';

// PtyManager — supervisor-side ownership of every PTY process.
//
// Why the supervisor owns PTYs: a binary update must replace the Server
// without killing any running Claude/Copilot/Opencode session. The Server
// is therefore stateless w.r.t. processes; the Supervisor (a ~200-line
// stable anchor that almost never updates) holds the lifecycles.
//
// Mechanism (mirrors docs/specs/process-shutdown.md):
//   - Windows: each PTY gets its own kill-on-close Job Object via koffi
//     (src/job-guard.js). Closing the handle reaps PTY + MCP grandchildren.
//   - POSIX: node-pty PTYs are session leaders (forkpty->setsid); teardown
//     escalates with kill(-pgid) via src/utils/process-tree.js.
// Handoff (update path) keeps the PTY alive and re-parents the *record*:
//   - POSIX: the PTY fd travels to the new Server over the SCM_RIGHTS
//     socket pair (see ipc-protocol.js); the process itself never dies.
//   - Windows: the new Server inherits the PTY handle via
//     PROC_THREAD_ATTRIBUTE_HANDLE_LIST and the supervisor re-assigns the
//     pid into the new Server's job scope; the process itself never dies.
//
// Never throws into the caller — teardown must not break shutdown.

const jobGuard = require('../job-guard');
const { killProcessTreeSync } = require('../utils/process-tree');

const IS_WIN = process.platform === 'win32';

class PtyManager {
  constructor(options = {}) {
    this._jobGuard = options.jobGuard || jobGuard;
    this._killTreeSync = options.killTreeSync || killProcessTreeSync;
    this._platform = options.platform || process.platform;
    // ptyId -> { pid, bridgeType, jobHandle, ownerServerPid, registeredAt }
    this._ptys = new Map();
  }

  get size() {
    return this._ptys.size;
  }

  /**
   * Register a freshly-spawned PTY. On Windows, attaches a dedicated
   * kill-on-close job BEFORE the CLI boots so MCP grandchildren auto-join.
   * Must be called synchronously after spawn (pid-reuse safety — see
   * job-guard.assignPid docs).
   */
  register(ptyId, pid, bridgeType, ownerServerPid) {
    if (!ptyId || !pid) return null;
    // Defensive: close a stale handle before overwriting (never leak kernel handles).
    this._closeJobFor(ptyId);
    const prior = this._ptys.get(ptyId);
    const record = {
      pid,
      bridgeType: bridgeType || 'unknown',
      jobHandle: null,
      ownerServerPid: ownerServerPid || null,
      registeredAt: Date.now(),
      // Preserve a pending death-rattle guard across re-registration: the
      // adopted respawn's pty_register can arrive BEFORE the old server's
      // teardown echo for the same ptyId. Either order must converge.
      handedOff: !!(prior && prior.handedOff),
    };
    if (this._platform === 'win32' && this._jobGuard.isAvailable()) {
      try {
        const handle = this._jobGuard.createKillOnCloseJob();
        if (handle && this._jobGuard.assignPid(handle, pid)) {
          record.jobHandle = handle;
        } else if (handle) {
          this._jobGuard.closeJob(handle);
        }
      } catch (_) { /* best-effort; degraded teardown covers it */ }
    }
    this._ptys.set(ptyId, record);
    return record;
  }

  get(ptyId) {
    return this._ptys.get(ptyId) || null;
  }

  pidsForServer(serverPid) {
    const out = [];
    for (const [ptyId, rec] of this._ptys) {
      if (rec.ownerServerPid === serverPid) out.push({ ptyId, ...rec });
    }
    return out;
  }

  /**
   * Re-parent PTY records from oldServerPid to newServerPid WITHOUT killing
   * any process. On Windows the supervisor also re-assigns each pid into the
   * new Server's job scope (best-effort; the per-PTY job still guards it).
   * Returns { transferred, failed }.
   */
  transferOwnership(oldServerPid, newServerPid, newServerJob = null) {
    let transferred = 0;
    let failed = 0;
    for (const [ptyId, rec] of this._ptys) {
      if (rec.ownerServerPid !== oldServerPid) continue;
      try {
        if (this._platform === 'win32' && newServerJob && this._jobGuard.isAvailable()) {
          // Best-effort re-scope; per-PTY job remains the primary guard.
          try { this._jobGuard.assignPid(newServerJob, rec.pid); } catch (_) { /* ignore */ }
        }
        rec.ownerServerPid = newServerPid;
        // Arm the death-rattle guard: the OLD server's teardown sends
        // pty_unregister for sessions it just released. The first
        // unregister after a transfer is that echo — consume it. A later
        // unregister is a genuine session end.
        rec.handedOff = true;
        transferred += 1;
      } catch (_) {
        failed += 1;
      }
    }
    return { transferred, failed };
  }

  /**
   * Deterministic teardown of ONE PTY: close its job (Windows reaps the
   * subtree atomically), else best-effort tree-kill. Idempotent.
   */
  destroy(ptyId) {
    const rec = this._ptys.get(ptyId);
    if (!rec) return false;
    this._ptys.delete(ptyId);
    const jobClosed = this._closeJobRecord(rec);
    if (!jobClosed && rec.pid) {
      try { this._killTreeSync(rec.pid); } catch (_) { /* best-effort */ }
    }
    return true;
  }

  /**
   * Reap every PTY owned by a dead Server (crash path). PTYs owned by other
   * servers are untouched — this is what makes the update handoff safe.
   */
  reapServer(serverPid) {
    let reaped = 0;
    for (const [ptyId, rec] of Array.from(this._ptys)) {
      if (rec.ownerServerPid === serverPid) {
        this.destroy(ptyId);
        reaped += 1;
      }
    }
    return reaped;
  }

  /**
   * Confirm an unregister notice from a Server. Returns:
   *   'ignored'   — the old server's post-handoff death rattle (first
   *                 unregister after a transfer); record kept alive.
   *   'destroyed' — genuine session end; record reaped + subtree torn down.
   *   'unknown'   — no such record; nothing to do.
   */
  confirmUnregister(ptyId) {
    const rec = this._ptys.get(ptyId);
    if (!rec) return 'unknown';
    if (rec.handedOff) {
      rec.handedOff = false;
      return 'ignored';
    }
    this.destroy(ptyId);
    return 'destroyed';
  }

  /**
   * Describe PTYs for a HANDOFF_START frame (no handles cross JSON IPC;
   * fds/handles travel via SCM_RIGHTS / inheritance).
   */
  describeForHandoff(serverPid) {
    return this.pidsForServer(serverPid).map((r) => ({
      ptyId: r.ptyId,
      bridgeType: r.bridgeType,
      pid: r.pid,
    }));
  }

  _closeJobFor(ptyId) {
    const rec = this._ptys.get(ptyId);
    if (rec) this._closeJobRecord(rec);
  }

  _closeJobRecord(rec) {
    if (!rec || !rec.jobHandle) return false;
    const h = rec.jobHandle;
    rec.jobHandle = null;
    try { return !!this._jobGuard.closeJob(h); } catch (_) { return false; }
  }
}

module.exports = { PtyManager, IS_WIN };
