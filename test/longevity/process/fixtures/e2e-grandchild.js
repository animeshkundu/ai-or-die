'use strict';
// Fixture for server-shutdown-e2e.test.js: a real grandchild process the terminal PTY
// launches. Writes its pid to argv[2], then loops forever. If it survives the supervisor
// going away, it's a leaked orphan — exactly what the deterministic-shutdown work prevents.
const fs = require('fs');
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1e9);
