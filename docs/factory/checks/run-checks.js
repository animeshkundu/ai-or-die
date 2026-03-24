#!/usr/bin/env node
'use strict';

// Factory Prevention Check Runner
// Usage: node run-checks.js --stage <build|verify|simulate|cleanup>

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CHECKS_DIR = __dirname;
const REPO_ROOT = path.resolve(CHECKS_DIR, '..', '..', '..');

const STAGES = {
  build: [
    'check-unit-tests.js',
    'check-no-attribution.js',
    'check-cross-platform.js',
    'check-docs-sync.js',
    'check-port-safety.js',
    'check-security-audit.js',
  ],
  verify: [
    'check-unit-tests.js',
    'check-port-safety.js',
  ],
  simulate: [
    'check-e2e-subset.js',
  ],
  cleanup: [
    'cleanup-resources.js',
  ],
};

function parseArgs() {
  const args = process.argv.slice(2);
  const stageIdx = args.indexOf('--stage');
  if (stageIdx === -1 || !args[stageIdx + 1]) {
    console.error('Usage: node run-checks.js --stage <build|verify|simulate|cleanup>');
    process.exit(1);
  }
  const stage = args[stageIdx + 1];
  if (!STAGES[stage]) {
    console.error(`Unknown stage: ${stage}. Valid: ${Object.keys(STAGES).join(', ')}`);
    process.exit(1);
  }
  // Optional: --cycle N (for E2E rotation)
  const cycleIdx = args.indexOf('--cycle');
  const cycle = cycleIdx !== -1 ? parseInt(args[cycleIdx + 1], 10) : 0;
  return { stage, cycle };
}

function runCheck(scriptName, env = {}) {
  return new Promise((resolve) => {
    const scriptPath = path.join(CHECKS_DIR, scriptName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000); // 5 min max per check

    const child = spawn(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env, FACTORY_REPO_ROOT: REPO_ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: controller.signal,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout.trim().split('\n').pop());
        resolve(result);
      } catch {
        resolve({
          check: scriptName,
          status: code === 0 ? 'pass' : 'fail',
          details: stderr || stdout || `Exit code: ${code}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        check: scriptName,
        status: err.name === 'AbortError' ? 'timeout' : 'error',
        details: err.name === 'AbortError'
          ? 'Check timed out after 5 minutes'
          : err.message,
      });
    });
  });
}

async function main() {
  const { stage, cycle } = parseArgs();
  const checks = STAGES[stage];

  const env = { FACTORY_CYCLE: String(cycle) };
  if (stage === 'verify') {
    env.FACTORY_DIFF_MODE = 'committed';
  }
  const results = await Promise.all(checks.map((c) => runCheck(c, env)));

  const summary = {
    stage,
    cycle,
    timestamp: new Date().toISOString(),
    checks: results,
    overall: results.every((r) => r.status === 'pass') ? 'pass' : 'fail',
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.overall === 'pass' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
