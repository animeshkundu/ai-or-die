// test/probes/pwsh-spawn.js — Probe 1 for ADR-0021 (pwsh-priority).
//
// Empirically validates that @lydell/node-pty can spawn pwsh on Windows
// with the wrapper-injection pattern we're considering:
//   pwsh.exe -NoLogo -NoExit -ExecutionPolicy Bypass -File <tempdir>\profile.ps1
//
// Captures: spawn success, .ps1 sourcing, ExecutionPolicy override, output
// buffer, exit code. Repeats with a tempdir whose name contains spaces as
// defense-in-depth against the path-quoting hazards documented in the
// PowerShell / node-pty docs (StackOverflow #18537098, etc.).
//
// Intended to run via .github/workflows/probe-pwsh.yml on a windows-latest
// CI runner. Writes structured findings to probe-1.txt (stdout-captured by
// the workflow step), uploaded as a workflow artifact.
//
// Standalone — does NOT touch src/ or production code paths. Safe to delete
// after ADR-0021 lands.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let pty;
try {
  pty = require('@lydell/node-pty');
} catch (err) {
  console.error('FATAL: cannot load @lydell/node-pty:', err && err.message);
  process.exit(2);
}

function log(msg) {
  // Use console.log so the workflow step's stdout redirect captures it.
  console.log(msg);
}

/**
 * Spawn pwsh with a temporary -File script under the given tempdir layout.
 * Returns a promise that resolves with { exitCode, buffer, timedOut }.
 */
function probeSpawn(label, tempdirSuffix, withSpaces) {
  return new Promise((resolve) => {
    const dirPrefix = withSpaces
      ? 'pwsh-probe With Spaces-'
      : 'pwsh-probe-';
    const tempdir = fs.mkdtempSync(path.join(os.tmpdir(), dirPrefix + tempdirSuffix));
    const ps1Path = path.join(tempdir, 'profile.ps1');

    // The probe script: confirm sourcing fired, capture process-scoped
    // ExecutionPolicy, then exit cleanly. Keep it short to avoid hitting
    // the spawn-watchdog window.
    const ps1Body = [
      '# Probe script — sourced via pwsh -File',
      'Write-Host "PROBE_OK pid=$PID"',
      'Get-ExecutionPolicy -Scope Process | ForEach-Object { Write-Host "PROCESS_POLICY=$_" }',
      '"Tempdir: " + $PSScriptRoot | Write-Host',
      'exit 0',
      ''
    ].join('\r\n');
    fs.writeFileSync(ps1Path, ps1Body, { encoding: 'utf8' });

    log('==============================================================');
    log(`[${label}] tempdir = ${tempdir}`);
    log(`[${label}] ps1Path = ${ps1Path}`);
    log(`[${label}] withSpaces = ${withSpaces}`);

    // Spawn — use array form per the documented safe pattern.
    // Note: -NoExit kept off here so the probe exits cleanly when the
    // script's `exit 0` fires. We're not testing interactive behavior;
    // we're testing that the -File mechanism + array-form quoting works.
    const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path];
    log(`[${label}] spawn args = ${JSON.stringify(args)}`);

    let proc;
    try {
      proc = pty.spawn('pwsh.exe', args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: tempdir,
        env: process.env,
      });
    } catch (err) {
      log(`[${label}] SPAWN_THREW: ${err && err.message}`);
      // Cleanup tempdir
      try { fs.rmSync(tempdir, { recursive: true, force: true }); } catch (_) {}
      return resolve({ exitCode: -1, buffer: '', timedOut: false, error: err && err.message });
    }

    let buffer = '';
    let resolved = false;
    proc.onData((data) => { buffer += data; });

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      log(`[${label}] TIMEOUT after 10s`);
      try { proc.kill(); } catch (_) {}
      try { fs.rmSync(tempdir, { recursive: true, force: true }); } catch (_) {}
      resolve({ exitCode: -1, buffer, timedOut: true });
    }, 10000);

    proc.onExit(({ exitCode, signal }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      log(`[${label}] EXIT_CODE=${exitCode} SIGNAL=${signal != null ? signal : 'null'}`);
      log(`[${label}] BUFFER (${buffer.length} bytes):`);
      log(buffer.split('\n').map((line) => '  | ' + line).join('\n'));
      try { fs.rmSync(tempdir, { recursive: true, force: true }); } catch (_) {}
      resolve({ exitCode, signal, buffer, timedOut: false });
    });
  });
}

(async () => {
  log('Probe 1 — @lydell/node-pty + pwsh.exe -File argument quoting');
  log('Node: ' + process.version);
  log('Platform: ' + process.platform + ' / ' + process.arch);
  log('os.tmpdir: ' + os.tmpdir());

  // Scenario A: plain tempdir name (no spaces).
  const a = await probeSpawn('A:plain', 'a', false);

  // Scenario B: tempdir with spaces — exercises the array-form quoting hazard.
  const b = await probeSpawn('B:spaces', 'b', true);

  // Scenario C: very long tempdir name (path-length stress).
  // Repeat a 30-char string a few times — under Windows 260-char MAX_PATH
  // limit when nested in os.tmpdir() but stresses the quoting code path.
  const longSuffix = 'long-' + 'x'.repeat(30) + '-' + 'y'.repeat(30);
  const c = await probeSpawn('C:long', longSuffix, false);

  log('==============================================================');
  log('SUMMARY');
  log(`A:plain    exitCode=${a.exitCode} timedOut=${a.timedOut} bufferLen=${a.buffer ? a.buffer.length : 0}`);
  log(`B:spaces   exitCode=${b.exitCode} timedOut=${b.timedOut} bufferLen=${b.buffer ? b.buffer.length : 0}`);
  log(`C:long     exitCode=${c.exitCode} timedOut=${c.timedOut} bufferLen=${c.buffer ? c.buffer.length : 0}`);

  // Look for the PROBE_OK marker in each buffer — sourcing succeeded.
  function hasMarker(s) { return s && s.indexOf('PROBE_OK') !== -1 ? 'YES' : 'NO'; }
  function hasPolicy(s) { return s && s.indexOf('PROCESS_POLICY=Bypass') !== -1 ? 'YES' : 'NO'; }
  log('Sourcing succeeded (PROBE_OK in buffer):');
  log(`  A:plain  ${hasMarker(a.buffer)}`);
  log(`  B:spaces ${hasMarker(b.buffer)}`);
  log(`  C:long   ${hasMarker(c.buffer)}`);
  log('ExecutionPolicy override applied (Bypass):');
  log(`  A:plain  ${hasPolicy(a.buffer)}`);
  log(`  B:spaces ${hasPolicy(b.buffer)}`);
  log(`  C:long   ${hasPolicy(c.buffer)}`);

  // Exit with non-zero if any scenario timed out or had a non-zero pwsh exit code.
  const allOK = !a.timedOut && !b.timedOut && !c.timedOut &&
                a.exitCode === 0 && b.exitCode === 0 && c.exitCode === 0;
  process.exit(allOK ? 0 : 1);
})();
