'use strict';

// Cross-platform best-effort process-tree teardown.
//
// This is the FALLBACK layer, used when the deterministic mechanism is unavailable:
//   - Windows: the per-PTY / supervisor Job Object is the real teardown. taskkill /T /F
//     is only the degraded-mode backstop (jobGuard:false — EDR/CLM blocked the job).
//   - POSIX: there is no job-object equivalent, so process-group kill IS the primary
//     teardown for PTYs. node-pty's Unix backend runs each PTY through forkpty→setsid,
//     so the PTY is a session/group leader and its pid == pgid; killing the negative pid
//     targets that whole group. Honest limitation: a grandchild that calls setsid() (some
//     daemonized MCP servers) starts its own group and escapes -pgid; only cgroup v2
//     delegation closes that gap (see docs/specs/process-shutdown.md).
//
// Never throws into the caller — teardown must not break shutdown.

const childProcess = require('child_process');

const IS_WIN = process.platform === 'win32';

// Windows degraded-mode tree kill via taskkill. Async (spawns a child); resolves true
// once taskkill exits 0, false otherwise. windowsHide + no shell (taskkill is a real exe).
function _taskkillTree(pid, spawnImpl) {
  return new Promise((resolve) => {
    try {
      const proc = spawnImpl('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      });
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      proc.on('exit', (code) => done(code === 0));
      proc.on('error', () => done(false));
      // Bound the wait so a hung taskkill can't stall shutdown.
      const t = setTimeout(() => done(false), 4000);
      if (t.unref) t.unref();
    } catch (_) {
      resolve(false);
    }
  });
}

// POSIX: kill the process group led by `pid` (negative-pid), then the pid itself as a
// fallback in case it is not actually a group leader.
function _killGroup(pid, signal, killImpl) {
  let any = false;
  try { killImpl(-pid, signal); any = true; } catch (_) { /* ESRCH / EPERM */ }
  try { killImpl(pid, signal); any = true; } catch (_) { /* may already be gone */ }
  return any;
}

/**
 * Best-effort tree-kill of `pid` and its descendants. Returns a Promise<boolean>.
 * Windows uses taskkill /T /F; POSIX kills the process group.
 * Injectable deps (`opts.spawn` / `opts.kill`) are for unit tests.
 */
function killProcessTree(pid, opts = {}) {
  const signal = opts.signal || 'SIGKILL';
  if (!pid || pid <= 0) return Promise.resolve(false);
  if (IS_WIN) {
    return _taskkillTree(pid, opts.spawn || childProcess.spawn);
  }
  return Promise.resolve(_killGroup(pid, signal, opts.kill || process.kill.bind(process)));
}

/**
 * Synchronous best-effort tree-kill for the uncaughtException path, where the event loop
 * is unsafe to rely on. Windows uses spawnSync(taskkill) with a short timeout; POSIX kills
 * the process group synchronously. Returns boolean. Never throws.
 */
function killProcessTreeSync(pid, opts = {}) {
  const signal = opts.signal || 'SIGKILL';
  if (!pid || pid <= 0) return false;
  if (IS_WIN) {
    try {
      const spawnSync = opts.spawnSync || childProcess.spawnSync;
      const r = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true, stdio: 'ignore', shell: false, timeout: 3000,
      });
      return !!r && r.status === 0;
    } catch (_) {
      return false;
    }
  }
  return _killGroup(pid, signal, opts.kill || process.kill.bind(process));
}

module.exports = {
  killProcessTree,
  killProcessTreeSync,
  // internal, exposed for tests
  _killGroup,
  _taskkillTree,
};
