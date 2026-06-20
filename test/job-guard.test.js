'use strict';

// Unit tests for src/job-guard.js — the Windows Job Object guard.
//
// On non-Windows CI the module is a documented no-op (isAvailable false, all calls
// return falsy) — assert that. On Windows, exercise the real koffi-backed path end to
// end: create a kill-on-close job, assign a spawned child, close the job, assert the
// child dies. This is also the live proof that the koffi struct marshaling + Win32
// bindings are correct on the runner.

const assert = require('assert');
const jobGuard = require('../src/job-guard');

describe('job-guard', function () {
  if (process.platform !== 'win32') {
    it('is a no-op on non-Windows', function () {
      assert.strictEqual(jobGuard.isAvailable(), false);
      assert.strictEqual(jobGuard.createKillOnCloseJob(), null);
      assert.strictEqual(jobGuard.assignSelf(null), false);
      assert.strictEqual(jobGuard.assignPid(null, 123), false);
      assert.strictEqual(jobGuard.closeJob(null), false);
    });
    return;
  }

  // --- Windows ---
  it('reports available (koffi loads + kernel32 binds)', function () {
    assert.strictEqual(jobGuard.isAvailable(), true, jobGuard._loadError() && String(jobGuard._loadError()));
  });

  it('creates a kill-on-close job handle', function () {
    const job = jobGuard.createKillOnCloseJob();
    assert.ok(job, 'expected a job handle');
    // Cleanup: closing an empty job is harmless (no processes assigned).
    jobGuard.closeJob(job);
  });

  it('kills an assigned child when the job handle closes (KILL_ON_JOB_CLOSE)', function (done) {
    this.timeout(8000);
    const { spawn } = require('child_process');
    const job = jobGuard.createKillOnCloseJob();
    assert.ok(job, 'job creation failed');

    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { stdio: 'ignore' });
    let exited = false;
    child.on('exit', () => { exited = true; });

    setTimeout(() => {
      assert.ok(child.pid, 'no child pid');
      assert.strictEqual(jobGuard.assignPid(job, child.pid), true, 'assignPid failed');
      jobGuard.closeJob(job); // fires KILL_ON_JOB_CLOSE
      setTimeout(() => {
        try {
          assert.strictEqual(exited, true, 'child should have been killed by KILL_ON_JOB_CLOSE');
          done();
        } catch (e) {
          try { child.kill(); } catch (_) { /* ignore */ }
          done(e);
        }
      }, 1500);
    }, 300);
  });
});
