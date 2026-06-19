'use strict';

const childProcess = require('child_process');
const path = require('path');

// Keep the host machine awake while the ai-or-die server runs (Windows 11).
//
// Mechanism: spawn ONE long-lived Windows PowerShell (5.1, in-box) helper that
// P/Invokes SetThreadExecutionState from kernel32.dll to hold a power
// assertion, then blocks on stdin. When the parent closes stdin (graceful
// release) OR dies (the OS tears down the pipe -> ReadLine() returns null), the
// helper clears the assertion and exits. Windows also drops a thread's
// execution-state flags when the holding process dies, so even taskkill /F
// cannot leak the assertion past reboot. No native deps, no powercfg.
//
// Windows-only by design; an instant no-op on macOS/Linux. See
// docs/specs/keepalive.md and docs/adrs/0028-windows-keepalive.md.

// SetThreadExecutionState flags as DECIMAL uint32 literals. PowerShell 5.1
// parses 0x80000001 as a negative Int32 and the [uint32] cast then throws, so
// the decimal forms are load-bearing (verified on a real Windows host):
//   ES_CONTINUOUS       0x80000000 = 2147483648  (clear value, continuous alone)
//   ES_SYSTEM_REQUIRED  0x00000001 -> system     = 2147483649
//   ES_DISPLAY_REQUIRED 0x00000002 -> +display   = 2147483651
const ES_CONTINUOUS = 2147483648;
const ES_SYSTEM = 2147483649;
const ES_SYSTEM_DISPLAY = 2147483651;

const READY_TIMEOUT_MS = 5000;

class KeepaliveManager {
  constructor(options = {}) {
    this._enabled = !!options.enabled;
    this._keepDisplayOn = !!options.keepDisplayOn;
    this._platform = options.platform || process.platform;
    this._spawn = options.spawn || childProcess.spawn;
    this._logger = options.logger || console;
    this._readyTimeoutMs = options.readyTimeoutMs || READY_TIMEOUT_MS;

    this._started = false;
    this._child = null;
    this._readyTimer = null;
    // Stable reference so we can both add and remove the process 'exit' hook
    // (a fresh closure each time would leak listeners across start/release).
    this._exitHandler = null;
    // Resolves true once the assertion is confirmed held, false on any failure
    // (spawn error, early exit, or readiness timeout). Used only for a status
    // log line; the lifecycle never awaits it.
    this.ready = Promise.resolve(false);
  }

  // ---- pure builders (static so tests assert them without spawning) ----

  static buildScript(displayRequired, ppid = process.pid) {
    const assert = displayRequired ? ES_SYSTEM_DISPLAY : ES_SYSTEM;
    return [
      // 'Stop' is load-bearing: under Constrained Language Mode / WDAC /
      // AppLocker / EDR, Add-Type (which writes a .cs to %TEMP% and shells to
      // csc.exe) is blocked. With the default 'Continue', a blocked Add-Type
      // would NOT exit -- PowerShell would fall into the infinite stdin loop
      // and leak an immortal ~30-50MB process on every restart. 'Stop' makes
      // the child die immediately so our handler fires and ready -> false.
      `$ErrorActionPreference = 'Stop'`,
      // Tag the command line with the parent PID (a trusted integer, never user
      // input) so a stale/orphaned helper is identifiable for triage:
      //   Get-CimInstance Win32_Process -Filter "Name='powershell.exe'"
      `# aod-keepalive ppid=${ppid}`,
      `Add-Type -Name P -Namespace W -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);'`,
      // exit 1 when the assertion is refused so the helper never blocks on
      // stdin WITHOUT actually holding the assertion (which would otherwise
      // latch us "started" while the machine can still sleep).
      `if ([W.P]::SetThreadExecutionState([uint32]${assert}) -ne 0) { [Console]::Out.WriteLine('OK'); [Console]::Out.Flush() } else { [Console]::Error.WriteLine('SetThreadExecutionState returned 0'); exit 1 }`,
      `while ($null -ne [Console]::In.ReadLine()) {}`,
      `[void][W.P]::SetThreadExecutionState([uint32]${ES_CONTINUOUS})`,
    ].join('\n');
  }

  static buildArgs(displayRequired, ppid = process.pid) {
    return [
      '-NoProfile',
      '-NonInteractive',
      // GPO machine-wide execution policy can otherwise block inline code /
      // the Add-Type compilation step.
      '-ExecutionPolicy', 'Bypass',
      '-Command', KeepaliveManager.buildScript(displayRequired, ppid),
    ];
  }

  // Absolute path to in-box Windows PowerShell 5.1 (PATH-hijack hardening --
  // never resolve a bare "powershell.exe" off PATH).
  static powershellPath() {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }

  // Acquire the wake assertion. No-op unless enabled on win32. Idempotent.
  // Never throws -- keepalive must never break server startup.
  start() {
    if (this._started) return;
    if (!this._enabled || this._platform !== 'win32') return;
    this._started = true;

    try {
      const ps = KeepaliveManager.powershellPath();
      const args = KeepaliveManager.buildArgs(this._keepDisplayOn);
      const child = this._spawn(ps, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
      this._child = child;

      // Never let the helper independently keep the parent's event loop alive
      // (or revive the exit-134 native-teardown abort this repo has fought).
      // unref() does NOT affect writability, so stdin stays usable by release()
      // while unreferenced.
      this._safe(() => child.unref());
      this._safe(() => child.stdout && child.stdout.unref && child.stdout.unref());
      this._safe(() => child.stderr && child.stderr.unref && child.stderr.unref());
      this._safe(() => child.stdin && child.stdin.unref && child.stdin.unref());

      // Capture the first stderr line so the failure warning can distinguish
      // Constrained Language Mode (a PowerShell error) from an AV/EDR kill.
      let firstErr = '';
      if (child.stderr) {
        this._safe(() => child.stderr.setEncoding && child.stderr.setEncoding('utf8'));
        child.stderr.on('data', (d) => { if (!firstErr) firstErr = String(d).split('\n')[0].trim(); });
        child.stderr.on('error', () => {});
      }

      // Per-start state, captured by the closures below so a stale child's
      // late events can never mutate a newer run's state.
      let settled = false;
      let acquired = false;
      let resolveReady;
      this.ready = new Promise((res) => { resolveReady = res; });

      // Declared with `let` so finishReady (defined next) can reference it and
      // clear it; the timer is created after finishReady to keep ordering clear.
      let timer = null;

      const finishReady = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) acquired = true;
        this._safe(() => clearTimeout(timer));
        if (this._readyTimer === timer) this._readyTimer = null;
        resolveReady(ok);
      };

      timer = setTimeout(() => finishReady(false), this._readyTimeoutMs);
      if (timer.unref) timer.unref();
      this._readyTimer = timer;

      if (child.stdout) {
        this._safe(() => child.stdout.setEncoding && child.stdout.setEncoding('utf8'));
        let buf = '';
        child.stdout.on('data', (d) => {
          if (settled) return; // stop buffering once readiness is decided
          buf += String(d);
          if (/(^|\n)OK(\r?\n|$)/.test(buf)) finishReady(true);
        });
        child.stdout.on('error', () => {});
      }

      // Settle on 'close' (after all stdio has flushed) rather than 'exit' so
      // firstErr is populated before the failure warning reads it. 'error'
      // covers a spawn that never produced a process. The this._child === child
      // guard makes a superseded/released child's late events a no-op.
      const onGone = () => {
        if (this._child !== child) return;
        this._child = null;
        this._started = false;
        this._safe(() => clearTimeout(timer));
        if (this._readyTimer === timer) this._readyTimer = null;
        if (!settled) {
          finishReady(false);
        } else if (acquired) {
          // Died AFTER holding the assertion (e.g. an AV/EDR kill hours in) and
          // we did not initiate the release -> the machine can now sleep.
          this._safe(() => this._logger.warn && this._logger.warn(
            '⚠  keepalive: wake assertion lost — the helper exited; the machine may sleep. Restart ai-or-die or pass --no-keepalive.'));
        }
      };
      child.on('error', onGone);
      child.on('close', onGone);

      // Guarantee release on EVERY exit path, including the ones that bypass
      // close()/release(): uncaughtException and the bin outer-catch both call
      // process.exit(1) without close(). A synchronous 'exit' hook, NOT a
      // SIGINT/SIGTERM handler, so it cannot race the server's single
      // handleShutdown owner -- it only closes a pipe. Re-registered idempotently
      // (removeListener first) and removed in releaseSync to avoid leaking
      // listeners across start/release cycles.
      if (!this._exitHandler) {
        this._exitHandler = () => { this._safe(() => this.releaseSync()); };
      }
      this._safe(() => process.removeListener('exit', this._exitHandler));
      this._safe(() => process.once('exit', this._exitHandler));

      this.ready.then((ok) => {
        if (ok) {
          this._safe(() => this._logger.log && this._logger.log(
            'keepalive: holding wake assertion (system sleep prevented)'));
        } else {
          const hint = firstErr || 'powershell.exe unavailable or blocked (Constrained Language Mode / WDAC / AV)';
          this._safe(() => this._logger.warn && this._logger.warn(
            `⚠  keepalive: could not hold the wake assertion; the machine may sleep (${hint}). Disable with --no-keepalive.`));
          // Reap a helper that timed out without exiting (e.g. SetThreadExecutionState
          // returned 0 and it is blocked on stdin) so it cannot leak.
          if (this._child === child) this._safe(() => this.releaseSync());
        }
      }).catch(() => {});
    } catch (err) {
      this._started = false;
      this._child = null;
      this._safe(() => this._logger.debug && this._logger.debug(
        'keepalive: failed to start (continuing):', err && err.message));
    }
  }

  // Async convenience wrapper; the real work is synchronous (just close a pipe).
  release() {
    this.releaseSync();
    return Promise.resolve();
  }

  // Drop the assertion: closing stdin makes the helper hit EOF on ReadLine(),
  // run its explicit clear, and exit; kill() is belt-and-suspenders. Idempotent
  // and safe to call when never started or when the child is already dead (its
  // body is fully guarded so it can never interrupt close()).
  releaseSync() {
    const child = this._child;
    this._child = null;
    this._started = false;
    if (this._readyTimer) { this._safe(() => clearTimeout(this._readyTimer)); this._readyTimer = null; }
    if (this._exitHandler) this._safe(() => process.removeListener('exit', this._exitHandler));
    if (!child) return;
    // end() sends a graceful EOF so the helper's ReadLine() returns null and the
    // script runs its explicit ES_CONTINUOUS clear. Do NOT destroy() right after
    // -- that would abort the pipe before the EOF flushes. kill() is the backstop.
    this._safe(() => { if (child.stdin && !child.stdin.destroyed) child.stdin.end(); });
    this._safe(() => child.kill());
  }

  _safe(fn) {
    try { return fn(); } catch (_) { /* keepalive must never throw into the caller */ }
  }
}

module.exports = KeepaliveManager;
