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
};

// Projects that only run on a subset of platforms, with the reason.
const PLATFORM_LIMITS = {
  'ios-ipad11': { os: ['ubuntu-latest'], why: 'WebKit; Linux runner is the supported WebKit host' },
  'ios-ipad11-landscape': { os: ['ubuntu-latest'], why: 'WebKit' },
  'ios-iphone16': { os: ['ubuntu-latest'], why: 'WebKit' },
  'ios-iphone16-landscape': { os: ['ubuntu-latest'], why: 'WebKit' },
};

const DEFAULT_OS = ['ubuntu-latest', 'windows-latest'];

// How many jobs to spread each (os, browser) group across.
//
// One job per project is the most granular reporting, but every job pays
// checkout + setup-node + npm ci before it runs a single test — roughly 1.5
// min of pure overhead. Measured: the previous hand-written layout ran 33
// browser jobs in 145 min of runner time; one-cell-per-project would be 42
// jobs for ~185 min. That is ~28% more compute to test exactly the same code.
//
// Bucketing is not a new idea here — the old layout already did it implicitly
// (test-browser-mobile ran 2 projects, ios-webkit ran 4). This just makes it
// explicit and tunable. Playwright still reports results per project inside a
// bucket, so a failure is still attributable to a project; you read a job log
// instead of a job name.
//
// Raise for finer granularity and more parallelism, lower to cut runner cost.
// Set to 0 for one job per project.
const CHROMIUM_BUCKETS = parseInt(process.env.CI_BROWSER_BUCKETS, 10) || 6;

function chunk(items, buckets) {
  if (!buckets || buckets >= items.length) return items.map((i) => [i]);
  const out = Array.from({ length: buckets }, () => []);
  // Round-robin rather than contiguous slices: adjacent projects tend to have
  // similar cost (the mobile-* family, the ios-* family), so contiguous slicing
  // would pile the slow ones into one bucket and leave others idle.
  items.forEach((item, index) => out[index % buckets].push(item));
  return out.filter((b) => b.length);
}

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

  // Group by (os, browser) first: a job installs ONE browser, and mixing
  // chromium and webkit projects into one job would force it to install both.
  const groups = new Map();
  for (const { name: project, browser } of entries) {
    if (EXCLUDED[project]) continue;
    const limit = PLATFORM_LIMITS[project];
    for (const os of (limit ? limit.os : DEFAULT_OS)) {
      const key = `${os}::${browser}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(project);
    }
  }

  const include = [];
  for (const [key, projects] of groups) {
    const [os, browser] = key.split('::');
    // webkit is only the 4 ios-* projects — keep them in a single job rather
    // than paying a second browser install to split 4 fast tests.
    const buckets = browser === 'webkit' ? 1 : CHROMIUM_BUCKETS;
    for (const group of chunk(projects.slice().sort(), buckets)) {
      include.push({
        os,
        browser,
        projects: group.join(' '),
        // Stable, readable job label. Names appear in branch protection, so
        // keep them derived from content rather than an index that shifts when
        // a project is added.
        label: group.length === 1 ? group[0] : `${browser}-${group[0]}+${group.length - 1}`,
      });
    }
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
