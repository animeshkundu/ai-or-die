#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');

const REPO_ROOT = process.env.FACTORY_REPO_ROOT || process.cwd();

function run() {
  try {
    const output = execSync('npm audit --audit-level=high --json', {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const audit = JSON.parse(output);
    const vulns = audit.metadata?.vulnerabilities || {};
    const high = (vulns.high || 0) + (vulns.critical || 0);

    console.log(JSON.stringify({
      check: 'security-audit',
      status: high === 0 ? 'pass' : 'fail',
      vulnerabilities: vulns,
      highAndCritical: high,
      details: high === 0
        ? 'No high/critical vulnerabilities'
        : `${high} high/critical vulnerability(ies) found`,
    }));
  } catch (err) {
    // npm audit exits non-zero when vulns found
    const output = err.stdout || '';
    try {
      const audit = JSON.parse(output);
      const vulns = audit.metadata?.vulnerabilities || {};
      const high = (vulns.high || 0) + (vulns.critical || 0);

      console.log(JSON.stringify({
        check: 'security-audit',
        status: high === 0 ? 'pass' : 'fail',
        vulnerabilities: vulns,
        highAndCritical: high,
        details: high === 0
          ? 'No high/critical vulnerabilities (lower severity present)'
          : `${high} high/critical vulnerability(ies) found`,
      }));
    } catch {
      console.log(JSON.stringify({
        check: 'security-audit',
        status: 'error',
        details: (err.stderr || err.message || '').slice(-500),
      }));
    }
  }
}

run();
