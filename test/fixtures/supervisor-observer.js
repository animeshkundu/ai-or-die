'use strict';

const fs = require('fs');

if (process.env.SUPERVISOR_OBSERVER_FILE) {
  fs.writeFileSync(process.env.SUPERVISOR_OBSERVER_FILE, JSON.stringify({
    execArgv: process.execArgv,
    gcAvailable: typeof global.gc === 'function',
    args: process.argv.slice(2),
    supervised: process.env.SUPERVISED,
    pid: process.pid,
    ppid: process.ppid,
  }));
}
process.exit(Number(process.env.SUPERVISOR_OBSERVER_EXIT || 0));
