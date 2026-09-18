#!/usr/bin/env node

'use strict';

// Entry point for the autoupdating ai-or-die service.
//
// Installed to the stable path (~/.ai-or-die/bin/ai-or-die-supervisor.js) by
// `ai-or-die service install` and referenced by the generated systemd /
// launchd / Task Scheduler unit. The unit path NEVER changes afterwards:
// updates replace ~/.ai-or-die/bin/ai-or-die-server in place, and this
// supervisor anchor itself almost never updates.
//
// Usage:
//   node bin/supervisor-service.js [--port 7777] [--mesh] [...server args]
// Server args are forwarded to every spawned Server child (including
// post-update respawns).

const path = require('path');
const { Supervisor } = require('../src/supervisor/index');

const supervisor = new Supervisor({
  serverBinary: process.env.AIORDIE_SERVER_BIN
    || path.join(__dirname, 'ai-or-die.js'),
  serverArgs: process.argv.slice(2),
});

supervisor.start().catch((err) => {
  console.error('[supervisor-service] failed to start:', err && err.message);
  process.exit(1);
});
