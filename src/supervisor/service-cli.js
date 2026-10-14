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

const SERVICE_OWN_FLAGS = new Set(['--no-hibernation-guard', '--disable-hibernation', '--json']);

/**
 * Split extra CLI args (argv after `service <sub>`) into service-own options
 * and persisted serverArgs. Pure — unit-tested without spawning.
 *
 * Rules:
 * - `--no-hibernation-guard` / `--disable-hibernation` (or env
 *   AIORDIE_DISABLE_HIBERNATION=1, read by the caller) opt out of the
 *   hibernation remediation prompt.
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
function parseServiceArgs(extraArgs = []) {
  const serverArgs = [];
  const result = {
    serverArgs,
    noHibernationGuard: false,
    lines: 100,
    json: false,
    droppedAuth: false,
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
    if (!verbatim && a === '--json') {
      result.json = true;
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
 * Run the service subcommand. `installer` is a ServiceInstaller (real or
 * test double); `logger` defaults to console. Resolves with the result object
 * (and prints human-readable lines); rejects on failure.
 */
async function runServiceCommand(sub, parsed, installer, logger = console) {
  const { ServiceInstaller } = require('./service-installer');
  const inst = installer || new ServiceInstaller();
  if (sub === 'install') {
    if (parsed.noHibernationGuard) process.env.AIORDIE_DISABLE_HIBERNATION = '1';
    // Never pass argv[1] (npx cache / CLI file) — stage the stable anchor.
    const entry = findServiceEntry();
    const result = inst.install(entry, { serverArgs: parsed.serverArgs });
    logger.log(`ai-or-die service installed (${result.platform})`);
    logger.log(`  supervisor: ${result.supervisorPath}`);
    if (result.unitFile) logger.log(`  unit: ${result.unitFile}`);
    if (result.taskXml) logger.log(`  task: ${result.taskXml}`);
    if (result.nodePath) logger.log(`  node: ${result.nodePath}`);
    if (parsed.serverArgs && parsed.serverArgs.length) {
      logger.log(`  args: ${parsed.serverArgs.join(' ')}`);
    }
    if (parsed.droppedAuth) {
      logger.log('  note: --auth was NOT persisted (bearers never persist in service definitions); the server mints a per-boot token.');
    }
    logger.log('  Windows: keep-awake assertion ON; hibernation guard ON by default.');
    logger.log('  Opt out: ai-or-die service install --no-hibernation-guard');
    if (result.platform === 'linux') {
      logger.log('  Hint: run `loginctl enable-linger $USER` so the service survives logout; tail with `journalctl --user -u ai-or-die -f`.');
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
  const err = new Error('Usage: ai-or-die service <install|uninstall|status|logs> [--port N] [--mesh] [--no-hibernation-guard]');
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
  const parsed = parseServiceArgs(argv.slice(4));
  runServiceCommand(sub, parsed, null, logger).catch((e) => {
    if (e && e.code === 'EUSAGE') {
      logger.error(e.message);
      process.exit(2);
      return;
    }
    logger.error('service command failed:', e && e.message);
    process.exit(1);
  });
  return true;
}

module.exports = { parseServiceArgs, findServiceEntry, runServiceCommand, handleServiceArgv };
