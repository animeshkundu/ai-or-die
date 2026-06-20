'use strict';

// Fixture child for supervisor-tree-kill.test.js. Plays the role of the server: prints its
// pid and loops forever. It installs NO parent-death handling of its own, so if it survives
// the supervisor being killed, the ONLY thing that can have reaped it is the supervisor's
// kill-on-close Job Object. argv are ignored.

console.log('CHILD_PID ' + process.pid);
setInterval(() => {}, 1e9);
