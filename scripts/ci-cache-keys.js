#!/usr/bin/env node
'use strict';

// Asserts that every Playwright browser cache key a CONSUMER job will look for
// is actually written by some PRODUCER job.
//
// Why this exists: the browser tier was red for days because the cache key did
// not encode WHICH browsers an entry contained. Cache entries are immutable, so
// the first job to save owned that key for the whole Playwright version — and
// the chromium-only writer usually won, having less to download. Every WebKit
// job then got an exact cache HIT containing no WebKit and had to cold-download
// it inside a budget sized for a hit. Nothing in review looked wrong: the key
// expression was identical in both places, which was precisely the bug.
//
// A producer/consumer mismatch is invisible to YAML linting and to any
// single-file validation, because it is a relationship BETWEEN files. So
// compute both sides and compare them.
//
// This mirrors the key expression in
// .github/actions/install-playwright/action.yml. If that expression changes,
// change cacheKey() below in the same commit, or this check silently passes
// while meaning nothing.
//
// Usage:
//   node scripts/ci-cache-keys.js           # report the mapping
//   node scripts/ci-cache-keys.js --check   # non-zero if any consumer is orphaned

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');

// runner.os / runner.arch as GitHub reports them per runner label. macos-latest
// is ARM64 while the others are X64 — which is exactly why the key carries
// runner.arch: without it a macOS entry could collide with another platform's.
const RUNNER = {
  'ubuntu-latest': { os: 'Linux', arch: 'X64' },
  'windows-latest': { os: 'Windows', arch: 'X64' },
  'macos-latest': { os: 'macOS', arch: 'ARM64' },
};

// Jobs whose purpose is to publish a browser cache entry.
const PRODUCERS = [
  ['.github/workflows/ci.yml', 'prewarm-browsers'],
  ['.github/workflows/warm-caches.yml', 'browsers'],
];

function playwrightVersion() {
  return require(path.join(ROOT, 'node_modules', 'playwright', 'package.json')).version;
}

// Must stay identical to the `set` computation in the install-playwright action.
function browserToken(browsers) {
  return String(browsers).trim().split(/\s+/).filter(Boolean).sort()
    .filter((v, i, a) => a.indexOf(v) === i)
    .join('-');
}

function cacheKey(osLabel, browsers, version) {
  const runner = RUNNER[osLabel];
  if (!runner) throw new Error(`unknown runner label '${osLabel}' — add it to RUNNER`);
  return `playwright-v2-${runner.os}-${runner.arch}-${browserToken(browsers)}-${version}-complete`;
}

function loadYaml(rel) {
  return yaml.load(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function build() {
  const version = playwrightVersion();
  const producers = new Map();
  const consumers = new Map();
  const add = (map, key, who) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(who);
  };

  for (const [file, job] of PRODUCERS) {
    const def = loadYaml(file).jobs[job];
    if (!def) throw new Error(`${file} has no job '${job}' — the producer list is stale`);
    for (const cell of def.strategy.matrix.include) {
      add(producers, cacheKey(cell.os, cell.browser, version), `${job} (${cell.os}/${cell.browser})`);
    }
  }

  // Consumers: the derived browser matrix, plus longevity-smoke — a separate
  // workflow, which is easy to forget precisely because it is separate. Its
  // macOS cell had no producer at all until this check was written.
  const derived = JSON.parse(
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ci-browser-matrix.js')]).toString()
  ).include;
  for (const cell of derived) {
    add(consumers, cacheKey(cell.os, cell.browser, version), `test-browser ${cell.label} (${cell.os})`);
  }
  const smoke = loadYaml('.github/workflows/longevity-smoke.yml').jobs['longevity-smoke'];
  for (const os of smoke.strategy.matrix.os) {
    add(consumers, cacheKey(os, 'chromium', version), `longevity-smoke (${os})`);
  }

  return {
    version,
    producers,
    consumers,
    orphaned: [...consumers.keys()].filter((k) => !producers.has(k)),
    unused: [...producers.keys()].filter((k) => !consumers.has(k)),
  };
}

function main() {
  const { version, producers, consumers, orphaned, unused } = build();

  if (!process.argv.includes('--check')) {
    console.log(`playwright ${version}\n`);
    console.log('PRODUCED:');
    [...producers.keys()].sort().forEach((k) => console.log(`  ${k}\n      by ${producers.get(k).join(', ')}`));
    console.log('\nCONSUMED:');
    [...consumers.keys()].sort().forEach((k) => {
      console.log(`  ${producers.has(k) ? 'HIT ' : 'MISS'} ${k}\n      for ${consumers.get(k).join(', ')}`);
    });
    console.log('');
  }

  for (const k of orphaned) {
    console.error(`no producer writes ${k} — needed by ${consumers.get(k).join(', ')}`);
  }
  // Not fatal: a produced-but-unconsumed entry only wastes one download. Still
  // worth surfacing, because it usually means a consumer was removed and its
  // producer was not.
  for (const k of unused) {
    console.warn(`warning: ${k} is produced by ${producers.get(k).join(', ')} but nothing consumes it`);
  }

  if (orphaned.length) {
    console.error(`FAIL: ${orphaned.length} of ${consumers.size} consumer cache keys have no producer`);
    process.exit(1);
  }
  console.log(`ok: ${consumers.size} consumer cache keys, all produced; ${producers.size} producer keys`);
}

if (require.main === module) main();
module.exports = { build, cacheKey, browserToken };
