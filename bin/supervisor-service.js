#!/usr/bin/env node

'use strict';

// Entry point for the autoupdating ai-or-die service.
//
// Installed to the stable path (~/.ai-or-die/bin/ai-or-die-supervisor.js —
// plus the staged src/ closure beside it) by `ai-or-die service install` and
// referenced by the generated systemd / launchd / Task Scheduler unit. The
// unit path NEVER changes afterwards: updates replace
// ~/.ai-or-die/bin/ai-or-die-server in place, and this supervisor anchor
// itself almost never updates.
//
// Usage:
//   node bin/supervisor-service.js [--port 7777] [--mesh] [...server args]
// Server args are forwarded to every spawned Server child (including
// post-update respawns).

const { Supervisor } = require('../src/supervisor/index');
const { STABLE_SERVER_BIN, supervisorVersion } = require('../src/supervisor/constants');
const { setupFileLogging } = require('../src/supervisor/service-logging');

setupFileLogging();

// The scheduled-task watchdog runs `node <this file> service watchdog` (see
// service-watchdog.js buildWatchdogXml). Without this interception that argv
// would be forwarded to the Server as server args AND boot a second supervisor
// competing for the port — the watchdog would restart the service by starting
// another copy of it. Routes through the shared handler like bin/supervisor.js.
// The `return` below must stay at top level: it exits the CommonJS module
// wrapper, which is what stops the supervisor from starting.
try {
  if (require('../src/supervisor/service-cli').handleServiceArgv(process.argv, console)) return;
} catch (err) {
  if (process.argv[2] === 'service') {
    // Fail CLOSED on the service path. Falling through here (the old behaviour)
    // boots a second supervisor: on the watchdog task, which fires every 5
    // minutes, that fights the running daemon for the port — far worse than the
    // install defect being reported, and a synchronous throw is exactly what an
    // incomplete staged service-cli closure produces.
    console.error('[supervisor-service] service command failed before dispatch:', (err && err.stack) || err);
    console.error('[supervisor-service] refusing to start a supervisor in place of a service command (fail closed)');
    process.exit(1);
  }
  // Non-`service` argv: the normal supervisor path below is the right answer.
}

// Task Scheduler's Exec action has no environment block, so the install mode
// can only reach the daemon through service.json. In boot mode (S4U logon) the
// hibernation remediation cannot work: it elevates with
// `Start-Process -Verb RunAs`, and an S4U session has no interactive desktop to
// show a UAC prompt on. Fail loudly in the log and disable the guard, rather
// than letting a PowerShell child die silently on every start.
// Explicit win: AIORDIE_DISABLE_HIBERNATION=0 re-enables it.
(function applyBootModeDefaults() {
  if (process.platform !== 'win32') return;
  if (process.env.AIORDIE_DISABLE_HIBERNATION !== undefined) return;
  try {
    const fs = require('fs');
    const meta = JSON.parse(fs.readFileSync(require('../src/supervisor/constants').SERVICE_META_FILE, 'utf8'));
    if (meta && meta.mode === 'boot') {
      process.env.AIORDIE_DISABLE_HIBERNATION = '1';
      console.log('[supervisor-service] boot mode: hibernation guard disabled (no interactive desktop for its UAC prompt)');
    }
  } catch (_) { /* no service.json: interactive/dev run */ }
})();

// The daemon has no orchestrator above it (PROC-01), so a lone transient
// fault must not kill months of sessions. But resuming after Heap corruption
// is unsafe (Node docs): past a small budget of uncaught faults inside one
// hour, exit non-zero and let the Task/launchd restart policy boot clean.
let _uncaughtBudget = [];
process.on('uncaughtException', (err) => {
  try {
    console.error('[supervisor-service] uncaughtException:', err && err.stack || err);
    const now = Date.now();
    _uncaughtBudget = _uncaughtBudget.filter((t) => now - t < 3600000);
    _uncaughtBudget.push(now);
    if (_uncaughtBudget.length > 5) {
      console.error('[supervisor-service] too many uncaught faults; exiting for a clean restart');
      process.exit(1);
    }
  } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[supervisor-service] unhandledRejection:', reason && reason.stack || reason);
  } catch (_) {}
});

const serverBinary = process.env.AIORDIE_SERVER_BIN || STABLE_SERVER_BIN;

// Identify the runtime in the first lines of logs/supervisor.log. A service
// that boots into the wrong binary or a stale staged tree is otherwise
// indistinguishable from one that is merely misconfigured.
console.log(`[supervisor-service] starting ${supervisorVersion()} (node ${process.version}, pid ${process.pid})`);
console.log(`[supervisor-service] server binary: ${serverBinary}`);

const supervisor = new Supervisor({
  serverBinary,
  serverArgs: process.argv.slice(2),
});

supervisor.start().catch((err) => {
  console.error('[supervisor-service] failed to start:', err && err.message);
  process.exit(1);
});
