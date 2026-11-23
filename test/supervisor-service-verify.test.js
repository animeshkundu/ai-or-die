'use strict';

// Install self-test: the command must not report success unless the daemon it
// started actually came up.
//
// A registered task says nothing about whether the daemon runs — the original
// MODULE_NOT_FOUND install "succeeded" for months. These tests pin the three
// ways the check could lie: trusting a stale heartbeat from an earlier run,
// trusting a heartbeat that exists but is not the one this install produced,
// and trusting a heartbeat while the task is actually not running.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { verifyInstalled, parseServiceArgs } = require('../src/supervisor/service-cli');
const { writeHeartbeat } = require('../src/supervisor/heartbeat');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-verify-'));
}

function recorder() {
  const lines = [];
  return {
    lines,
    log: (m) => lines.push(String(m)),
    info: (m) => lines.push(String(m)),
    warn: (m) => lines.push(String(m)),
    error: (m) => lines.push(String(m)),
    debug: () => {},
  };
}

describe('service install self-test', function () {
  it('passes only on a heartbeat written after the install started', async function () {
    const dir = sandbox();
    const file = path.join(dir, 'heartbeat.json');
    try {
      // Leftover beacon from a previous run: it must NOT satisfy the check.
      writeHeartbeat({ phase: 'ready', pid: process.pid }, { file });
      const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
      const installer = {
        logFilePath: () => path.join(dir, 'supervisor.log'),
        heartbeatFilePath: () => file,
        status: () => ({ taskState: 'Running' }),
      };
      const result = await verifyInstalled(installer, 1200, recorder(), {
        since: stale.updatedAtMs + 1000,
      });
      assert.strictEqual(result.ok, false, 'a pre-existing heartbeat is not proof');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a heartbeat whose PROCESS started before the install (requireProcessStart)', async function () {
    const dir = sandbox();
    const file = path.join(dir, 'heartbeat.json');
    try {
      // A leftover daemon (previous install / orphaned supervisor on the same
      // base dir) keeps beating, so `updatedAtMs` is fresh forever. Only the
      // process start time proves it is not the daemon this install launched.
      const since = Date.now();
      writeHeartbeat({ phase: 'ready', startedAtMs: since - 3600000 }, { file });
      const installer = {
        logFilePath: () => path.join(dir, 'supervisor.log'),
        heartbeatFilePath: () => file,
        status: () => ({ taskState: 'Ready' }),
      };
      // Refresh the file so `updatedAtMs` is unambiguously past `since`: the
      // check must fail on the process start alone, not on staleness.
      const fresh = await verifyInstalled(installer, 300, recorder(), {
        since,
        requireProcessStart: false,
      });
      assert.strictEqual(fresh.ok, true, 'without the flag a fresh beat still counts');

      writeHeartbeat({ phase: 'ready', startedAtMs: since - 3600000 }, { file });
      const logger = recorder();
      const strict = await verifyInstalled(installer, 300, logger, {
        since,
        requireProcessStart: true,
      });
      assert.strictEqual(strict.ok, false, 'a pre-existing PROCESS is not proof');
      assert.strictEqual(strict.reason, 'no-process-started-since');
      const printed = logger.lines.join('\n');
      assert.ok(
        printed.includes('no heartbeat from a process started after this install began'),
        `the failure names the real reason: ${printed}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a heartbeat from a process started after the install began', async function () {
    const dir = sandbox();
    const file = path.join(dir, 'heartbeat.json');
    try {
      const since = Date.now();
      writeHeartbeat({ phase: 'ready', startedAtMs: since + 5 }, { file });
      const installer = {
        logFilePath: () => path.join(dir, 'supervisor.log'),
        heartbeatFilePath: () => file,
        status: () => ({ taskState: 'Running' }),
      };
      const result = await verifyInstalled(installer, 300, recorder(), { since, requireProcessStart: true });
      assert.strictEqual(result.ok, true, 'the daemon this install started is the proof');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runServiceCommand requires a new process, except for an unchanged already-running task', async function () {
    const { runServiceCommand } = require('../src/supervisor/service-cli');
    const dir = sandbox();
    const file = path.join(dir, 'heartbeat.json');
    try {
      // One heartbeat, written by a process that predates the install, kept
      // fresh by its own 15s timer (simulated: written after `since` is taken).
      const installer = (restarted) => ({
        install: async () => {
          writeHeartbeat({ phase: 'ready', startedAtMs: Date.now() - 3600000 }, { file });
          return { platform: 'win32', unchanged: true, restarted };
        },
        logFilePath: () => path.join(dir, 'supervisor.log'),
        heartbeatFilePath: () => file,
        status: () => ({ taskState: 'Ready' }),
      });
      const parsed = { ...parseServiceArgs([]), verifyTimeoutMs: 300 };
      // The daemon could not be (re)started, yet an old daemon is beating here:
      // this is exactly the reinstall that used to print "verified: daemon is up".
      await assert.rejects(
        () => runServiceCommand('install', parsed, installer('start-failed'), recorder()),
        (err) => err.code === 'EVERIFY' && /leftover daemon/.test(err.message)
      );
      // Unchanged definition + task already Running means nothing was restarted,
      // so an older startedAtMs IS the genuine proof of health.
      const ok = await runServiceCommand('install', parsed, installer('running'), recorder());
      assert.strictEqual(ok.verified, true, 'already-running daemon still verifies');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with the task state and log tail when nothing comes up', async function () {
    const dir = sandbox();
    try {
      fs.writeFileSync(path.join(dir, 'supervisor.log'), 'line one\nError: Cannot find module\n');
      const logger = recorder();
      const installer = {
        logFilePath: () => path.join(dir, 'supervisor.log'),
        status: () => ({ taskState: 'Ready', installed: true, active: false }),
      };
      const result = await verifyInstalled(installer, 300, logger, { since: Date.now() });
      assert.strictEqual(result.ok, false);
      assert.ok(result.logTail.includes('Cannot find module'), 'the real failure is surfaced');
      const printed = logger.lines.join('\n');
      assert.ok(printed.includes('Ready'), 'task state is reported');
      assert.ok(printed.includes('Cannot find module'), 'log tail is reported');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws when there is no log and status explodes', async function () {
    const installer = {
      logFilePath: () => path.join(os.tmpdir(), 'aod-does-not-exist', '\u0000x', 'supervisor.log'),
      status: () => { throw new Error('schtasks missing'); },
    };
    const result = await verifyInstalled(installer, 200, recorder(), { since: Date.now() });
    assert.strictEqual(result.ok, false);
  });

  it('refuses --dry-run on install instead of installing for real', async function () {
    const { runServiceCommand } = require('../src/supervisor/service-cli');
    let touched = false;
    const installer = {
      install: async () => { touched = true; return {}; },
    };
    await assert.rejects(
      () => runServiceCommand('install', parseServiceArgs(['--dry-run']), installer, recorder()),
      (err) => err.code === 'EUSAGE' && /only supported by `service watchdog`/.test(err.message)
    );
    assert.strictEqual(touched, false, 'no install was attempted');
  });

  it('parses every install-mode flag the self-test depends on', function () {
    assert.strictEqual(parseServiceArgs(['--boot', '--no-verify']).verify, false);
    assert.strictEqual(parseServiceArgs(['--boot']).verify, true);
    assert.strictEqual(parseServiceArgs(['--offline']).offline, true);
    assert.strictEqual(parseServiceArgs(['--force']).force, true);
    assert.strictEqual(parseServiceArgs(['--server-binary', '/x/y']).serverBinaryPath, '/x/y');
    assert.strictEqual(parseServiceArgs(['--server-binary=/x/y']).serverBinaryPath, '/x/y');
    assert.strictEqual(parseServiceArgs(['--release-version', 'v0.1.100']).releaseVersion, 'v0.1.100');
    // Service-own flags must never leak into the persisted server args.
    const p = parseServiceArgs(['--boot', '--offline', '--no-verify', '--mesh', '--disable-auth']);
    assert.deepStrictEqual(p.serverArgs, ['--mesh', '--disable-auth']);
  });
});
