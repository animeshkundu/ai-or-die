'use strict';

const childProcess = require('child_process');
const KeepaliveManager = require('./keepalive-manager');

// Opt-in remediation for HOST-INITIATED sleep on Windows (primarily Hyper-V
// guests). The keepalive wake assertion (SetThreadExecutionState /
// PowerRequestSystemRequired) only suppresses the IDLE timer; Windows documents
// that it "cannot be used to prevent ... standby or hibernate" when the suspend
// is requested programmatically. On a Hyper-V guest, the host's Guest Shutdown
// Service (`vmicshutdown`) requests hibernation through the Application API,
// which the assertion cannot block. The only reliable fix is to remove the sleep
// target itself: `powercfg /hibernate off` (+ sleep/hibernate timeouts -> Never).
// On a Hyper-V guest S3 standby is typically unavailable, so disabling S4
// hibernate eliminates the vector entirely.
//
// That is a PRIVILEGED, PERSISTENT machine change (survives our process exit;
// reversible with `powercfg /hibernate on`), so it is OFF by default and gated
// behind --disable-hibernation / AIORDIE_DISABLE_HIBERNATION=1. When enabled, one
// long-lived in-box `powershell.exe` (spawned like the keepalive helper) runs
// ONCE at startup:
//   1. Reads HKLM\...\Power\HibernateEnabled (non-privileged). If already 0 it
//      prints SKIPPED and exits -- no UAC prompt, so a machine that is already
//      configured never prompts again.
//   2. Otherwise it launches an ELEVATED cmd.exe via `Start-Process -Verb RunAs`
//      (UAC is the OS approve/deny; the flag is the user's pre-approval) that runs
//      the powercfg remediation, then prints APPLIED / DENIED / ERROR.
// Best-effort and non-fatal: a denied UAC prompt, a headless/remote session with
// no interactive desktop, or any spawn failure logs a warning and the server
// continues normally. Never throws into startup. Windows-only; instant no-op on
// macOS/Linux. See docs/specs/keepalive.md and docs/adrs/0030-hibernation-guard.md.

// The remediation, chained under ONE elevation (one UAC prompt) via `cmd /c a & b`.
// All constants (no user input), so there is no command-injection surface. `& `
// runs every command regardless of a prior one's exit; success is judged by
// re-reading HibernateEnabled afterward (not the chain's exit code, which only
// reflects the last command), so an early failure can't be masked.
const REMEDIATION = [
  'powercfg /hibernate off',
  'powercfg /change standby-timeout-ac 0',
  'powercfg /change standby-timeout-dc 0',
  'powercfg /change hibernate-timeout-ac 0',
  'powercfg /change hibernate-timeout-dc 0',
];

const READY_TIMEOUT_MS = 60000;

class HibernationGuard {
  constructor(options = {}) {
    this._enabled = !!options.enabled;
    this._platform = options.platform || process.platform;
    this._spawn = options.spawn || childProcess.spawn;
    this._logger = options.logger || console;
    this._readyTimeoutMs = options.readyTimeoutMs || READY_TIMEOUT_MS;

    this._ran = false;
    this._child = null;
  }

  // ---- pure builders (static so tests assert them without spawning) ----

  static buildScript(ppid = process.pid) {
    const argline = '/c ' + REMEDIATION.join(' & ');
    return [
      // 'Stop' turns a blocked/failed cmdlet into a caught terminating error
      // rather than a silent partial run.
      `$ErrorActionPreference = 'Stop'`,
      // Trusted-integer parent-PID tag for triage (never user input).
      `# aod-hibernation ppid=${ppid}`,
      // (1) Non-privileged detect. Skip (no UAC) when hibernate is already off.
      `$he = $null`,
      `try { $he = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power' -Name 'HibernateEnabled' -ErrorAction Stop).HibernateEnabled } catch { $he = $null }`,
      `if ($he -eq 0) { [Console]::Out.WriteLine('SKIPPED'); exit 0 }`,
      // (2) One elevated cmd.exe runs the whole powercfg chain under a single UAC
      // prompt. Absolute cmd path (PATH-hijack hardening). WaitForExit + ExitCode
      // is more reliable than -Wait with -Verb RunAs for reading the result.
      `$cmd = Join-Path $env:SystemRoot 'System32\\cmd.exe'`,
      `$argline = '${argline}'`,
      `try {`,
      `  $p = Start-Process -FilePath $cmd -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList $argline`,
      `  $p.WaitForExit()`,
      // Verify the critical end-state directly rather than trusting the exit code:
      // `cmd /c a & b & c` reports only the LAST command's exit, so an early
      // failure could be masked. APPLIED iff hibernation is now actually off.
      `  $after = $null`,
      `  try { $after = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power' -Name 'HibernateEnabled' -ErrorAction Stop).HibernateEnabled } catch { $after = $null }`,
      `  if ($after -eq 0) { [Console]::Out.WriteLine('APPLIED') } else { [Console]::Out.WriteLine('ERROR'); [Console]::Error.WriteLine('hibernate still enabled after powercfg (exit=' + $p.ExitCode + ')') }`,
      `} catch {`,
      // Detect a declined UAC by the Win32 error code (1223 = ERROR_CANCELLED),
      // locale-independent; walk the inner-exception chain, then fall back to text.
      `  $cancelled = $false`,
      `  $e = $_.Exception`,
      `  while ($null -ne $e) { if (($e -is [System.ComponentModel.Win32Exception]) -and ($e.NativeErrorCode -eq 1223)) { $cancelled = $true; break }; $e = $e.InnerException }`,
      `  if (-not $cancelled -and $_.Exception.Message -match 'cancel') { $cancelled = $true }`,
      `  if ($cancelled) { [Console]::Out.WriteLine('DENIED') } else { [Console]::Out.WriteLine('ERROR'); [Console]::Error.WriteLine($_.Exception.Message) }`,
      `}`,
    ].join('\n');
  }

  static buildArgs(ppid = process.pid) {
    return [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', HibernationGuard.buildScript(ppid),
    ];
  }

  // Attempt the remediation once. No-op unless enabled on win32. Idempotent.
  // Fire-and-forget: the server never awaits this (the UAC prompt is interactive
  // and may take a while). Never throws.
  run() {
    if (this._ran) return;
    if (!this._enabled || this._platform !== 'win32') return;
    this._ran = true;

    try {
      const ps = KeepaliveManager.powershellPath();
      const args = HibernationGuard.buildArgs();
      const child = this._spawn(ps, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
      this._child = child;

      // Never let the helper pin the parent's event loop.
      this._safe(() => child.unref());
      this._safe(() => child.stdout && child.stdout.unref && child.stdout.unref());
      this._safe(() => child.stderr && child.stderr.unref && child.stderr.unref());

      let out = '';
      let err = '';
      if (child.stdout) {
        this._safe(() => child.stdout.setEncoding && child.stdout.setEncoding('utf8'));
        child.stdout.on('data', (d) => { out += String(d); });
        child.stdout.on('error', () => {});
      }
      if (child.stderr) {
        this._safe(() => child.stderr.setEncoding && child.stderr.setEncoding('utf8'));
        child.stderr.on('data', (d) => { err += String(d); });
        child.stderr.on('error', () => {});
      }

      let settled = false;
      const finish = (status, hint) => {
        if (settled) return;
        settled = true;
        this._safe(() => clearTimeout(timer));
        if (this._child === child) this._child = null;
        this._logOutcome(status, hint);
      };

      // The UAC prompt blocks the helper until the user responds; only reap after
      // a generous timeout so a genuinely stuck helper cannot linger forever.
      const timer = setTimeout(() => {
        finish('ERROR', 'timed out waiting for the elevation prompt');
        this._safe(() => child.kill && child.kill());
      }, this._readyTimeoutMs);
      if (timer.unref) timer.unref();

      child.on('error', (e) => finish('ERROR', (e && e.message) || 'spawn error'));
      child.on('close', () => {
        const m = out.match(/\b(APPLIED|SKIPPED|DENIED|ERROR)\b/);
        finish(m ? m[1] : 'ERROR', err.trim());
      });
    } catch (err) {
      this._child = null;
      this._safe(() => this._logger.debug && this._logger.debug(
        'hibernation-guard: failed to start (continuing):', err && err.message));
    }
  }

  _logOutcome(status, hint) {
    const L = this._logger;
    switch (status) {
      case 'APPLIED':
        this._safe(() => L.log && L.log(
          'hibernation guard: hibernation disabled + sleep/hibernate timeouts set to Never (host-initiated hibernation suppressed)'));
        break;
      case 'SKIPPED':
        this._safe(() => L.log && L.log(
          'hibernation guard: hibernation already disabled — nothing to do'));
        break;
      case 'DENIED':
        this._safe(() => L.warn && L.warn(
          '⚠  hibernation guard: elevation declined — hibernation left enabled. A Hyper-V host can still hibernate this machine. Run `powercfg /hibernate off` as admin, or relaunch without --disable-hibernation.'));
        break;
      default:
        this._safe(() => L.warn && L.warn(
          `⚠  hibernation guard: could not disable hibernation${hint ? ` (${hint})` : ''}; the host may still hibernate this machine. Run \`powercfg /hibernate off\` as admin.`));
        break;
    }
  }

  _safe(fn) {
    try { return fn(); } catch (_) { /* the guard must never throw into the caller */ }
  }
}

module.exports = HibernationGuard;
module.exports.REMEDIATION = REMEDIATION;
