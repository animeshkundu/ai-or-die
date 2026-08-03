#!/usr/bin/env node
'use strict';

// Bounded, instrumented Playwright browser install for CI.
//
// Why this exists rather than an inline `for i in 1 2 3; do npx playwright
// install ... done` loop:
//
//   1. A shell retry loop does NOT bound a HANG. `longevity-smoke` hung in
//      `npx playwright install --with-deps chromium` for the entire job budget
//      on all three platforms across four consecutive commits — the test gate
//      never ran. Wrapping that loop in a step-level `timeout-minutes` gives
//      you ONE bounded attempt, not three: attempt 1 consumes the whole budget
//      and attempts 2 and 3 never happen. The timeout has to be PER ATTEMPT.
//   2. `timeout(1)` is not portable — Git Bash on the Windows runners does not
//      ship GNU timeout, and Windows' own timeout.exe is a different command.
//      Node is present on every runner by definition, so the watchdog lives
//      here and kills the whole process tree.
//   3. `--with-deps` couples browser download with a host `apt-get` install.
//      Those fail for completely different reasons (CDN vs dpkg lock, often
//      unattended-upgrades on a fresh runner) and must be timed and reported
//      separately, or you cannot tell which one hung.
//
// Usage:
//   node scripts/ci-install-playwright.js chromium [webkit ...]
// Env:
//   PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT_MS  per-attempt budget (default 240000)
//   PLAYWRIGHT_INSTALL_ATTEMPTS            attempts per phase (default 3)
//   PLAYWRIGHT_SKIP_DEPS=1                 skip the host-dependency phase

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ATTEMPT_TIMEOUT_MS = parseInt(process.env.PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT_MS, 10) || 240000;
const ATTEMPTS = parseInt(process.env.PLAYWRIGHT_INSTALL_ATTEMPTS, 10) || 3;
const IS_WIN = process.platform === 'win32';

// Invoke Playwright's CLI with node directly rather than going through the
// `npx` shim.
//
// On Windows npx is `npx.cmd`, and Node >= 24 refuses to spawn a .cmd without
// `shell: true` (spawn EINVAL — hardening for CVE-2024-27980). Turning the
// shell on would work but re-introduces the arg-concatenation warning
// (DEP0190) and an extra process layer between us and the installer, which is
// precisely the layer the watchdog has to kill. Resolving the CLI entry keeps
// this to one child on every platform.
function playwrightCli() {
  // Resolve via package.json + the `bin` field, NOT require.resolve('playwright/cli.js').
  // Modern Playwright ships an `exports` map that does not expose ./cli.js, so
  // the direct subpath resolve throws even though the file is right there.
  for (const pkg of ['playwright', '@playwright/test']) {
    try {
      const manifestPath = require.resolve(`${pkg}/package.json`);
      const manifest = require(manifestPath);
      const rel = typeof manifest.bin === 'string'
        ? manifest.bin
        : (manifest.bin && (manifest.bin.playwright || Object.values(manifest.bin)[0]));
      if (!rel) continue;
      const abs = path.join(path.dirname(manifestPath), rel);
      if (fs.existsSync(abs)) return abs;
    } catch (_) { /* try next */ }
  }
  return null;
}

function log(msg) { process.stdout.write(`[playwright-install] ${msg}\n`); }

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
    }
  } catch (_) { /* best effort */ }
}

// Runs one attempt with a hard wall-clock bound. Resolves
// {ok, code, timedOut, ms} — never rejects, so the caller drives retry policy.
function runBounded(command, args, label) {
  return new Promise((resolve) => {
    const started = Date.now();
    log(`${label}: starting (budget ${Math.round(ATTEMPT_TIMEOUT_MS / 1000)}s)`);
    const child = spawn(command, args, {
      stdio: 'inherit',
      // Own process group on POSIX so the watchdog can reap descendants —
      // npx spawns node which spawns the installer.
      detached: !IS_WIN,
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, ATTEMPT_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      log(`${label}: spawn error ${error && error.message}`);
      resolve({ ok: false, code: null, timedOut: false, ms: Date.now() - started });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (timedOut) log(`${label}: TIMED OUT after ${Math.round(ms / 1000)}s — killed process tree`);
      else log(`${label}: exit ${code} after ${Math.round(ms / 1000)}s`);
      resolve({ ok: code === 0 && !timedOut, code, timedOut, ms });
    });
  });
}

async function withRetries(command, args, label) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = await runBounded(command, args, `${label} attempt ${attempt}/${ATTEMPTS}`);
    if (result.ok) return true;
    if (attempt < ATTEMPTS) {
      const backoff = 5000 * attempt;
      log(`${label}: retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  return false;
}

async function main() {
  const browsers = process.argv.slice(2).filter(Boolean);
  if (!browsers.length) {
    console.error('usage: ci-install-playwright.js <browser...>');
    process.exit(2);
  }

  log(`platform=${process.platform} arch=${process.arch} node=${process.version}`);
  log(`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || '(default)'}`);
  log(`browsers=${browsers.join(',')} tmpdir=${os.tmpdir()}`);

  const cli = playwrightCli();
  if (!cli) {
    console.error('[playwright-install] cannot resolve the Playwright CLI — is @playwright/test installed?');
    process.exit(2);
  }
  log(`cli=${cli}`);

  // Phase 1 — host dependencies. Linux only (`--with-deps` is a no-op
  // elsewhere), time-boxed, and NON-FATAL: GitHub's ubuntu images already ship
  // the libraries Chromium needs, so a dpkg-lock stall must not sink the job.
  // Reported separately so a hang here is attributable.
  if (process.platform === 'linux' && process.env.PLAYWRIGHT_SKIP_DEPS !== '1') {
    const depsOk = await withRetries(process.execPath, [cli, 'install-deps', ...browsers], 'host-deps');
    if (!depsOk) log('host-deps: FAILED or timed out — continuing; runner images usually satisfy these already');
  }

  // Phase 2 — the browsers themselves. This one IS fatal: without a browser
  // the suite cannot run, and silently proceeding would produce a confusing
  // downstream failure instead of a clear one here.
  const browsersOk = await withRetries(process.execPath, [cli, 'install', ...browsers], 'browsers');
  if (!browsersOk) {
    log('browsers: FAILED after all attempts');
    process.exit(1);
  }
  log('done');
}

main().catch((error) => {
  console.error('[playwright-install] unexpected:', error && error.stack);
  process.exit(1);
});
