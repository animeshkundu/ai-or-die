#!/usr/bin/env node

'use strict';

const path = require('path');
const ModelHost = require('../../src/model-host');

const host = new ModelHost({
  name: 'parent-death-fixture',
  entryPath: path.join(__dirname, 'model-host-fixture.js'),
  readinessTimeoutMs: 5000,
});

host.demand()
  .then(() => {
    if (process.send) process.send({ type: 'ready', hostPid: host.diagnostics().pid });
    setInterval(() => {}, 60000);
  })
  .catch((error) => {
    if (process.send) process.send({ type: 'error', message: error.message });
    process.exit(1);
  });
