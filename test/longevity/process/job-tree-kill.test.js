'use strict';

// Integration regression for the deterministic-shutdown guarantee on Windows.
//
// Proves the kernel Job Object mechanism end to end against an UNCATCHABLE kill:
//   1. Per-PTY style: create a kill-on-close job, assign a child that has a grandchild,
//      close the job handle → assert the whole subtree (incl. the grandchild) dies.
//   2. Supervisor style: a self-assigned parent spawns child→grandchild, then is killed
//      with `taskkill /F` (no cleanup code runs) → assert the grandchild dies via the OS
//      closing the in-process job handle on parent death.
//
// This is the live proof that node/bun grandchildren cannot survive supervisor death and
// that nothing in the spawned tree breaks away from the job. Windows-only (the mechanism
// is Windows-specific); auto-skips elsewhere.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const FIXTURE = path.join(__dirname, 'fixtures', 'jobguard-parent.js');

function pidAlive(pid) {
  // tasklist is the authoritative liveness check on Windows.
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return !!r.stdout && new RegExp(`\\b${pid}\\b`).test(r.stdout);
}

function waitFor(fn, timeoutMs, intervalMs = 100) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = fn(); } catch (_) { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('deterministic shutdown: Job Object tree kill (Windows)', function () {
  this.timeout(20000);

  before(function () {
    if (process.platform !== 'win32') this.skip();
    const jg = require('../../../src/job-guard');
    if (!jg.isAvailable()) this.skip(); // koffi/job unavailable on this runner
  });

  it('per-PTY job: closing the job handle kills the assigned subtree (grandchild)', function (done) {
    const jg = require('../../../src/job-guard');
    const gcFile = path.join(os.tmpdir(), `aod-gc-${process.pid}-${Date.now()}.pid`);
    try { fs.rmSync(gcFile, { force: true }); } catch (_) { /* ignore */ }

    const job = jg.createKillOnCloseJob();
    assert.ok(job, 'job creation failed');

    // Parent (not self-assigned; we assign it to the job) → child → grandchild.
    const child = spawn(process.execPath, [FIXTURE, gcFile], { stdio: ['ignore', 'pipe', 'ignore'] });
    let ready = '';
    child.stdout.on('data', (d) => { ready += d.toString(); });

    (async () => {
      try {
        const gotReady = await waitFor(() => /FIXTURE_READY/.test(ready) && fs.existsSync(gcFile), 8000);
        assert.ok(gotReady, 'fixture did not become ready');
        const gcPid = parseInt(fs.readFileSync(gcFile, 'utf8').trim(), 10);
        assert.ok(gcPid > 0, 'no grandchild pid');
        assert.ok(jg.assignPid(job, child.pid), 'assignPid(parent) failed');
        assert.ok(pidAlive(gcPid), 'grandchild should be alive before close');

        jg.closeJob(job); // KILL_ON_JOB_CLOSE

        const dead = await waitFor(() => !pidAlive(gcPid), 6000);
        assert.ok(dead, 'grandchild survived job close (FAIL: it broke away or was not in the job)');
        done();
      } catch (e) {
        try { child.kill(); } catch (_) { /* ignore */ }
        done(e);
      } finally {
        try { fs.rmSync(gcFile, { force: true }); } catch (_) { /* ignore */ }
      }
    })();
  });

  it('supervisor job: an uncatchable taskkill /F of the self-assigned parent reaps the grandchild', function (done) {
    const gcFile = path.join(os.tmpdir(), `aod-gc-${process.pid}-${Date.now()}-2.pid`);
    try { fs.rmSync(gcFile, { force: true }); } catch (_) { /* ignore */ }

    // The fixture self-assigns to a kill-on-close job (like the supervisor does).
    const parent = spawn(process.execPath, [FIXTURE, gcFile], { stdio: ['ignore', 'pipe', 'ignore'] });
    let ready = '';
    parent.stdout.on('data', (d) => { ready += d.toString(); });

    (async () => {
      let gcPid = 0;
      try {
        const gotReady = await waitFor(() => /FIXTURE_READY/.test(ready) && fs.existsSync(gcFile), 8000);
        assert.ok(gotReady, 'fixture did not become ready');
        gcPid = parseInt(fs.readFileSync(gcFile, 'utf8').trim(), 10);
        assert.ok(gcPid > 0, 'no grandchild pid');
        assert.ok(pidAlive(gcPid), 'grandchild should be alive before kill');

        // Uncatchable kill of the parent — NO cleanup code in the parent runs.
        spawnSync('taskkill', ['/F', '/PID', String(parent.pid)], { windowsHide: true });

        const dead = await waitFor(() => !pidAlive(gcPid), 6000);
        assert.ok(dead, 'grandchild survived an uncatchable parent kill (FAIL: job did not reap on process death)');
        done();
      } catch (e) {
        if (gcPid) { try { spawnSync('taskkill', ['/F', '/PID', String(gcPid)], { windowsHide: true }); } catch (_) { /* ignore */ } }
        done(e);
      } finally {
        try { fs.rmSync(gcFile, { force: true }); } catch (_) { /* ignore */ }
      }
    })();
  });

  // The breakaway GATE: a child spawned by a shell running inside a REAL node-pty ConPTY
  // must stay in an ancestor job. If this passes, node-pty/ConPTY sets no
  // CREATE_BREAKAWAY_FROM_JOB and the whole approach holds. Treat a failure here after a
  // node-pty upgrade as "node-pty reintroduced breakaway." (See docs/specs/process-shutdown.md.)
  it('node-pty ConPTY: a grandchild of the PTY shell is reaped when the per-PTY job closes', function (done) {
    const pty = require('@lydell/node-pty');
    const jg = require('../../../src/job-guard');
    const gcFile = path.join(os.tmpdir(), `aod-pty-gc-${process.pid}-${Date.now()}.pid`);
    try { fs.rmSync(gcFile, { force: true }); } catch (_) { /* ignore */ }

    const shell = process.env.ComSpec || 'cmd.exe';
    const term = pty.spawn(shell, [], { name: 'xterm-256color', cols: 80, rows: 30, cwd: process.cwd(), env: process.env });

    // Put the PTY shell in its own kill-on-close job (mirrors base-bridge._attachPtyJob),
    // BEFORE it spawns the grandchild, so the grandchild auto-joins.
    const job = jg.createKillOnCloseJob();
    assert.ok(job, 'job creation failed');
    assert.ok(jg.assignPid(job, term.pid), 'assignPid(node-pty shell) failed');

    // Have the shell spawn a detached long-lived node grandchild that records its pid.
    const gcInline = "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1e9);";
    const gcOutForCmd = gcFile.replace(/\//g, '\\');
    term.write(`node -e "${gcInline}" "${gcOutForCmd}"\r`);

    (async () => {
      let gcPid = 0;
      try {
        const gotPid = await waitFor(() => {
          try { return fs.existsSync(gcFile) && parseInt(fs.readFileSync(gcFile, 'utf8').trim(), 10) > 0; }
          catch (_) { return false; }
        }, 10000);
        assert.ok(gotPid, 'node grandchild did not start inside the PTY');
        gcPid = parseInt(fs.readFileSync(gcFile, 'utf8').trim(), 10);
        assert.ok(pidAlive(gcPid), 'grandchild should be alive before job close');

        jg.closeJob(job); // KILL_ON_JOB_CLOSE — must reap the ConPTY grandchild

        const dead = await waitFor(() => !pidAlive(gcPid), 6000);
        assert.ok(dead, 'ConPTY grandchild survived job close — node-pty may have reintroduced CREATE_BREAKAWAY_FROM_JOB');
        done();
      } catch (e) {
        if (gcPid) { try { spawnSync('taskkill', ['/F', '/PID', String(gcPid)], { windowsHide: true }); } catch (_) { /* ignore */ } }
        done(e);
      } finally {
        try { term.kill(); } catch (_) { /* ignore */ }
        try { fs.rmSync(gcFile, { force: true }); } catch (_) { /* ignore */ }
      }
    })();
  });
});
