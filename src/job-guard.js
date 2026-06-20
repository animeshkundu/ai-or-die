'use strict';

// Windows Job Object guard — deterministic process-tree teardown.
//
// The core mechanism for "no zombie node/bun processes": a Win32 Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. When the last handle to such a job closes
// (the holding process dies for ANY reason — Ctrl+C, crash, taskkill /F, console
// close), the kernel terminates EVERY process in the job atomically, with no user
// code running. This is the only Windows mechanism that survives an uncatchable kill.
//
// Two uses (see docs/specs/process-shutdown.md, ADR-00NN):
//   1. Supervisor-level job: bin/supervisor.js creates a kill-on-close job and assigns
//      ITSELF before forking the server. AssignProcessToJobObject is forward-looking, so
//      every future descendant (server, PTYs, the CLI's node/bun MCP grandchildren) joins
//      the job. Supervisor death closes the in-process handle → the whole tree dies. The
//      job persists across server restarts (only supervisor death closes the handle), so
//      the legitimate exit-75 memory restart is unaffected.
//   2. Per-PTY nested job: src/base-bridge.js puts each PTY in its own kill-on-close job;
//      closing that handle on stopSession atomically kills the PTY + its grandchildren —
//      deterministic per-session teardown that also satisfies "restart independently".
//
// Held IN-PROCESS via the koffi FFI (not an external helper, which would be a single
// point of failure, and not PowerShell, whose Add-Type→csc.exe is blocked by CLM/WDAC/
// AMSI on the hardened corporate boxes that are the primary audience). The job's
// BREAKAWAY_OK flag is deliberately left OFF so a child requesting CREATE_BREAKAWAY_FROM_JOB
// is kept in the job rather than escaping it.
//
// Windows-only by design; a no-op on macOS/Linux and whenever koffi is unavailable
// (e.g. under Bun, or a locked-down box). Never throws into the caller — the guard must
// never break startup; failure degrades to best-effort taskkill (jobGuard:false).

const IS_WIN = process.platform === 'win32';

// JOBOBJECTINFOCLASS
const JobObjectExtendedLimitInformation = 9;
// JOBOBJECT_BASIC_LIMIT_INFORMATION.LimitFlags
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
// OpenProcess access rights needed to assign a foreign pid to a job
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

let _koffi = null;
let _api = null;
let _loadError = null;

// Lazily bind kernel32 via koffi. Returns the bound API or null (cached).
function _ensureApi() {
  if (_api || _loadError) return _api;
  if (!IS_WIN) { _loadError = new Error('not win32'); return null; }
  try {
    _koffi = require('koffi');

    const JOBOBJECT_BASIC_LIMIT_INFORMATION = _koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
      PerProcessUserTimeLimit: 'int64',
      PerJobUserTimeLimit: 'int64',
      LimitFlags: 'uint32',
      MinimumWorkingSetSize: 'size_t',
      MaximumWorkingSetSize: 'size_t',
      ActiveProcessLimit: 'uint32',
      Affinity: 'size_t',
      PriorityClass: 'uint32',
      SchedulingClass: 'uint32',
    });
    const IO_COUNTERS = _koffi.struct('IO_COUNTERS', {
      ReadOperationCount: 'uint64',
      WriteOperationCount: 'uint64',
      OtherOperationCount: 'uint64',
      ReadTransferCount: 'uint64',
      WriteTransferCount: 'uint64',
      OtherTransferCount: 'uint64',
    });
    const JOBOBJECT_EXTENDED_LIMIT_INFORMATION = _koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
      BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
      IoInfo: IO_COUNTERS,
      ProcessMemoryLimit: 'size_t',
      JobMemoryLimit: 'size_t',
      PeakProcessMemoryUsed: 'size_t',
      PeakJobMemoryUsed: 'size_t',
    });

    const k = _koffi.load('kernel32.dll');
    _api = {
      sizeofExtLimit: _koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION),
      CreateJobObjectW: k.func('void* __stdcall CreateJobObjectW(void* lpJobAttributes, void* lpName)'),
      // The struct is registered in koffi's type registry under its name, so the C
      // prototype can reference it by that name (passed by pointer → marshaled from a JS object).
      SetInformationJobObject: k.func('int __stdcall SetInformationJobObject(void* hJob, int JobObjectInformationClass, ' +
        'JOBOBJECT_EXTENDED_LIMIT_INFORMATION* lpJobObjectInformation, uint32 cbJobObjectInformationLength)'),
      AssignProcessToJobObject: k.func('int __stdcall AssignProcessToJobObject(void* hJob, void* hProcess)'),
      OpenProcess: k.func('void* __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)'),
      GetCurrentProcess: k.func('void* __stdcall GetCurrentProcess()'),
      CloseHandle: k.func('int __stdcall CloseHandle(void* hObject)'),
      GetLastError: k.func('uint32 __stdcall GetLastError()'),
    };
  } catch (err) {
    _loadError = err;
    _api = null;
  }
  return _api;
}

// True only when the koffi-backed Win32 binding is usable on this platform.
function isAvailable() {
  return !!_ensureApi();
}

// Explicit NULL-handle predicate. koffi 3.x returns JS `null` for a NULL pointer and a
// BigInt for a valid HANDLE (verified on koffi 3.0.2), so a bare `!h` already works; this
// guards the common shapes explicitly so a future koffi representation of NULL (0 / 0n /
// undefined) can't slip an invalid handle into a WinAPI call.
function _isNullHandle(h) {
  return h === null || h === undefined || h === 0 || h === 0n;
}

// Create a job object with KILL_ON_JOB_CLOSE set (BREAKAWAY_OK deliberately OFF).
// Returns the job handle (opaque, pass back to assign*/closeJob) or null on any failure.
function createKillOnCloseJob() {
  const api = _ensureApi();
  if (!api) return null;
  let job = null;
  try {
    job = api.CreateJobObjectW(null, null);
    if (_isNullHandle(job)) return null;
    const info = {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0n,
        PerJobUserTimeLimit: 0n,
        LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        MinimumWorkingSetSize: 0,
        MaximumWorkingSetSize: 0,
        ActiveProcessLimit: 0,
        Affinity: 0,
        PriorityClass: 0,
        SchedulingClass: 0,
      },
      IoInfo: {
        ReadOperationCount: 0n, WriteOperationCount: 0n, OtherOperationCount: 0n,
        ReadTransferCount: 0n, WriteTransferCount: 0n, OtherTransferCount: 0n,
      },
      ProcessMemoryLimit: 0,
      JobMemoryLimit: 0,
      PeakProcessMemoryUsed: 0,
      PeakJobMemoryUsed: 0,
    };
    const ok = api.SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, api.sizeofExtLimit);
    if (!ok) {
      // Could not arm kill-on-close — a job without it is useless (worse: it would
      // hold processes without ever reaping them). Close and fail closed to null.
      try { api.CloseHandle(job); } catch (_) { /* ignore */ }
      return null;
    }
    return job;
  } catch (_) {
    if (job) { try { api.CloseHandle(job); } catch (__) { /* ignore */ } }
    return null;
  }
}

// Assign the CURRENT process to the job (used by the supervisor before forking).
// Returns true on success. After this, all future descendants auto-join the job.
function assignSelf(job) {
  const api = _ensureApi();
  if (!api || _isNullHandle(job)) return false;
  try {
    const self = api.GetCurrentProcess(); // pseudo-handle (-1); valid for AssignProcessToJobObject
    return !!api.AssignProcessToJobObject(job, self);
  } catch (_) {
    return false;
  }
}

// Assign a foreign process (by pid) to the job (used per-PTY). Opens a scoped handle
// with exactly the rights needed, assigns, then closes that process handle (NOT the job).
// Returns true on success.
//
// PID-reuse safety: callers must pass the pid of a process they KNOW is currently alive
// and call this synchronously after spawning it (base-bridge._attachPtyJob runs in the same
// synchronous tick as node-pty's spawn() that produced the pid), so there is no async window
// in which the pid could be recycled before OpenProcess. Do NOT call this with a pid that
// may have already exited.
function assignPid(job, pid) {
  const api = _ensureApi();
  if (!api || _isNullHandle(job) || !pid) return false;
  let h = null;
  try {
    h = api.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid >>> 0);
    if (_isNullHandle(h)) return false;
    return !!api.AssignProcessToJobObject(job, h);
  } catch (_) {
    return false;
  } finally {
    if (!_isNullHandle(h)) { try { api.CloseHandle(h); } catch (_) { /* ignore */ } }
  }
}

// Close a job handle. For a per-PTY kill-on-close job this is the teardown trigger:
// it terminates every process still in the job. Idempotent-safe to call with null.
// NEVER call this on the supervisor-level job (its close = kill the whole tree); the
// supervisor holds it for life and lets process death close it.
function closeJob(job) {
  const api = _ensureApi();
  if (!api || _isNullHandle(job)) return false;
  try {
    return !!api.CloseHandle(job);
  } catch (_) {
    return false;
  }
}

module.exports = {
  isAvailable,
  createKillOnCloseJob,
  assignSelf,
  assignPid,
  closeJob,
  // exposed for diagnostics/tests
  _loadError: () => _loadError,
};

// --- self-test: `node src/job-guard.js` ------------------------------------------
// Proves the koffi bindings + struct marshaling work end to end on this host:
// create a kill-on-close job, assign a spawned child, close the job, assert the child dies.
if (require.main === module) {
  if (!IS_WIN) { console.log('job-guard self-test: non-win32, no-op OK'); process.exit(0); }
  const { spawn } = require('child_process');
  console.log('koffi available:', isAvailable(), 'loadError:', _loadError && _loadError.message);
  const job = createKillOnCloseJob();
  console.log('createKillOnCloseJob ->', job ? 'OK' : 'FAIL');
  if (!job) process.exit(1);
  // Long-lived child that does nothing but stay alive.
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { stdio: 'ignore' });
  console.log('spawned child pid', child.pid);
  setTimeout(() => {
    const assigned = assignPid(job, child.pid);
    console.log('assignPid ->', assigned ? 'OK' : 'FAIL');
    closeJob(job);
    console.log('closeJob called; waiting to see if child dies...');
    let exited = false;
    child.on('exit', (code, sig) => { exited = true; console.log(`child exited code=${code} sig=${sig} -> KILL-ON-CLOSE OK`); process.exit(0); });
    setTimeout(() => { if (!exited) { console.log('child STILL ALIVE -> FAIL'); try { child.kill(); } catch (_) {} process.exit(2); } }, 2000);
  }, 300);
}
