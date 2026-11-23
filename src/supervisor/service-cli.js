'use strict';

// Shared `service` subcommand handler for both CLI entry points.
//
// `package.json` bin maps `ai-or-die`/`aiordie` to `bin/supervisor.js`, but the
// `service` intercept historically lived only in `bin/ai-or-die.js`. As a
// result `npx ai-or-die service install` ran *inside* the supervised child
// instead of the one-shot installer (P0). Both bins now call
// `handleServiceArgv()` at the top; this module owns parsing + dispatch so the
// two entries can never drift apart again.
//
// Wire contract: `service install [-- <serverArgs…>]` forwards everything
// after `install` (minus service-own flags and secrets) as persisted
// `serverArgs` for the Task/systemd/launchd unit. Secrets (`--auth <token>`)
// are NEVER persisted (Task XML + process list are world-readable).

const path = require('path');

const SERVICE_OWN_FLAGS = new Set([
  '--no-hibernation-guard', '--disable-hibernation', '--json', '--boot', '--login',
  '--offline', '--no-verify', '--server-binary', '--release-version', '--force',
]);

/**
 * Split extra CLI args (argv after `service <sub>`) into service-own options
 * and persisted serverArgs. Pure — unit-tested without spawning.
 *
 * Rules:
 * - `--no-hibernation-guard` / `--disable-hibernation` (or env
 *   AIORDIE_DISABLE_HIBERNATION=1, read by the caller) opt out of the
 *   hibernation remediation prompt.
 * - `--boot` selects a boot-startable task (S4U principal + BootTrigger, runs
 *   before anyone logs on); `--login` (the default) keeps the historical
 *   InteractiveToken task that starts when the user logs in.
 * - `--server-binary <path>`, `--offline`, `--release-version <tag>`,
 *   `--force` and `--no-verify` control install-time Server provisioning and
 *   the post-install self-test.
 * - `--auth <token>` / `--auth=<token>` is dropped with a warning — the
 *   server mints a per-boot token; persisting a bearer in Task XML / service
 *   wrappers would leak via `schtasks /query /xml` and process lists.
 * - `--lines N` (logs) and `--json` (status) are consumed here.
 * - Everything else (e.g. `--port 8888 --mesh --https`) is persisted verbatim
 *   as serverArgs for the service unit. Note: after `--`, even `--auth` is
 *   passed through verbatim by design (explicit operator escape hatch) — the
 *   installer layer (stripSecrets) still drops it before persisting, so
 *   bearers never land in Task XML / unit files.
 */
function usageError(message) {
  const e = new Error(message);
  e.code = 'EUSAGE';
  return e;
}

function parseServiceArgs(extraArgs = []) {
  const serverArgs = [];
  const result = {
    serverArgs,
    noHibernationGuard: false,
    lines: 100,
    json: false,
    droppedAuth: false,
    mode: 'login',
    offline: false,
    force: false,
    verify: true,
    dryRun: false,
    serverBinaryPath: null,
    releaseVersion: null,
  };
  const args = Array.isArray(extraArgs) ? extraArgs.slice() : [];
  // Support `--` separator: everything after it is serverArgs verbatim.
  let verbatim = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!verbatim && a === '--') {
      verbatim = true;
      continue;
    }
    if (!verbatim && (a === '--no-hibernation-guard' || a === '--disable-hibernation')) {
      result.noHibernationGuard = true;
      continue;
    }
    if (!verbatim && a === '--boot') {
      result.mode = 'boot';
      continue;
    }
    if (!verbatim && a === '--login') {
      result.mode = 'login';
      continue;
    }
    if (!verbatim && a === '--offline') {
      result.offline = true;
      continue;
    }
    if (!verbatim && a === '--force') {
      result.force = true;
      continue;
    }
    if (!verbatim && a === '--no-verify') {
      result.verify = false;
      continue;
    }
    if (!verbatim && a === '--server-binary') {
      const next = args[i + 1];
      if (!next || String(next).startsWith('-')) {
        // Silently swallowing this would install the DOWNLOADED binary while
        // the operator believes they pinned a local one.
        throw usageError('service install: --server-binary needs a path');
      }
      result.serverBinaryPath = next;
      i += 1;
      continue;
    }
    if (!verbatim && typeof a === 'string' && a.startsWith('--server-binary=')) {
      result.serverBinaryPath = a.slice('--server-binary='.length);
      continue;
    }
    if (!verbatim && a === '--release-version') {
      const next = args[i + 1];
      if (!next || String(next).startsWith('-')) {
        throw usageError('service install: --release-version needs a tag (e.g. v0.1.112)');
      }
      result.releaseVersion = next;
      i += 1;
      continue;
    }
    if (!verbatim && typeof a === 'string' && a.startsWith('--release-version=')) {
      result.releaseVersion = a.slice('--release-version='.length);
      continue;
    }
    if (!verbatim && a === '--json') {
      result.json = true;
      continue;
    }
    if (!verbatim && a === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    if (!verbatim && (a === '--lines' || a === '--lines=N')) {
      const next = args[i + 1];
      const n = parseInt(next, 10);
      if (Number.isFinite(n) && n > 0) {
        result.lines = Math.min(n, 5000);
        i += 1;
      }
      continue;
    }
    if (!verbatim && typeof a === 'string' && a.startsWith('--lines=')) {
      const n = parseInt(a.slice('--lines='.length), 10);
      if (Number.isFinite(n) && n > 0) result.lines = Math.min(n, 5000);
      continue;
    }
    if (!verbatim && (a === '--auth' || a === '--token')) {
      // Drop flag + value (if any).
      if (i + 1 < args.length && !String(args[i + 1]).startsWith('-')) i += 1;
      result.droppedAuth = true;
      continue;
    }
    if (!verbatim && typeof a === 'string' && (a.startsWith('--auth=') || a.startsWith('--token='))) {
      result.droppedAuth = true;
      continue;
    }
    serverArgs.push(a);
  }
  return result;
}

/**
 * Resolve the supervisor entry to stage. Repo/global layouts carry
 * bin/supervisor-service.js; a staged tree (reinstall from the service
 * context) carries bin/ai-or-die-supervisor.js. Pure-ish (existsSync only).
 */
function findServiceEntry(callerDir = path.join(__dirname, '..', '..', 'bin')) {
  const fs = require('fs');
  const candidates = [
    path.join(callerDir, 'supervisor-service.js'),
    path.join(callerDir, 'ai-or-die-supervisor.js'),
  ];
  return candidates.find((c) => { try { return fs.existsSync(c); } catch (_) { return false; }; })
    || candidates[0];
}

/**
 * Post-install self-test: the task was created and started, but a registered
 * task proves nothing about whether the daemon can actually boot. Poll the
 * heartbeat for up to `timeoutMs` and report what the log says when it never
 * appears: a silent success here is how the original MODULE_NOT_FOUND bug
 * survived a full install. Never throws.
 */
async function verifyInstalled(installer, timeoutMs = 90000, logger = console, options = {}) {
  const deadline = Date.now() + timeoutMs;
  const fs = require('fs');
  const { readHeartbeat } = require('./heartbeat');
  // Only a heartbeat written AFTER this install began counts. Without this, a
  // leftover file from a previous run (or a daemon that was already up) makes
  // the self-test pass while the daemon it just registered never started — the
  // exact class of silent success this check exists to prevent.
  const since = options.since || 0;
  // A beating OLD daemon (previous install, orphaned supervisor on the same base
  // dir) keeps rewriting updatedAtMs, so "fresh" alone still describes it. A
  // process stamps startedAtMs once, at construction, so requiring
  // startedAtMs >= since proves the beating process is the one this install
  // launched — otherwise an unchanged reinstall whose start failed still prints
  // "verified: daemon is up".
  const requireProcessStart = !!options.requireProcessStart;
  let last = null;
  // Remember that we SAW a fresh beat from a foreign process: the two failure
  // reasons need different remediation text (start it, vs. a stale daemon is
  // squatting the base dir).
  let foreignBeatSeen = false;
  while (Date.now() < deadline) {
    let file = options.heartbeatFile;
    if (!file && installer && typeof installer.heartbeatFilePath === 'function') {
      try { file = installer.heartbeatFilePath(); } catch (_) { file = null; }
    }
    try { last = readHeartbeat(file ? { file } : {}); } catch (_) { last = null; }
    const at = last && (Number.isFinite(last.updatedAtMs) ? last.updatedAtMs : Date.parse(last.updatedAt || ''));
    const fresh = !!(last && last.phase && last.phase !== 'shutdown'
      && (!since || (Number.isFinite(at) && at >= since)));
    if (fresh) {
      const startedAt = Number.isFinite(last.startedAtMs) ? last.startedAtMs : NaN;
      // No since window means the caller asked for a plain liveness check, so a
      // missing startedAtMs must not turn into a spurious failure there.
      if (!requireProcessStart || !since || (Number.isFinite(startedAt) && startedAt >= since)) {
        return { ok: true, heartbeat: last };
      }
      foreignBeatSeen = true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Diagnosis: task state + the tail of the log beat a bare "timed out".
  let tail = '';
  try {
    const logFile = installer.logFilePath();
    tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n');
  } catch (_) { /* no log yet */ }
  let status = null;
  try { status = installer.status(); } catch (_) { status = null; }
  try {
    logger.warn('');
    if (foreignBeatSeen && requireProcessStart) {
      // Distinct text: the daemon IS writing a heartbeat, just not from the
      // process this install started — an operator told "no heartbeat" would go
      // looking for the wrong failure.
      logger.warn(`service install: no heartbeat from a process started after this install began within ${Math.round(timeoutMs / 1000)}s.`);
      logger.warn('  the heartbeat on disk is still being written by a process that was already running (a leftover daemon); it is not the one this install registered.');
    } else {
      logger.warn(`service install: the task is registered but the daemon wrote no fresh heartbeat within ${Math.round(timeoutMs / 1000)}s.`);
    }
    if (status && status.taskState) logger.warn(`  task state: ${status.taskState}`);
    if (tail) {
      logger.warn('  last log lines:');
      for (const line of tail.split('\n')) logger.warn(`    ${line}`);
    } else {
      logger.warn(`  no log at ${installer.logFilePath()} yet`);
    }
  } catch (_) { /* ignore */ }
  return {
    ok: false,
    reason: foreignBeatSeen && requireProcessStart ? 'no-process-started-since' : 'no-fresh-heartbeat',
    status,
    logTail: tail,
  };
}

/**
 * Run the service subcommand. `installer` is a ServiceInstaller (real or
 * test double); `logger` defaults to console. Resolves with the result object
 * (and prints human-readable lines); rejects on failure.
 */
async function runServiceCommand(sub, parsed, installer, logger = console) {
  const { ServiceInstaller } = require('./service-installer');
  const inst = installer || new ServiceInstaller();
  if (sub === 'install') {
    // `--dry-run` is only meaningful for `watchdog`. Silently ignoring it here
    // would let `service install --dry-run` perform a real install.
    if (parsed.dryRun) {
      const e = new Error('service install: --dry-run is only supported by `service watchdog`');
      e.code = 'EUSAGE';
      throw e;
    }
    if (parsed.noHibernationGuard) process.env.AIORDIE_DISABLE_HIBERNATION = '1';
    // Timestamp the self-test: only a heartbeat newer than this proves the
    // daemon THIS command started is alive.
    const verifySince = Date.now();
    // Never pass argv[1] (npx cache / CLI file) — stage the stable anchor.
    const entry = findServiceEntry();
    const result = await inst.install(entry, {
      serverArgs: parsed.serverArgs,
      mode: parsed.mode,
      offline: parsed.offline,
      serverBinaryPath: parsed.serverBinaryPath,
      releaseVersion: parsed.releaseVersion,
      force: parsed.force,
    });
    logger.log(`ai-or-die service installed (${result.platform}, ${result.mode || 'login'} mode)`);
    logger.log(`  supervisor: ${result.supervisorPath}`);
    if (result.unitFile) logger.log(`  unit: ${result.unitFile}`);
    if (result.taskXml) logger.log(`  task: ${result.taskXml}`);
    if (result.nodePath) logger.log(`  node: ${result.nodePath}`);
    if (result.serverBinary) {
      const v = result.serverVersion ? ` (${result.serverVersion})` : '';
      const how = result.serverVerified ? `, ${result.serverVerified}` : '';
      logger.log(`  server: ${result.serverBinary}${v}${how}`);
    }
    if (parsed.serverArgs && parsed.serverArgs.length) {
      logger.log(`  args: ${parsed.serverArgs.join(' ')}`);
    }
    if (parsed.droppedAuth) {
      logger.log('  note: --auth was NOT persisted (bearers never persist in service definitions); the server mints a per-boot token.');
    }
    if (result.watchdog) {
      logger.log(result.watchdog.installed
        ? `  watchdog: ${result.watchdog.taskName} (every 5 min, restarts a wedged daemon)`
        : `  watchdog: not installed (${result.watchdog.error || result.watchdog.reason || 'unknown'})`);
    }
    if (result.mode === 'boot') {
      logger.log('  boot mode: starts at boot before anyone logs on, in your user context, with no stored password.');
      logger.log('  note: S4U logon sessions carry no network credential material (no SMB/EFS/DPAPI-to-user).');
      logger.log('  note: a standard (non-admin) account needs "Log on as a batch job" (SeBatchLogonRight):');
      logger.log('        secpol.msc > Local Policies > User Rights Assignment > Log on as a batch job');
      logger.log('        (or: ntrights -u %USERNAME% +r SeBatchLogonRight)');
    } else {
      logger.log('  login mode: starts when you log on. Use --boot to start before login.');
    }
    if (result.platform === 'win32') {
      if (result.mode === 'boot') {
        logger.log('  Windows: keep-awake assertion ON (best-effort without a desktop); hibernation guard OFF');
        logger.log('           (its remediation elevates with UAC, impossible in an S4U session).');
        logger.log('           Disable hibernation manually if this host sleeps: powercfg /hibernate off');
      } else {
        logger.log('  Windows: keep-awake assertion ON; hibernation guard ON by default.');
        logger.log('  Opt out: ai-or-die service install --no-hibernation-guard');
      }
    }    if (result.platform === 'linux') {
      logger.log('  Hint: run `loginctl enable-linger $USER` so the service survives logout; tail with `journalctl --user -u ai-or-die -f`.');
    }
    if (result.restarted === 'start-failed') {
      logger.warn('  warning: the task definition is unchanged but the daemon is not running and could not be started; check `ai-or-die service status`');
    }
    // Prove it, do not assume it: poll the heartbeat the daemon writes. Applies
    // to a no-op reinstall too — a correct definition with a dead daemon is
    // exactly the state the operator ran the command to learn about.
    if (parsed.verify !== false && result.platform === 'win32') {
      // Require a daemon process that STARTED after this command began — except
      // for the one case where an already-running daemon is the genuine proof:
      // an unchanged task that the installer found Running (nothing was
      // restarted, so its startedAtMs is necessarily older than `since`).
      const alreadyRunning = result.unchanged === true && result.restarted === 'running';
      const check = await verifyInstalled(inst, parsed.verifyTimeoutMs || 90000, logger, {
        since: verifySince,
        requireProcessStart: !alreadyRunning,
      });
      result.verified = check.ok;
      if (check.ok) {
        const hb = check.heartbeat;
        const serverPid = hb.status && hb.status.serverPid;
        logger.log(`  verified: daemon is up (phase=${hb.phase}, pid=${hb.pid}${serverPid ? `, server=${serverPid}` : ''})`);
      } else {
        // Carry the REASON into the thrown line too: the caller prints e.message
        // as the actionable text, and "did not come up" alone reads the same for
        // "nothing is running" and "an old daemon is squatting the base dir".
        const why = check.reason === 'no-process-started-since'
          ? 'no heartbeat from a process started after this install began; a leftover daemon is still writing the old heartbeat'
          : 'no fresh heartbeat';
        const err = new Error(`service install: the daemon did not come up after install — ${why} (see the log excerpt above)`);
        err.code = 'EVERIFY';
        throw err;
      }
    }
    return result;
  }
  if (sub === 'uninstall') {
    const result = inst.uninstall();
    logger.log(JSON.stringify(result));
    return result;
  }
  if (sub === 'status') {
    const result = { service: process.env.AIORDIE_SERVICE_NAME || 'ai-or-die', ...inst.status() };
    logger.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (sub === 'watchdog') {
    const { ServiceWatchdog } = require('./service-watchdog');
    const wd = new ServiceWatchdog({ logger });
    const result = await wd.run({ dryRun: parsed.dryRun });
    // Machine-readable: a scheduled task has no interactive reader.
    logger.log(JSON.stringify(result));
    return result;
  }
  if (sub === 'logs') {
    const fs = require('fs');
    const { SUPERVISOR_LOG_FILE } = require('./constants');
    try {
      const lines = fs.readFileSync(SUPERVISOR_LOG_FILE, 'utf8').split('\n').slice(-parsed.lines);
      logger.log(lines.join('\n'));
    } catch (e) {
      logger.log(`No supervisor log yet at ${SUPERVISOR_LOG_FILE}`);
    }
    return { logs: true, file: SUPERVISOR_LOG_FILE };
  }
  const err = new Error(
    'Usage: ai-or-die service <install|uninstall|status|logs|watchdog> [options]\n'
    + '  install [--boot|--login] [--port N] [--mesh] [--disable-auth]\n'
    + '          [--server-binary <path> | --offline | --release-version <tag>]\n'
    + '          [--no-hibernation-guard] [--no-verify] [--force]\n'
    + '  status | logs [--lines N] | uninstall\n'
    + '  watchdog [--dry-run]   (internal: run by the ai-or-die-watchdog task)'
  );
  err.code = 'EUSAGE';
  throw err;
}

/**
 * Bin entry helper. Returns true when argv was a `service` invocation (caller
 * must return early — the async runner owns process.exit). Returns false for
 * normal CLI runs.
 */
function handleServiceArgv(argv = process.argv, logger = console) {
  if (argv[2] !== 'service') return false;
  const sub = argv[3];
  let parsed;
  try {
    parsed = parseServiceArgs(argv.slice(4));
  } catch (e) {
    // Entry points wrap this call in try/catch to let non-`service` argv fall
    // through to the supervise path. A bad flag must NOT be swallowed there —
    // `ai-or-die service install --server-binary` with no path would otherwise
    // quietly start a server instead of reporting the mistake.
    logger.error(e.message);
    process.exit(2);
  }
  runServiceCommand(sub, parsed, null, logger).catch((e) => {
    if (e && e.code === 'EUSAGE') {
      logger.error(e.message);
      process.exit(2);
      return;
    }
    // These already carry the message the operator needs (including the exact
    // remediation), so print them as-is instead of prefixing a generic
    // "service command failed:" line that buries the actionable part.
    const actionable = e && ['EVERIFY', 'ESTAGEDCLOSURE', 'EBOOTUNSUPPORTED', 'EBOOTIDENTITY',
      'EUSAGE'].includes(e.code);
    if (actionable) {
      logger.error(e.message);
    } else {
      logger.error('service command failed:', e && e.message);
    }
    // Provisioning failures carry a code that says what to do next.
    if (e && e.code && /offline|no-asset|checksum-mismatch|invalid-binary|network|unsupported-platform/.test(e.code)) {
      logger.error(`  (${e.code})`);
    }
    process.exit(1);
  });
  return true;
}

module.exports = {
  parseServiceArgs,
  findServiceEntry,
  runServiceCommand,
  verifyInstalled,
  handleServiceArgv,
};
