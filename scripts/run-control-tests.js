#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const controlDir = path.join(root, 'test', 'control');
const mocha = require.resolve('mocha/bin/mocha.js');
const hook = path.join(root, 'test', 'hooks', 'session-sandbox.js');
const extraArgs = [];
const requestedFiles = [];
for (const argument of process.argv.slice(2)) {
  const candidate = path.resolve(root, argument);
  if (!argument.startsWith('-') && argument.endsWith('.test.js') && fs.existsSync(candidate)) {
    requestedFiles.push(candidate);
  } else {
    extraArgs.push(argument);
  }
}
const files = requestedFiles.length
  ? requestedFiles
  : fs.readdirSync(controlDir)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join(controlDir, name));

for (const file of files) {
  const result = spawnSync(process.execPath, [
    mocha,
    '--require',
    hook,
    '--exit',
    '--timeout',
    '5000',
    ...extraArgs,
    file,
  ], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
