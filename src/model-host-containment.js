'use strict';

const { execFile: defaultExecFile } = require('child_process');
const jobGuard = require('./job-guard');
const KeepaliveManager = require('./keepalive-manager');

function attachHost(child) {
  if (process.platform !== 'win32') return { ok: true, job: null };
  // Structurally unavailable (Bun, SEA, koffi missing, operator opt-out) is the
  // documented degraded mode, not a failure: fall back to killProcessTreeSync
  // exactly as base-bridge._attachPtyJob does. Only a guard that IS available
  // and then fails is fatal, because that means containment was expected to
  // work and silently did not.
  if (!jobGuard.isAvailable()) return { ok: true, job: null, degraded: true };
  // No pid means the process never started — a spawn error is already in flight
  // and will surface on its own. There is nothing running to contain, so
  // reporting a containment failure here would mask the real cause (e.g. an
  // EACCES from spawn) behind an opaque Job Object message.
  if (!child || typeof child.pid !== 'number' || child.pid <= 0) return { ok: true, job: null };
  const job = jobGuard.createKillOnCloseJob();
  if (!job) return { ok: false, job: null, error: new Error('Unable to create model-host Job Object') };
  if (!jobGuard.assignPid(job, child.pid)) {
    jobGuard.closeJob(job);
    return { ok: false, job: null, error: new Error('Unable to assign model host to Job Object') };
  }
  return { ok: true, job };
}

function closeHostJob(job) {
  if (job) jobGuard.closeJob(job);
}

function buildOrphanSweepScript(currentPid) {
  return [
    '$self = ' + currentPid,
    '$hosts = Get-CimInstance Win32_Process | Where-Object {',
    '  $_.Name -match "^(?:node|bun)(?:\\.exe)?$" -and',
    '  $_.CommandLine -match \'(?:^|[\\\\/])(?:stt-host|sticky-note-host)\\.js(?:"|\\s)\' -and',
    '  $_.CommandLine -match "(?:^|\\s)--ai-or-die-model-host(?:\\s|$)" -and',
    '  $_.CommandLine -match "(?:^|\\s)--core-pid=(\\d+)(?:\\s|$)" -and',
    '  $_.CommandLine -match "(?:^|\\s)--host=(?:stt|sticky-note)(?:\\s|$)"',
    '}',
    '$hosts | ForEach-Object {',
    '  [void]($_.CommandLine -match "(?:^|\\s)--core-pid=(\\d+)(?:\\s|$)")',
    '  $ownerPid = [int]$Matches[1]',
    '  if ($_.ParentProcessId -eq $ownerPid -and $ownerPid -ne $self -and -not (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {',
    '    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue',
    '  }',
    '}',
  ].join('\n');
}

function sweepOrphanHosts(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const execFile = options.execFile || defaultExecFile;
  const logger = options.logger || console;
  if (platform !== 'win32' || env.AI_OR_DIE_SKIP_ORPHAN_SWEEP === '1') return;

  const script = buildOrphanSweepScript(process.pid);
  const powershell = KeepaliveManager.powershellPath(env);
  let warned = false;
  const warnFailure = (error) => {
    if (warned) return;
    warned = true;
    const message = error && error.code === 'ENOENT'
      ? `PowerShell executable not found at ${powershell}; orphan model-host sweep did not run`
      : `Orphan model-host sweep failed using ${powershell}: ${error && error.message ? error.message : error}`;
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(message);
    } catch (_) {
      // Startup containment is best-effort and must not fail server boot.
    }
  };

  try {
    execFile(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 10000,
        env,
      },
      (error) => {
        if (error) warnFailure(error);
      }
    );
  } catch (error) {
    warnFailure(error);
  }
}

module.exports = { attachHost, closeHostJob, sweepOrphanHosts, buildOrphanSweepScript };
