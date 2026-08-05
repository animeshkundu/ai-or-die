'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Regression guard for a CI hang, not for product behaviour.
//
// Playwright releases before 1.60.0 download every browser byte and then hang
// forever in extraction when run on Node >= 24.16 (microsoft/playwright#41000).
// CI pins node-version '26', so every `playwright install` step stalled until
// the job-level timeout killed it, and no browser suite could run at all. A
// retry loop cannot rescue that: the process never exits, so it never retries.
//
// Verified locally on Node 26.6.0: 1.58.2 hangs (killed at 240s), 1.60.0
// completes. Pinning the floor here stops a future dependency edit from
// silently walking back under it.
const MIN_PLAYWRIGHT = [1, 60, 0];

function parseVersion(range) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  assert.ok(match, `unparseable @playwright/test version range: ${range}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}

describe('Playwright version floor', () => {
  const repoRoot = path.join(__dirname, '..');

  it('package.json declares @playwright/test at or above the extraction-hang fix', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const range = pkg.devDependencies && pkg.devDependencies['@playwright/test'];
    assert.ok(range, '@playwright/test must stay a devDependency');
    assert.ok(
      atLeast(parseVersion(range), MIN_PLAYWRIGHT),
      `@playwright/test ${range} is below ${MIN_PLAYWRIGHT.join('.')}; ` +
        'installs hang forever on the Node version CI runs'
    );
  });

  it('the lockfile resolves @playwright/test at or above the floor', () => {
    const lockPath = path.join(repoRoot, 'package-lock.json');
    if (!fs.existsSync(lockPath)) return;
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const entry = lock.packages && lock.packages['node_modules/@playwright/test'];
    assert.ok(entry && entry.version, 'lockfile must resolve @playwright/test');
    assert.ok(
      atLeast(parseVersion(entry.version), MIN_PLAYWRIGHT),
      `lockfile pins @playwright/test ${entry.version}, below ${MIN_PLAYWRIGHT.join('.')}`
    );
  });
});
