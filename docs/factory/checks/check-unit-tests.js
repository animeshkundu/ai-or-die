#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const REPO_ROOT = process.env.FACTORY_REPO_ROOT || process.cwd();

function run() {
  try {
    const output = execSync('npm test', {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 120000, // 2 min
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Parse Mocha output for test count
    const passingMatch = output.match(/(\d+)\s+passing/);
    const failingMatch = output.match(/(\d+)\s+failing/);
    const passing = passingMatch ? parseInt(passingMatch[1], 10) : 0;
    const failing = failingMatch ? parseInt(failingMatch[1], 10) : 0;

    const result = {
      check: 'unit-tests',
      status: failing === 0 ? 'pass' : 'fail',
      passing,
      failing,
      total: passing + failing,
      details: failing === 0
        ? `${passing} passing`
        : `${failing} failing out of ${passing + failing}`,
    };
    console.log(JSON.stringify(result));
  } catch (err) {
    const output = (err.stdout || '') + (err.stderr || '');
    const failingMatch = output.match(/(\d+)\s+failing/);
    const passingMatch = output.match(/(\d+)\s+passing/);

    console.log(JSON.stringify({
      check: 'unit-tests',
      status: 'fail',
      passing: passingMatch ? parseInt(passingMatch[1], 10) : 0,
      failing: failingMatch ? parseInt(failingMatch[1], 10) : 0,
      details: output.slice(-500),
    }));
  }
}

run();
