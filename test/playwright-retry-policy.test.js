'use strict';

const assert = require('assert');
const path = require('path');

const CONFIG_PATH = require.resolve('../e2e/playwright.config');

// Reload the Playwright config with `process.platform` and `process.env.CI`
// forced to the requested combination. The config computes `retries` at module
// evaluation time, so it has to be re-required for each case.
function loadConfig({ platform, ci }) {
  const realPlatform = process.platform;
  const hadCi = Object.prototype.hasOwnProperty.call(process.env, 'CI');
  const realCi = process.env.CI;

  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  if (ci) process.env.CI = 'true';
  else delete process.env.CI;

  delete require.cache[CONFIG_PATH];
  try {
    return require(CONFIG_PATH);
  } finally {
    Object.defineProperty(process, 'platform', {
      value: realPlatform,
      configurable: true,
    });
    if (hadCi) process.env.CI = realCi;
    else delete process.env.CI;
    delete require.cache[CONFIG_PATH];
  }
}

// The browser gate is retry-free everywhere the crash cannot happen. The single
// exception is Windows CI, where node-pty's ConPTY teardown can kill the
// Playwright worker outright (access violation 3221225477). See
// docs/history/windows-conpty-worker-crash-2026.md.
describe('Playwright retry policy', function () {
  it('allows exactly one retry on Windows CI', function () {
    const config = loadConfig({ platform: 'win32', ci: true });
    assert.strictEqual(
      config.retries,
      1,
      'Windows CI contains the node-pty worker crash with one retry — never more, '
        + 'so a deterministic failure still fails both attempts'
    );
  });

  it('stays retry-free on POSIX CI, which cannot reach the crashing code path', function () {
    for (const platform of ['linux', 'darwin']) {
      const config = loadConfig({ platform, ci: true });
      assert.strictEqual(
        config.retries,
        0,
        `${platform} CI must stay retry-free: conpty_console_list_agent ships only `
          + 'in the win32 binary package, so a flake there has no third-party excuse'
      );
    }
  });

  it('stays retry-free for local runs on every platform', function () {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const config = loadConfig({ platform, ci: false });
      assert.strictEqual(
        config.retries,
        0,
        `local ${platform} runs must surface flakes raw`
      );
    }
  });

  it('keeps forbidOnly and the project list intact across the reload', function () {
    const config = loadConfig({ platform: 'win32', ci: true });
    assert.strictEqual(config.forbidOnly, true, 'CI must still reject test.only');
    assert.ok(
      Array.isArray(config.projects) && config.projects.length > 0,
      'projects must survive the platform override'
    );
    assert.ok(
      config.projects.some((p) => p.name === 'functional-extended'),
      'the project that surfaced the crash must still be defined'
    );
  });

  it('restores the real platform and CI value after loading', function () {
    const before = process.platform;
    loadConfig({ platform: 'win32', ci: true });
    assert.strictEqual(process.platform, before, 'process.platform must be restored');
    assert.strictEqual(
      path.basename(CONFIG_PATH),
      'playwright.config.js',
      'the config under test must be the e2e one'
    );
  });
});
