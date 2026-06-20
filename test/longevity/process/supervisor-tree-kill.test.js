'use strict';

// Integration regression: the REAL bin/supervisor.js establishes the kill-on-close Job
// Object and self-assigns before forking, so an UNCATCHABLE kill of the supervisor
// (`taskkill /F`, no cleanup runs) reaps its forked child via the OS closing the in-process
// job handle on supervisor death.
//
// The child fixture installs no parent-death handling of its own — if it survives, only the
// job could have reaped it, so this is a tight proof of the supervisor wiring (not just the
// job-guard module in isolation). Windows-only; auto-skips elsewhere (POSIX is best-effort
// and the real server's IPC-disconnect watchdog covers it, exercised by other suites).

const assert = require('assert');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SUPERVISOR = path.join(REPO_ROOT, 'bin', 'supervisor.js');
const CHILD_FIXTURE = path.join(__dirname, 'fixtures', 'supervised-child.js');

function pidAlive(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return !!r.stdout && new RegExp(`\\b${pid}\\b`).test(r.stdout);
}

function waitFor(fn, timeoutMs, intervalMs = 100) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      let ok = false; try { ok = fn(); } catch (_) { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('deterministic shutdown: supervisor job reaps forked child on uncatchable kill (Windows)', function () {
  this.timeout(25000);

  before(function () {
    if (process.platform !== 'win32') this.skip();
    const jg = require('../../../src/job-guard');
    if (!jg.isAvailable()) this.skip();
  });

  it('taskkill /F of the supervisor kills its forked child via KILL_ON_JOB_CLOSE', async function () {
    let out = '';
    const sup = spawn(process.execPath, [SUPERVISOR], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SUPERVISOR_CHILD_SCRIPT: CHILD_FIXTURE },
    });
    sup.stdout.on('data', (d) => { out += d.toString(); });
    sup.stderr.on('data', (d) => { out += d.toString(); });

    let childPid = 0;
    try {
      const gotChild = await waitFor(() => /CHILD_PID (\d+)/.test(out), 12000);
      assert.ok(gotChild, `child never started. supervisor output:\n${out.slice(-400)}`);
      childPid = parseInt(out.match(/CHILD_PID (\d+)/)[1], 10);
      assert.ok(childPid > 0, 'no child pid');

      // Sanity: confirm the supervisor reported the guard active. If it did NOT (e.g. a
      // locked-down runner), this test's guarantee does not apply — skip rather than fail.
      if (!/process-guard: kill-on-close job active/.test(out)) {
        this.skip();
        return;
      }

      assert.ok(pidAlive(childPid), 'child should be alive before the kill');

      // Uncatchable kill of the SUPERVISOR only. No cleanup code in the supervisor runs.
      spawnSync('taskkill', ['/F', '/PID', String(sup.pid)], { windowsHide: true });

      const dead = await waitFor(() => !pidAlive(childPid), 8000);
      assert.ok(dead, 'forked child survived an uncatchable supervisor kill (FAIL: job did not reap it)');
    } finally {
      if (childPid && pidAlive(childPid)) { try { spawnSync('taskkill', ['/F', '/PID', String(childPid)], { windowsHide: true }); } catch (_) { /* ignore */ } }
      try { spawnSync('taskkill', ['/F', '/T', '/PID', String(sup.pid)], { windowsHide: true }); } catch (_) { /* ignore */ }
    }
  });
});
