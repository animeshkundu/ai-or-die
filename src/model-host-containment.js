'use strict';

const { execFile } = require('child_process');
const jobGuard = require('./job-guard');

function attachHost(child) {
  if (process.platform !== 'win32') return { ok: true, job: null };
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
    '  $_.CommandLine -match "(?:^|[\\\\/])(?:stt-host|sticky-note-host)\\.js(?:\\"|\\s)" -and',
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
  ].join('; ');
}

function sweepOrphanHosts() {
  if (process.platform !== 'win32' || process.env.AI_OR_DIE_SKIP_ORPHAN_SWEEP === '1') return;
  const script = buildOrphanSweepScript(process.pid);
  execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 10000,
  }, () => {});
}

module.exports = { attachHost, closeHostJob, sweepOrphanHosts, buildOrphanSweepScript };
