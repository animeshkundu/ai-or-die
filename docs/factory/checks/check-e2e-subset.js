#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const REPO_ROOT = process.env.FACTORY_REPO_ROOT || process.cwd();
const cycle = parseInt(process.env.FACTORY_CYCLE || '0', 10);

// E2E rotation schedule (mod 5)
const ROTATION = {
  0: ['golden-path', 'functional-core'],
  1: ['functional-extended', 'new-features'],
  2: ['mobile-iphone', 'mobile-pixel', 'integrations'],
  3: ['power-user-flows', 'ui-features'],
  4: [], // Full suite — all projects (no --project filter)
};

// Skip these in factory path (unreliable locally)
const SKIP_PROJECTS = [
  'visual-regression',    // screenshot bitrot
  'voice-real-pipeline',  // model dependency
];

function run() {
  const rotation = cycle % 5;
  const projects = ROTATION[rotation];

  let cmd = 'npx playwright test --config e2e/playwright.config.js --workers=2';

  if (projects.length > 0) {
    // Run specific projects
    const projectFlags = projects
      .filter((p) => !SKIP_PROJECTS.includes(p))
      .map((p) => `--project="${p}"`)
      .join(' ');
    cmd += ` ${projectFlags}`;
  } else {
    // Full suite — exclude skip list
    // Playwright doesn't have --exclude-project, so we list all non-skipped projects
    cmd += ' --project=golden-path --project=functional-core --project=functional-extended';
    cmd += ' --project=new-features --project=mobile-iphone --project=mobile-pixel';
    cmd += ' --project=integrations --project=power-user-flows --project=ui-features';
    cmd += ' --project=ux-features --project=restart';
    cmd += ' --project=mobile-flows --project=mobile-sprint1 --project=mobile-sprint23';
    cmd += ' --project=mobile-journeys';
  }

  try {
    const output = execSync(cmd, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 300000, // 5 min max
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0' },
    });

    const passMatch = output.match(/(\d+)\s+passed/);
    const failMatch = output.match(/(\d+)\s+failed/);

    console.log(JSON.stringify({
      check: 'e2e-subset',
      status: failMatch ? 'fail' : 'pass',
      rotation,
      projects: projects.length > 0 ? projects : ['FULL_SUITE'],
      passed: passMatch ? parseInt(passMatch[1], 10) : 0,
      failed: failMatch ? parseInt(failMatch[1], 10) : 0,
      details: failMatch
        ? `${failMatch[1]} failed in rotation ${rotation}`
        : `All passed in rotation ${rotation}`,
    }));
  } catch (err) {
    const output = (err.stdout || '') + (err.stderr || '');
    console.log(JSON.stringify({
      check: 'e2e-subset',
      status: 'fail',
      rotation,
      projects: projects.length > 0 ? projects : ['FULL_SUITE'],
      details: output.slice(-500),
    }));
  }
}

run();
