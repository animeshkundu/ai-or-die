#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const runs = Math.max(1, Number(process.argv[2]) || 5);
const outputDir = path.resolve(process.argv[3] || 'flake-inventory-artifacts');
const mocha = require.resolve('mocha/bin/mocha.js');
fs.mkdirSync(outputDir, { recursive: true });
const summary = {
  platform: process.platform,
  node: process.version,
  startedAt: new Date().toISOString(),
  runs: [],
};

for (let index = 1; index <= runs; index++) {
  const started = Date.now();
  const reportFile = `run-${index}.json`;
  const result = spawnSync(process.execPath, [
    mocha,
    '--require', 'test/hooks/session-sandbox.js',
    '--exit',
    '--reporter', 'test/reporters/flake-inventory.js',
    'test/*.test.js',
    'test/control/*.test.js',
  ], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    env: {
      ...process.env,
      MOCHA_COLORS: '0',
      MOCHA_FLAKE_INVENTORY_FILE: path.join(outputDir, reportFile),
    },
  });
  const logFile = `run-${index}.log`;
  fs.writeFileSync(path.join(outputDir, logFile), (result.stdout || '') + (result.stderr || ''));
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(path.join(outputDir, reportFile), 'utf8'));
  } catch (_) {}
  summary.runs.push({
    index,
    exitCode: result.status,
    durationMs: Date.now() - started,
    logFile,
    reportFile: report ? reportFile : null,
    failures: report ? report.failures : [],
  });
}

summary.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
if (summary.runs.some((run) => run.exitCode !== 0)) process.exitCode = 1;
