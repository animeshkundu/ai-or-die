#!/usr/bin/env node
'use strict';

// Emits the CI browser-test matrix by reading the Playwright config, so a new
// project cannot be added without CI picking it up.
//
// Why this exists: CI previously carried one hand-written ~49-line job per
// Playwright project. Adding a project meant remembering to copy that block,
// and a MISSING block is invisible in review — nothing looks wrong. Four
// projects (file-browser-v2, journey, journey-auth, journey-auth-regressions)
// had drifted to zero CI coverage that way, undetected.
//
// Now the matrix is derived, and anything deliberately not run in the main CI
// workflow must say so in EXCLUDED below, with a reason. Silence is coverage.
//
// Usage:
//   node scripts/ci-browser-matrix.js            # JSON matrix for GH Actions
//   node scripts/ci-browser-matrix.js --check    # non-zero if EXCLUDED is stale

const path = require('path');

// Projects deliberately NOT run by the main CI workflow. Every entry needs a
// reason and, where applicable, the workflow that does run it — otherwise this
// list becomes the new place coverage goes to die.
const EXCLUDED = {
  'voice-e2e': 'runs in .github/workflows/test-voice.yml (needs STT model fixtures)',
  'voice-real-pipeline': 'runs in .github/workflows/test-voice.yml (needs real inference)',
  // Broken harness, not coverage. Both hardcode a server port (11500 / 11501)
  // that nothing starts, so every test fails with ERR_CONNECTION_REFUSED —
  // verified locally. Wiring them in would add 20 permanently-red tests, which
  // is worse than the current gap because it trains people to ignore red.
  // The fixed ports are also what blocks parallelising them. Fix by moving
  // them onto the ephemeral-port server-factory the other suites use, then
  // delete these two entries.
  'journey': 'harness broken: hardcoded port 11500, no server started (ERR_CONNECTION_REFUSED)',
  'journey-auth': 'harness broken: hardcoded port 11501, no server started (ERR_CONNECTION_REFUSED)',
};

// Projects that only run on a subset of platforms, with the reason.
const PLATFORM_LIMITS = {
  'ios-ipad11': { os: ['ubuntu-latest'], why: 'WebKit; Linux runner is the supported WebKit host' },
  'ios-ipad11-landscape': { os: ['ubuntu-latest'], why: 'WebKit' },
  'ios-iphone16': { os: ['ubuntu-latest'], why: 'WebKit' },
  'ios-iphone16-landscape': { os: ['ubuntu-latest'], why: 'WebKit' },
};

const DEFAULT_OS = ['ubuntu-latest', 'windows-latest'];

function projectEntries() {
  const configPath = path.resolve(__dirname, '..', 'e2e', 'playwright.config.js');
  const config = require(configPath);
  const projects = (config && config.projects) || [];
  // Derive the browser from the project's own `use.browserName` rather than
  // guessing from the project name. Installing chromium for a webkit project
  // fails at test time with a confusing "browser not found", and a name-substring
  // heuristic silently breaks the moment someone adds a webkit project whose
  // name does not contain "ios".
  return projects
    .filter((p) => p && p.name)
    .map((p) => ({ name: p.name, browser: (p.use && p.use.browserName) || 'chromium' }));
}

function projectNames() {
  return projectEntries().map((p) => p.name);
}

function build() {
  const entries = projectEntries();
  const names = entries.map((e) => e.name);
  const unknownExclusions = Object.keys(EXCLUDED).filter((n) => !names.includes(n));
  const include = [];
  for (const { name: project, browser } of entries) {
    if (EXCLUDED[project]) continue;
    const limit = PLATFORM_LIMITS[project];
    for (const os of (limit ? limit.os : DEFAULT_OS)) include.push({ project, os, browser });
  }
  return { include, names, unknownExclusions };
}

function main() {
  const { include, names, unknownExclusions } = build();
  if (process.argv.includes('--check')) {
    let bad = false;
    if (unknownExclusions.length) {
      console.error('EXCLUDED names no longer exist in playwright.config.js: ' + unknownExclusions.join(', '));
      bad = true;
    }
    for (const project of Object.keys(PLATFORM_LIMITS)) {
      if (!names.includes(project)) {
        console.error('PLATFORM_LIMITS names a project that no longer exists: ' + project);
        bad = true;
      }
    }
    if (bad) process.exit(1);
    console.log(`ok: ${names.length} projects, ${Object.keys(EXCLUDED).length} excluded, ${include.length} matrix cells`);
    return;
  }
  process.stdout.write(JSON.stringify({ include }));
}

if (require.main === module) main();
module.exports = { build, EXCLUDED, PLATFORM_LIMITS, DEFAULT_OS };
