'use strict';

// Test fixture: a minimal supervised "server" that records, on each spawn, whether
// the supervisor marked it as a restart (AOD_SUPERVISOR_RESTART). It exits 75 on the
// first spawn (request a graceful restart) and 0 on the second (clean stop), so the
// supervisor performs exactly one restart and then exits.
//
// Used by test/supervisor-restart-env.test.js to assert the browser-auto-open
// suppression contract: first launch has no AOD_SUPERVISOR_RESTART; restarts do.

const fs = require('fs');

const recordFile = process.env.MOCK_ENV_RECORD_FILE;
fs.appendFileSync(
  recordFile,
  'restart=' + (process.env.AOD_SUPERVISOR_RESTART || '') +
  ' supervised=' + (process.env.SUPERVISED || '') + '\n'
);

const spawns = fs.readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean).length;

const RESTART_EXIT_CODE = 75;
process.exit(spawns >= 2 ? 0 : RESTART_EXIT_CODE);
