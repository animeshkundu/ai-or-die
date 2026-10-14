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
const { STABLE_SERVER_BIN } = require('../src/supervisor/constants');
const { setupFileLogging } = require('../src/supervisor/service-logging');

setupFileLogging();

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

const supervisor = new Supervisor({
  serverBinary: process.env.AIORDIE_SERVER_BIN || STABLE_SERVER_BIN,
  serverArgs: process.argv.slice(2),
});

supervisor.start().catch((err) => {
  console.error('[supervisor-service] failed to start:', err && err.message);
  process.exit(1);
});
