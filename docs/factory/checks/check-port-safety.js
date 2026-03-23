#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const net = require('net');

const REPO_ROOT = process.env.FACTORY_REPO_ROOT || process.cwd();

const diffBase = process.env.FACTORY_DIFF_MODE === 'committed'
  ? 'git diff HEAD~1..HEAD'
  : 'git diff --cached';

const PROTECTED_PORT = 7777;
const MIN_TEST_PORT = 11000;

function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true)); // port in use
    server.once('listening', () => {
      server.close();
      resolve(false); // port free
    });
    server.listen(port, '127.0.0.1');
  });
}

async function run() {
  const findings = [];

  // 1. Check staged test files for hardcoded low ports
  try {
    const staged = execSync(
      `${diffBase} --unified=0 -- "test/**/*.js" "e2e/**/*.js" "docs/factory/**/*.js"`,
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 10000 }
    );

    // Match port numbers that look like they're being used (not in comments)
    const portRegex = /[^\/\*]\b(?:port|PORT|listen)\s*[=:(]\s*(\d{1,5})\b/g;
    let match;
    while ((match = portRegex.exec(staged)) !== null) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port < MIN_TEST_PORT && port !== 0) {
        findings.push({
          type: 'low-port-in-test',
          port,
          context: match[0].trim(),
        });
      }
    }
  } catch {
    // No staged test files
  }

  // 2. Verify port 7777 status (informational — we NEVER touch it)
  const port7777InUse = await checkPortInUse(PROTECTED_PORT);

  console.log(JSON.stringify({
    check: 'port-safety',
    status: findings.length === 0 ? 'pass' : 'fail',
    findings,
    port7777: port7777InUse ? 'in-use (DO NOT TOUCH)' : 'free',
    details: findings.length === 0
      ? `No ports < ${MIN_TEST_PORT} found in staged test files`
      : `Found ${findings.length} test file(s) using ports below ${MIN_TEST_PORT}`,
  }));
}

run();
