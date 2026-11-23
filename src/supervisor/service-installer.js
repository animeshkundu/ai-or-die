'use strict';

// ServiceInstaller — install/remove/status the user-level ai-or-die service.
//
// Platform mapping (user-level only — never requires admin):
//   linux  -> systemd --user unit  (~/.config/systemd/user/ai-or-die.service)
//   darwin -> launchd agent        (~/Library/LaunchAgents/com.ai-or-die.plist)
//   win32  -> Task Scheduler task  (logon + unlock triggers)
//
// STABLE-PATH GUARANTEE (the npx/bunx requirement): the service NEVER points
// at the invoking package location (npm npx cache, bun install cache, /tmp).
// On `service install`, the supervisor entry point AND its entire dependency
// closure are staged under the stable base (~/.ai-or-die/):
//   bin/ai-or-die-supervisor.js  (copy of the package's bin/supervisor-service.js)
//   src/supervisor/*.js          (PtyManager, ServerManager, AutoUpdater, …)
//   src/keepalive-manager.js, src/hibernation-guard.js, src/job-guard.js
//   src/utils/process-tree.js
// Every generated unit references ONLY the staged supervisor path. Updates
// replace ~/.ai-or-die/bin/ai-or-die-server in place, so the service
// definition is written once and never changes afterwards.
//
// Why a staged tree instead of a single-file copy: the supervisor entry does
// `require('../src/supervisor/index')`, which resolves relative to its own
// location. Copying the entry alone orphans that require (MODULE_NOT_FOUND on
// every Task start). The staged tree preserves the repo-relative layout, needs
// no build step, and has no native dependencies (koffi is optional and
// degrades gracefully via src/job-guard.js).
//
// Win32 notes (primary target):
// - Task XML is written UTF-16LE *with BOM* to match its `encoding="UTF-16"`
//   prolog — schtasks rejects mismatched encodings.
// - The Task runs `node <stable-supervisor> [serverArgs]` directly (absolute,
//   quoted paths). There is deliberately NO `cmd /c` wrapper: `schtasks /end`
//   terminates only the direct child, and an intermediate `cmd` would orphan
//   `node` holding the port while `IgnoreNew` wedges the next start.
// - Task XML cannot carry environment variables, so `AIORDIE_SERVICE=1` is
//   delivered via the service sentinel: see isServiceRuntime() — the staged
//   supervisor + service.json on disk imply service mode even when the Task
//   provides no env block.
// - Secrets (`--auth <token>`) are NEVER persisted: Task XML and process
//   command lines are world-readable.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { STABLE_BASE, supervisorVersion } = require('./constants');
const { assertStagedClosure } = require('./staged-closure');

const SERVICE_NAME = process.env.AIORDIE_SERVICE_NAME || 'ai-or-die';
const LAUNCHD_LABEL = 'com.ai-or-die';

// Files staged from the package into the stable base, as [packageRel, baseRel]
// pairs. Covers the full supervisor require closure (all built-ins except the
// optional koffi native, which degrades gracefully when absent).
const STAGED_FILES = [
  ['bin/supervisor-service.js', path.join('bin', 'ai-or-die-supervisor.js')],
  ['src/supervisor/index.js', path.join('src', 'supervisor', 'index.js')],
  ['src/supervisor/heartbeat.js', path.join('src', 'supervisor', 'heartbeat.js')],
  ['src/supervisor/staged-closure.js', path.join('src', 'supervisor', 'staged-closure.js')],
  ['src/supervisor/server-provisioner.js', path.join('src', 'supervisor', 'server-provisioner.js')],
  ['src/supervisor/service-watchdog.js', path.join('src', 'supervisor', 'service-watchdog.js')],
  ['src/supervisor/service-logging.js', path.join('src', 'supervisor', 'service-logging.js')],
  ['src/supervisor/pty-manager.js', path.join('src', 'supervisor', 'pty-manager.js')],
  ['src/supervisor/server-manager.js', path.join('src', 'supervisor', 'server-manager.js')],
  ['src/supervisor/autoupdater.js', path.join('src', 'supervisor', 'autoupdater.js')],
  ['src/supervisor/service-installer.js', path.join('src', 'supervisor', 'service-installer.js')],
  ['src/supervisor/service-cli.js', path.join('src', 'supervisor', 'service-cli.js')],
  ['src/supervisor/wake-handler.js', path.join('src', 'supervisor', 'wake-handler.js')],
  ['src/supervisor/fleet-client.js', path.join('src', 'supervisor', 'fleet-client.js')],
  ['src/supervisor/ipc-protocol.js', path.join('src', 'supervisor', 'ipc-protocol.js')],
  ['src/supervisor/constants.js', path.join('src', 'supervisor', 'constants.js')],
  ['src/supervisor/remote-bridge.js', path.join('src', 'supervisor', 'remote-bridge.js')],
  // NOTE: update-routes.js is intentionally NOT staged — it requires express
  // (server-side, via src/server.js) which does not exist in the stable tree.
  // The supervisor closure below is built-ins-only (+ optional koffi).
  ['src/keepalive-manager.js', path.join('src', 'keepalive-manager.js')],
  ['src/hibernation-guard.js', path.join('src', 'hibernation-guard.js')],
  ['src/job-guard.js', path.join('src', 'job-guard.js')],
  ['src/utils/process-tree.js', path.join('src', 'utils', 'process-tree.js')],
  // utils/sidecar-installer.js is required lazily by server-provisioner (for
  // stripProvenance). It is pure built-ins apart from an optional lazy
  // require('../../scripts/mesh-lock') used by mesh tooling; that one is
  // allowlisted below rather than staged (scripts/ is not part of the closure).
  ['src/utils/sidecar-installer.js', path.join('src', 'utils', 'sidecar-installer.js')],
];

function isUnderTempRoot(s) {
  const roots = [os.tmpdir(), '/tmp', '/private/tmp'];
  if (process.platform === 'win32') {
    if (process.env.TEMP) roots.push(process.env.TEMP);
    if (process.env.TMP) roots.push(process.env.TMP);
  }
  const low = String(s).toLowerCase();
  return roots.some((r) => {
    if (!r) return false;
    const base = String(r).replace(/[\\/]+$/, '').toLowerCase();
    return low === base || low.startsWith(base + '/') || low.startsWith(base + '\\');
  });
}

// True when a package path is ephemeral (npx/bunx cache) rather than a
// stable install location. Matches ONLY precise runner markers — never a
// bare temp dir: the test sandbox itself (and a user checkout under /tmp)
// lives under os.tmpdir(), and misclassifying it would copy the supervisor
// on every install. Runners always execute from inside a node_modules
// tree, so temp-root + node_modules is the fallback signal.
function isTempPackagePath(p) {
  if (!p) return true;
  const s = String(p);
  if (/\.npm[\\/]_npx/i.test(s)) return true;      // npm npx cache (default or --cache)
  if (/[\\/]_npx[\\/]/i.test(s)) return true;      // any _npx dir
  if (/\.bun[\\/]install[\\/]cache/i.test(s)) return true; // bunx cache
  if (/node_modules[\\/]\.cache/i.test(s)) return true;    // generic build cache
  if (/node_modules[\\/]/i.test(s) && isUnderTempRoot(s)) return true;
  return false;
}

/**
 * True when this process runs as the installed user-level service.
 *
 * Primary signal: AIORDIE_SERVICE=1 (set by the systemd/launchd units).
 * Fallback for Task Scheduler (whose Exec schema has no env block): the
 * process image IS the staged stable supervisor AND service.json exists.
 * Never throws.
 */
function isServiceRuntime(options = {}) {
  try {
    // Explicit opt-out always wins (lets a dev run the staged binary
    // interactively without acquiring service behavior).
    if (process.env.AIORDIE_SERVICE === '0') return false;
    if (process.env.AIORDIE_SERVICE === '1') return true;
    const argv1 = options.argv1 || process.argv[1];
    const baseDir = options.baseDir || STABLE_BASE;
    const stable = options.stableSupervisor || path.join(baseDir, 'bin', 'ai-or-die-supervisor.js');
    const metaFile = options.metaFile || path.join(baseDir, 'service.json');
    if (!argv1) return false;
    let a = path.resolve(argv1);
    let b = path.resolve(stable);
    try {
      // realpath resolves junctions/symlinks (nvm, OneDrive); case-insensitive
      // compare on win32 (8.3 short names, mixed-case profile paths).
      a = fs.realpathSync(a);
      b = fs.realpathSync(b);
    } catch (_) { /* fall back to lexical paths */ }
    if (process.platform === 'win32') {
      if (a.toLowerCase() !== b.toLowerCase()) return false;
    } else if (a !== b) {
      return false;
    }
    return fs.existsSync(metaFile);
  } catch (_) {
    return false;
  }
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Quote one argv element for the Windows CommandLine / systemd ExecStart.
// Wraps in double quotes when it contains whitespace/quotes, escaping inner
// double quotes and doubling trailing backslashes per CommandLineToArgvW
// (a trailing `\"` would otherwise escape the closing quote and merge args).
function quoteArg(s) {
  const str = String(s);
  if (!/[\s"]/.test(str)) return str;
  const escaped = str.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Identity string for the Task Scheduler <UserId> element (boot/S4U mode).
 * A bare `<UserId>name</UserId>` is ambiguous when the account name exists on
 * more than one domain — prefer the SID, falling back to DOMAIN\\user, then to
 * the plain user name. Never throws (returns null when nothing resolves, in
 * which case the S4U principal is not emitted and install fails loudly rather
 * than registering a task that can never run).
 */
let _cachedUserId = null;
function currentUserIdentity(options = {}) {
  if (_cachedUserId) return _cachedUserId;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  if (process.platform === 'win32') {
    try {
      const r = spawnSyncImpl('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
      const out = String((r && r.stdout) || '');
      const m = /"(S-1-[0-9-]+)"/.exec(out);
      if (m) { _cachedUserId = m[1]; return _cachedUserId; }
    } catch (_) { /* fall through */ }
    try {
      const dom = process.env.USERDOMAIN;
      const user = process.env.USERNAME;
      if (user) {
        _cachedUserId = dom ? `${dom}\\${user}` : user;
        return _cachedUserId;
      }
    } catch (_) { /* fall through */ }
  }
  try {
    _cachedUserId = os.userInfo().username || null;
  } catch (_) {
    _cachedUserId = null;
  }
  return _cachedUserId;
}

/**
 * Strip secret-bearing flags from persisted serverArgs. Secrets must never
 * land in Task XML / unit files / service.json (all world-readable, and the
 * command line is visible via tasklist/wmic). Returns { args, dropped }.
 */
function stripSecrets(args) {
  const out = [];
  let dropped = false;
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    if (a === '--auth' || a === '--token') {
      if (i + 1 < list.length && !String(list[i + 1]).startsWith('-')) i += 1;
      dropped = true;
      continue;
    }
    if (a.startsWith('--auth=') || a.startsWith('--token=')) {
      dropped = true;
      continue;
    }
    out.push(list[i]);
  }
  return { args: out, dropped };
}

function validateServerArgs(args) {
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length - 1; i += 1) {
    if (list[i] === '--port' || list[i] === '-p') {
      const n = parseInt(list[i + 1], 10);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        throw new Error(`invalid --port value for service install: ${list[i + 1]} (want 1-65535)`);
      }
    }
  }
  for (const a of list) {
    if (typeof a === 'string' && a.includes('\0')) {
      throw new Error('invalid NUL byte in service serverArgs');
    }
  }
  return list;
}

function nodeMajorVersion(ver = process.version) {
  const m = /^v?(\d+)/.exec(String(ver));
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Resolve the Node interpreter to bake into the service unit.
 * Order: current process.execPath (must exist; rejects Bun) → `where node`
 * (win32, skipping Store shims + bun) → %ProgramFiles%\\nodejs\\node.exe.
 * Throws with an actionable message when no Node ≥22 resolves.
 */
function resolveNodeRuntime(options = {}) {
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const isBun = !!(process.versions && process.versions.bun);
  if (!isBun && process.execPath && fs.existsSync(process.execPath)) {
    if (nodeMajorVersion() < 22) {
      throw new Error(
        `service install requires Node.js 22+ (running ${process.version}); upgrade Node and retry`
      );
    }
    return { nodePath: process.execPath, source: 'execPath' };
  }
  if (process.platform === 'win32') {
    try {
      const r = spawnSyncImpl('where', ['node'], { encoding: 'utf8' });
      const out = r && (r.stdout || '');
      const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const low = line.toLowerCase();
        if (low.includes('windowsapps')) continue; // Store execution alias stub
        if (low.endsWith('bun.exe')) continue;
        if (fs.existsSync(line)) return { nodePath: line, source: 'PATH' };
      }
    } catch (_) { /* fall through */ }
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const candidate = path.join(pf, 'nodejs', 'node.exe');
    if (fs.existsSync(candidate)) return { nodePath: candidate, source: 'ProgramFiles' };
  }
  if (isBun) {
    throw new Error('service install is not supported under Bun (koffi panics, node-pty hangs); reinstall with Node.js 22+');
  }
  throw new Error('service install could not find a Node.js 22+ interpreter (checked process.execPath and PATH)');
}

function writeFileAtomic(file, data, encoding) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, encoding);
  fs.renameSync(tmp, file);
}

class ServiceInstaller {
  constructor(options = {}) {
    this._platform = options.platform || process.platform;
    this._homedir = options.homedir || os.homedir();
    // Quiet exec for QUERY calls: schtasks/systemctl/launchctl write their
    // "not installed" explanation to stderr, and execFileSync inherits that into
    // the terminal. `ai-or-die service status` on a clean machine printed a raw
    // "ERROR: The system cannot find the file specified." above the JSON. Pipes
    // keep the diagnostic available on err.stderr for callers that want it.
    const defaultExec = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'pipe', ...opts });
    this._execFileSync = options.execFileSync || defaultExec;
    this._spawnSync = options.spawnSync || spawnSync;
    this._logger = options.logger || console;
    // Test seam: redirect the stable base (unit files still come from
    // _homedir on linux/darwin, which tests point at a temp dir).
    this._baseDir = options.baseDir || STABLE_BASE;
    this._stableSupervisor = options.stableSupervisor
      || path.join(this._baseDir, 'bin', 'ai-or-die-supervisor.js');
    this._metaFile = options.metaFile || path.join(this._baseDir, 'service.json');
    this._nodePath = options.nodePath || null;
    this._packageRoot = options.packageRoot || path.resolve(__dirname, '..', '..');
    // Server provisioning seam (see server-provisioner.js). `provisionServer`
    // defaults to the real downloader; tests inject a stub so no network or
    // 166 MB payload is involved.
    this._provisionServer = options.provisionServer || null;
    this._verifyClosure = options.verifyClosure !== false;
    this._serverBinaryPath = options.serverBinaryPath || null;
    this._offline = !!options.offline;
    this._releaseVersion = options.releaseVersion || null;
    // There is deliberately NO verification flag here. install() registers and
    // starts the unit; proving the daemon actually came up needs a heartbeat
    // poll plus operator-facing output, which lives in service-cli.js
    // (verifyInstalled) so every entry point — bin/supervisor.js,
    // bin/ai-or-die.js, bin/supervisor-service.js — performs it identically.
    // A second, differently-behaved copy in here is how the original
    // "install printed success while the task could not boot" bug survived.
  }

  stableSupervisorPath() {
    return this._stableSupervisor;
  }

  stableBinDir() {
    return path.dirname(this._stableSupervisor);
  }

  taskXmlPath() {
    return path.join(this._baseDir, 'ai-or-die-task.xml');
  }

  logFilePath() {
    return path.join(this._baseDir, 'logs', 'supervisor.log');
  }

  heartbeatFilePath() {
    return path.join(this._baseDir, 'run', 'heartbeat.json');
  }

  nodePath() {
    if (this._nodePath) return this._nodePath;
    return resolveNodeRuntime({ spawnSync: this._spawnSync }).nodePath;
  }

  /**
   * Stage the supervisor entry + its dependency closure into the stable base.
   * Idempotent (re-stage overwrites). Returns { path, copied }.
   *
   * Always copies — including for global installs — because an npm-global
   * path is pruned on upgrade (F7). The only no-op is source === stable.
   */
  ensureStableBinary(sourceScript = process.argv[1]) {
    const stable = this._stableSupervisor;
    const resolvedSource = sourceScript ? path.resolve(sourceScript) : null;
    if (resolvedSource && path.resolve(stable) === resolvedSource) {
      return { path: stable, copied: false };
    }
    if (!resolvedSource || !fs.existsSync(resolvedSource)) {
      throw new Error(
        `service install requires the supervisor entry file (missing: ${sourceScript || 'unknown'}); ` +
        'reinstall the ai-or-die package and retry'
      );
    }
    // The package root is two levels above bin/supervisor-service.js in every
    // layout (repo checkout, npm -g, npx cache) — derive it from the source so
    // an npx-cache install stages from the cache before it is GC'd. Fall back
    // to this installer's own package root (test seam + stale-path safety).
    let packageRoot = path.resolve(path.dirname(resolvedSource), '..');
    let stagedFrom = 'source';
    if (!fs.existsSync(path.join(packageRoot, 'src', 'supervisor', 'index.js'))) {
      packageRoot = this._packageRoot;
      stagedFrom = 'installer-root';
      try {
        this._logger.warn(
          `service install: source tree incomplete at ${path.resolve(path.dirname(resolvedSource), '..')}; ` +
          `staging from installer root instead`
        );
      } catch (_) {}
    }
    const marker = path.join(packageRoot, 'src', 'supervisor', 'index.js');
    if (!fs.existsSync(marker)) {
      throw new Error(
        `service install could not find the supervisor sources under ${packageRoot}; ` +
        'reinstall the ai-or-die package and retry'
      );
    }
    fs.mkdirSync(this.stableBinDir(), { recursive: true });
    let staged = 0;
    for (const [pkgRel, baseRel] of STAGED_FILES) {
      const src = path.join(packageRoot, pkgRel);
      const dest = path.join(this._baseDir, baseRel);
      if (!fs.existsSync(src)) {
        // Every staged file is load-bearing (the stage has no node_modules to
        // fall back to). Failing here beats MODULE_NOT_FOUND at next logon.
        throw new Error(
          `service install: package file missing: ${pkgRel} (under ${packageRoot}); ` +
          'reinstall the ai-or-die package and retry'
        );
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      staged += 1;
    }
    try { fs.chmodSync(stable, 0o755); } catch (_) { /* windows */ }
    // The staged tree has no package.json by design (STAGED_FILES is explicit),
    // and src/supervisor/constants.js resolves its version with
    // require('../../package.json') — which, from the staged location, is
    // <base>/package.json. Without it every service run reports
    // '0.0.0-staged', and AutoUpdater then believes EVERY published release is
    // newer and re-downloads the same binary once an hour, forever. A minimal
    // manifest (name + version only) keeps version reporting and update
    // comparison truthful and stays inert for module resolution.
    try {
      writeFileAtomic(
        path.join(this._baseDir, 'package.json'),
        JSON.stringify({ name: 'ai-or-die', version: supervisorVersion(), private: true }, null, 2),
        'utf8'
      );
    } catch (err) {
      // Not fatal (the version falls back to a sentinel), but silent means the
      // hourly "every release is newer" re-download loop comes back with no
      // clue why.
      try {
        this._logger.warn(
          `service install: could not write ${path.join(this._baseDir, 'package.json')} ` +
          `(${(err && err.message) || err}); the service will report a placeholder version`
        );
      } catch (_) { /* ignore */ }
    }
    // Refuse to hand the OS a unit that boots into MODULE_NOT_FOUND. Runs
    // BEFORE any unit file is written, so a broken stage never leaves a
    // registered task behind.
    let audit = null;
    if (this._verifyClosure !== false) {
      try {
        audit = assertStagedClosure(stable, {
          rootDir: this._baseDir,
          // Bare/optional modules the staged tree may legitimately omit:
          //   koffi                  optional native (job-guard degrades)
          //   @vscode/ripgrep        resolved via the SEA asset extractor
          //   node:sea               built-in, only present in a SEA image
          // The sidecar installer's mesh tooling require is dev-only and not
          // part of the supervisor closure.
          allowedBare: new Set(['koffi', '@vscode/ripgrep', 'node:sea']),
          // `scripts/mesh-lock` is a build-time helper, unreachable at runtime
          // (DEFAULT_ALLOW_MISSING covers it); nothing extra here.
        });
      } catch (err) {
        try {
          this._logger.error(err.message);
        } catch (_) { /* ignore */ }
        throw err;
      }
    }
    // Merge (never clobber): install() compares meta.serverArgs/nodePath for
    // idempotent reinstalls, and a bare _writeMeta here would wipe them.
    this._writeMeta({
      ...this._readMeta(),
      supervisorPath: stable,
      stable: true,
      bundleVersion: supervisorVersion(),
      stagedFrom,
      stagedFiles: STAGED_FILES.length,
      stagedChecked: audit ? audit.checked : null,
    });
    return { path: stable, copied: true };
  }

  buildUnit(supervisorPath, opts = {}) {
    if (this._platform === 'linux') return this._systemdUnit(supervisorPath, opts);
    if (this._platform === 'darwin') return this._launchdPlist(supervisorPath, opts);
    if (this._platform === 'win32') return this._taskSchedulerXml(supervisorPath, opts);
    throw new Error(`unsupported platform: ${this._platform}`);
  }

  unitPath() {
    if (this._platform === 'linux') {
      return path.join(this._homedir, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
    }
    if (this._platform === 'darwin') {
      return path.join(this._homedir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    }
    return null; // win32 uses schtasks, no file
  }

  /**
   * Ensure the runnable Server binary exists at the stable path.
   *
   * The unit files reference STABLE_SERVER_BIN for life, and only AutoUpdater
   * ever wrote that file — so a fresh install produced a task that booted a
   * supervisor which instantly died with MODULE_NOT_FOUND. Provisioning is a
   * separate step BEFORE any unit is written, so a failed download cannot leave
   * a registered task pointing at nothing.
   */
  async provisionServer(options = {}) {
    const provision = this._provisionServer
      || require('./server-provisioner').provisionServerBinary;
    const ctx = {
      dest: options.dest || path.join(this.stableBinDir(),
        this._platform === 'win32' ? 'ai-or-die-server.exe' : 'ai-or-die-server'),
      stagingDir: path.join(this._baseDir, 'staging'),
      logger: this._logger,
      platform: options.platform || this._platform,
      arch: options.arch || process.arch,
      offline: options.offline !== undefined ? options.offline : this._offline,
      force: options.force === true,
      serverBinaryPath: options.serverBinaryPath !== undefined
        ? options.serverBinaryPath
        : this._serverBinaryPath,
      releaseVersion: options.releaseVersion !== undefined
        ? options.releaseVersion
        : this._releaseVersion,
      execFileSync: this._execFileSync,
      // Never re-verify with execFileSync in unit tests: the fake returns a
      // Buffer and the probe would report a bogus version.
      verify: options.verify,
      // Explicit opt-in: a release that publishes no sha256 leaves the
      // download unauthenticated, which the provisioner refuses by default.
      allowUndigested: process.env.AIORDIE_ALLOW_UNDIGESTED_SERVER === '1',
    };
    const result = await provision(ctx);
    this._writeMeta({
      ...this._readMeta(),
      serverBinary: result.path,
      serverVersion: result.version || null,
      serverSha256: result.sha256 || null,
      serverVerified: result.verified || null,
      serverReleaseTag: result.releaseTag || null,
      serverProvisionedAt: new Date().toISOString(),
    });
    return result;
  }

  /**
   * Install the user-level service.
   *
   * Async because the Server binary is provisioned (downloaded + digest
   * verified) before the unit is written. A test/image seam may pass a
   * synchronous installer by using installSync().
   */
  async install(sourceScript, opts = {}) {
    // Snapshot the installed record BEFORE staging: ensureStableBinary() stamps
    // the CURRENT bundleVersion into meta, so _unitUnchanged() would otherwise
    // compare a value against itself and never notice a supervisor upgrade.
    const metaAtEntry = this._readMeta();
    const { args: serverArgs } = stripSecrets(opts.serverArgs || []);
    validateServerArgs(serverArgs);
    const mode = opts.mode === 'boot' ? 'boot' : 'login';
    const nodePath = opts.nodePath || this._nodePath || resolveNodeRuntime({ spawnSync: this._spawnSync }).nodePath;
    // Boot preflight FIRST: an S4U principal with no <UserId> cannot be
    // expressed validly, and Windows would reject or silently register an
    // unusable task. Resolve the identity (and name the S4U limit) before
    // staging files or downloading a 166 MB server binary that this host can
    // never use.
    let userId = null;
    if (mode === 'boot') {
      if (this._platform !== 'win32') {
        throw Object.assign(
          new Error('service install: --boot is only supported on Windows; use --login here'),
          { code: 'EBOOTUNSUPPORTED' }
        );
      }
      userId = currentUserIdentity({ spawnSync: this._spawnSync });
      if (!userId) {
        throw Object.assign(
          new Error(
            'service install: could not resolve this account for a boot (S4U) task.\n' +
            '  The task needs an explicit user identity; run `whoami /user` to check your account,\n' +
            '  or install with --login (starts at logon instead of at boot).'
          ),
          { code: 'EBOOTIDENTITY' }
        );
      }
    }
    const { path: supervisorPath } = this.ensureStableBinary(sourceScript);
    // Provision BEFORE the unit exists: a failed download must never leave a
    // registered task that points at a missing binary.
    const server = await this.provisionServer({
      offline: opts.offline,
      serverBinaryPath: opts.serverBinaryPath,
      releaseVersion: opts.releaseVersion,
      // `--force` re-downloads even when a runnable binary already exists.
      force: opts.force,
      verify: opts.verifyBinary,
    });
    const unit = this.buildUnit(supervisorPath, { serverArgs, nodePath, mode, userId });
    const results = {
      supervisorPath,
      platform: this._platform,
      // Carried only for the idempotency comparison below, never persisted.
      prevBundleVersion: metaAtEntry.bundleVersion || null,
      nodePath,
      serverArgs,
      mode,
      serverBinary: server.path,
      serverVersion: server.version || null,
      serverReleaseTag: server.releaseTag || null,
      serverVerified: server.verified || null,
    };
    // Persist the sentinel BEFORE starting anything: the daemon reads
    // service.json at boot to decide it is running as a service
    // (isServiceRuntime) and to learn its install mode. Writing it after
    // `schtasks /run` races the first start, so a boot-mode install could come
    // up once with login-mode defaults (hibernation guard ON, no desktop to
    // prompt on) and log a failure on the very first run.
    // Only the fields the daemon needs to read back at start-up go in early.
    // The full record is written after the unit is registered: writing the new
    // serverArgs/nodePath first would make _unitUnchanged() compare the fresh
    // meta against itself and misreport a changed install as a no-op.
    const written = [];
    try {
      // Inside the try on purpose: an interrupt (Ctrl-C, crash, OOM kill)
      // between this write and the unit registration would otherwise persist
      // the NEW mode with no unit change and no rollback — status() then
      // reports boot mode for a login install, and the still-installed task's
      // daemon applies boot-mode defaults (hibernation guard off). The catch
      // below restores metaAtEntry over it.
      const metaBefore = this._readMeta();
      this._writeMeta({ ...metaBefore, platform: this._platform, mode, userId });
      if (this._platform === 'linux') {
        const file = this.unitPath();
        if (this._unitUnchanged(file, unit, results)) {
          results.unchanged = true;
          results.unitFile = file;
          // Idempotent: `enable --now` on an already-enabled, already-running
          // unit is a no-op. Without it an unchanged reinstall over a stopped
          // or failed unit reports success while nothing runs.
          results.restarted = this._ensureUnitRunning();
        } else {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          writeFileAtomic(file, unit, 'utf8');
          written.push(file);
          this._execFileSync('systemctl', ['--user', 'daemon-reload']);
          this._execFileSync('systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
          results.unitFile = file;
          this._enableLinger();
        }
      } else if (this._platform === 'darwin') {
        const file = this.unitPath();
        if (this._unitUnchanged(file, unit, results)) {
          results.unchanged = true;
          results.unitFile = file;
          // `load` on an already-loaded agent fails with "service already
          // loaded", so only load when it is not: same no-op reinstall problem
          // as on linux — a correct plist proves nothing about a running job.
          results.restarted = this._ensureAgentRunning(file);
        } else {
          // Unload-first: a second `load` of an already-loaded plist fails
          // ("Already loaded") and the overwritten file would not take effect
          // until unload+load anyway.
          try { this._execFileSync('launchctl', ['unload', file]); } catch (_) { /* not loaded */ }
          fs.mkdirSync(path.dirname(file), { recursive: true });
          writeFileAtomic(file, unit, 'utf8');
          written.push(file);
          this._execFileSync('launchctl', ['load', file]);
          results.unitFile = file;
        }
      } else if (this._platform === 'win32') {
        const xmlFile = this.taskXmlPath();
        if (this._unitUnchanged(xmlFile, unit, results)) {
          results.unchanged = true;
          results.taskXml = xmlFile;
          // A no-op reinstall must still leave a RUNNING daemon: the task
          // definition being correct says nothing about whether it is up.
          results.restarted = this._ensureTaskRunning();
          // The SeBatchLogonRight diagnostic below lives in the create branch,
          // but the right can be revoked long after the task was registered.
          // Say so here too instead of reporting a silent success.
          if (results.restarted !== 'running' && results.restarted !== 'started') {
            try {
              this._logger.warn(
                `service install: the task definition is unchanged but the daemon is ${results.restarted === 'unknown' ? 'not queryable' : 'not running'} and could not be started` +
                (mode === 'boot'
                  ? '; a boot (S4U) task needs "Log on as a batch job" (SeBatchLogonRight) — see secpol.msc > Local Policies > User Rights Assignment'
                  : '') +
                '; check `ai-or-die service status` and the supervisor log'
              );
            } catch (_) { /* ignore */ }
          }
        } else {
          // This branch is reached whenever a DIFFERENT unit file is already on
          // disk, i.e. the normal upgrade path over a working install. Record
          // whether a task is registered BEFORE touching anything: the /create
          // compensation below must not delete a still-good task.
          const hadTask = this._taskExists();
          if (hadTask) {
            // Stop the live daemon before replacing the definition: it keeps
            // holding the port (and its whole PTY tree) while /run boots a
            // second instance, which IgnoreNew then wedges. uninstall() and
            // the watchdog both /end first for exactly this reason.
            try { this._execFileSync('schtasks', ['/end', '/tn', SERVICE_NAME]); } catch (_) { /* not running */ }
            this._pollTaskStopped(5000);
          }
          fs.mkdirSync(path.dirname(xmlFile), { recursive: true });
          // Match the UTF-16 prolog: UTF-16LE *with BOM* (dedup: buildUnit
          // never emits one, but a second BOM would fail schtasks parsing and
          // defeat the idempotency comparison below).
          writeFileAtomic(xmlFile, '\ufeff' + unit.replace(/^\ufeff+/, ''), 'utf16le');
          written.push(xmlFile);
          try {
            this._execFileSync('schtasks', ['/create', '/tn', SERVICE_NAME, '/xml', xmlFile, '/f']);
          } catch (createErr) {
            if (hadTask) {
              // A working definition was already registered and /create with
              // /f validates before it replaces, so the old one is untouched.
              // Deleting it here would leave the operator with NO service at
              // all while the rollback restores a service.json claiming one
              // exists — say what actually happened instead.
              try {
                this._logger.warn(
                  'service install: the new task definition was rejected; the previously registered ' +
                  `definition is still in force but was stopped for the upgrade — restart it with ` +
                  `\`schtasks /run /tn ${SERVICE_NAME}\` or reinstall`
                );
              } catch (_) { /* ignore */ }
            } else {
              // Nothing was registered before, so /create may have partially
              // registered before failing: clean that up.
              try { this._execFileSync('schtasks', ['/delete', '/tn', SERVICE_NAME, '/f']); } catch (_) {}
            }
            throw createErr;
          }
          try {
            this._execFileSync('schtasks', ['/run', '/tn', SERVICE_NAME]);
          } catch (runErr) {
            // Best-effort start (IgnoreNew refuses when already running), but
            // never silent: a schema-valid yet runtime-broken task would
            // otherwise report success and be discovered only after reboot.
            const msg = String((runErr && (runErr.stderr || runErr.message)) || '');
            try {
              if (mode === 'boot' && /logon|batch|privilege|denied|0x800705/i.test(msg)) {
                // The most likely first-boot failure for a standard user: S4U
                // needs SeBatchLogonRight, which a per-user install cannot
                // grant. Say exactly what to do instead of failing opaquely.
                this._logger.error(
                  'service install: the boot task was registered but Windows refused to start it — ' +
                  'this account needs the "Log on as a batch job" right (SeBatchLogonRight) for an S4U logon.\n' +
                  '  Fix (admin once): secpol.msc > Local Policies > User Rights Assignment > Log on as a batch job > add this account\n' +
                  '  Or: ntrights -u %USERNAME% +r SeBatchLogonRight\n' +
                  '  Alternative: reinstall with --login (starts at logon instead of at boot).\n' +
                  `  Windows said: ${msg.trim()}`
                );
              } else {
                this._logger.warn(`service install: task created but immediate start failed (${msg.trim() || 'unknown error'}); it will start at the next trigger — verify with \`ai-or-die service status\``);
              }
            } catch (_) {}
          }
          results.taskXml = xmlFile;
        }
        // Outside the unchanged branch: the watchdog is idempotent, and an
        // install that predates it must pick it up on the next reinstall even
        // when the service definition itself did not change.
        results.hibernation = this._maybeHibernationGuard({ mode });
        if (this._shouldManageWatchdog()) {
          try {
            results.watchdog = this.ensureWatchdogTask({ nodePath, mode, userId });
          } catch (err) {
            results.watchdog = { installed: false, error: (err && err.message) || String(err) };
            try {
              this._logger.warn(
                `service install: watchdog task not registered (${results.watchdog.error}); ` +
                'the service still starts and restarts, but a wedged daemon will not self-heal'
              );
            } catch (_) { /* ignore */ }
          }
        }
      }
    } catch (err) {
      for (const f of written) {
        try { fs.rmSync(f, { force: true }); } catch (_) { /* ignore */ }
      }
      // Roll the sentinel back to the record captured BEFORE staging: it is
      // written early so the first start knows its mode, but if the unit never
      // registered, leaving the new mode in place would make an already
      // installed task's daemon behave as the mode that failed to install
      // (e.g. S4U's hibernation guard off). Restoring metaAtEntry also puts the
      // OLD bundleVersion back, so a retry of the failed upgrade is not
      // mistaken for an unchanged no-op against the old daemon.
      try {
        if (metaAtEntry && Object.keys(metaAtEntry).length) this._writeMeta(metaAtEntry);
        else fs.rmSync(this._metaFile, { force: true });
      } catch (_) { /* ignore */ }
      if (err && err.code === 'ENOENT' && /systemctl|launchctl|schtasks|loginctl/.test(err.message || '')) {
        throw new Error(`${err.message} — is the service manager available on this machine?`);
      }
      throw err;
    }
    results.installedAt = new Date().toISOString();
    results.bundleVersion = supervisorVersion();
    // prevBundleVersion is comparison scaffolding for _unitUnchanged(); it is
    // not a fact about the installed service and must not reach service.json.
    const persisting = { ...results };
    delete persisting.prevBundleVersion;
    this._writeMeta({ ...this._readMeta(), ...persisting });
    return results;
  }

  /**
   * Ensure the user systemd unit is running after a no-op reinstall. Returns
   * 'running' | 'started' | 'start-failed'. Never throws.
   *
   * `enable --now` is idempotent, so this is safe on every install: a unit file
   * that matches byte-for-byte says nothing about whether systemd is running it
   * (stopped, failed, or linger lost after a logout).
   */
  _ensureUnitRunning() {
    try {
      {
        let state = '';
        try {
          state = String(this._execFileSync('systemctl', ['--user', 'is-active', SERVICE_NAME], { encoding: 'utf8' })).trim();
        } catch (_) { state = ''; }
        if (state === 'active') return 'running';
        try {
          this._execFileSync('systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
          this._enableLinger();
          return 'started';
        } catch (_) {
          return 'start-failed';
        }
      }
    } catch (_) {
      return 'unknown';
    }
  }

  /**
   * Ensure the launchd agent is loaded after a no-op reinstall. Returns
   * 'running' | 'started' | 'start-failed'. Never throws.
   */
  _ensureAgentRunning(unitFile) {
    try {
      let loaded = false;
      try {
        const out = String(this._execFileSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf8' }));
        loaded = /"PID" = \d+/.test(out) || /"LastExitStatus"/.test(out) || out.length > 0;
      } catch (_) { loaded = false; }
      if (loaded) return 'running';
      try {
        this._execFileSync('launchctl', ['load', unitFile]);
        return 'started';
      } catch (_) {
        return 'start-failed';
      }
    } catch (_) {
      return 'unknown';
    }
  }

  /**
   * Start the task when it is not running (idempotent reinstall). Returns
   * 'running' | 'started' | 'start-failed'. Never throws.
   */
  _ensureTaskRunning() {
    try {
      let state = 'Unknown';
      try {
        const out = String(this._execFileSync(
          'schtasks', ['/query', '/tn', SERVICE_NAME, '/fo', 'LIST'], { encoding: 'utf8' }
        ));
        const m = /^Status:\s*(.+?)\s*$/im.exec(out);
        if (m) state = m[1].trim();
      } catch (_) { return 'unknown'; }
      if (/^running$/i.test(state)) return 'running';
      try {
        this._execFileSync('schtasks', ['/run', '/tn', SERVICE_NAME]);
        return 'started';
      } catch (_) {
        return 'start-failed';
      }
    } catch (_) {
      return 'unknown';
    }
  }

  uninstall() {
    if (this._platform === 'linux') {
      try { this._execFileSync('systemctl', ['--user', 'disable', '--now', SERVICE_NAME]); } catch (_) { /* ignore */ }
      try { fs.rmSync(this.unitPath(), { force: true }); } catch (_) { /* ignore */ }
      try { this._execFileSync('systemctl', ['--user', 'daemon-reload']); } catch (_) { /* ignore */ }
      try { this._execFileSync('systemctl', ['--user', 'reset-failed', SERVICE_NAME]); } catch (_) { /* ignore */ }
    } else if (this._platform === 'darwin') {
      try { this._execFileSync('launchctl', ['unload', this.unitPath()]); } catch (_) { /* ignore */ }
      try { fs.rmSync(this.unitPath(), { force: true }); } catch (_) { /* ignore */ }
    } else if (this._platform === 'win32') {
      // /end first: /delete removes the definition but leaves a running
      // supervisor+server+PTY tree orphaned (holding the port, wedging the
      // next install under IgnoreNew). Poll briefly so /delete (and a later
      // reinstall's /create+/run) does not race the dying tree.
      try { this._execFileSync('schtasks', ['/end', '/tn', SERVICE_NAME]); } catch (_) { /* not running */ }
      this._pollTaskStopped(5000);
      try { this._execFileSync('schtasks', ['/delete', '/tn', SERVICE_NAME, '/f']); } catch (_) { /* ignore */ }
      try { fs.rmSync(this.taskXmlPath(), { force: true }); } catch (_) { /* ignore */ }
      // The watchdog must go too: left behind it would restart a service the
      // operator just removed, resurrecting the daemon on the next 5-minute tick.
      this.removeWatchdogTask();
    }
    return { uninstalled: true, platform: this._platform };
  }

  status() {
    const meta = this._readMeta();
    const base = {
      platform: this._platform,
      supervisorPath: meta.supervisorPath || null,
      serverArgs: meta.serverArgs || [],
      nodePath: meta.nodePath || null,
    };
    try {
      if (this._platform === 'linux') {
        const file = this.unitPath();
        const installed = !!(file && fs.existsSync(file));
        let active = false;
        let enabled = false;
        try {
          const out = this._execFileSync('systemctl', ['--user', 'is-active', SERVICE_NAME], { encoding: 'utf8' });
          active = String(out).trim() === 'active';
        } catch (_) { active = false; }
        try {
          const out = this._execFileSync('systemctl', ['--user', 'is-enabled', SERVICE_NAME], { encoding: 'utf8' });
          enabled = String(out).trim() === 'enabled';
        } catch (_) { enabled = false; }
        return { ...base, installed, active, enabled };
      }
      if (this._platform === 'darwin') {
        const file = this.unitPath();
        const installed = !!(file && fs.existsSync(file));
        let active = false;
        try {
          const out = this._execFileSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf8' });
          active = /"PID" = \d+/.test(String(out));
        } catch (_) { active = false; }
        return { ...base, installed, active };
      }
      if (this._platform === 'win32') {
        let out = '';
        try {
          out = String(this._execFileSync('schtasks', ['/query', '/tn', SERVICE_NAME, '/fo', 'LIST'], { encoding: 'utf8' }));
        } catch (_) {
          return { ...base, installed: false, active: false, taskState: 'Unknown', mode: meta.mode || 'login' };
        }
        // Line-anchored parse (not substring): /Running/ also matches paths.
        const m = /^Status:\s*(.+?)\s*$/im.exec(out);
        const taskState = m ? m[1].trim() : 'Unknown';
        return {
          ...base,
          installed: true,
          active: /^running$/i.test(taskState),
          taskState,
          // The fields an operator needs to tell "installed" from "actually
          // going to come back after a reboot": which mode, which server
          // build, how fresh the liveness beacon is, and what the last run
          // returned (0x0 = success, 0x41303 = never run, 0x41301 = running).
          mode: meta.mode || 'login',
          userId: meta.userId || null,
          lastInstalledAt: meta.installedAt || null,
          serverBinary: meta.serverBinary || null,
          serverVersion: meta.serverVersion || null,
          serverVerified: meta.serverVerified || null,
          serverReleaseTag: meta.serverReleaseTag || null,
          watchdog: this._watchdogStatus(),
          heartbeat: this._heartbeatStatus(),
          lastTaskResult: this._taskInfo('LastTaskResult'),
          lastRunTime: this._taskInfo('Last Run Time'),
          nextRunTime: this._taskInfo('Next Run Time'),
        };
      }
    } catch (_) { /* fall through */ }
    return { ...base, installed: false, active: false };
  }

  /**
   * The watchdog task needs a heartbeat and a restart verb, both of which are
   * win32-only today (systemd Restart=always / launchd KeepAlive already cover
   * the POSIX cases, and neither has a comparable "restart a running unit"
   * primitive that is safe to call from a 5-minute tick).
   *
   * Installed in BOTH modes: a wedge is mode-independent, and in login mode the
   * watchdog uses the same InteractiveToken principal so it ticks exactly when
   * the service runs. Uninstall removes it.
   */
  _shouldManageWatchdog() {
    if (this._platform !== 'win32') return false;
    try {
      if (process.env.AIORDIE_DISABLE_WATCHDOG === '1') return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  watchdogTaskName() {
    return `${SERVICE_NAME}-watchdog`;
  }

  watchdogXmlPath() {
    return path.join(this._baseDir, 'ai-or-die-watchdog-task.xml');
  }

  /**
   * Register (or refresh) the out-of-process watchdog task.
   *
   * Deliberately a SEPARATE task: it must run while the main task is wedged,
   * and a task cannot reliably restart itself. It also must not inherit
   * `IgnoreNew` from the main task's instance policy.
   */
  ensureWatchdogTask(opts = {}) {
    if (this._platform !== 'win32') return { installed: false, reason: 'not-win32' };
    const nodePath = opts.nodePath || this.nodePath();
    const { ServiceWatchdog } = require('./service-watchdog');
    const wd = new ServiceWatchdog({
      baseDir: this._baseDir,
      execFileSync: this._execFileSync,
      logger: this._logger,
      serviceName: SERVICE_NAME,
    });
    // Same principal/trigger mode as the service: an InteractiveToken watchdog
    // cannot run before login, which is precisely when boot mode needs it.
    const mode = opts.mode === 'boot' ? 'boot' : 'login';
    const userId = opts.userId !== undefined
      ? opts.userId
      : (mode === 'boot' ? currentUserIdentity({ spawnSync: this._spawnSync }) : null);
    const xml = wd.buildWatchdogXml(nodePath, this._stableSupervisor, { mode, userId });
    const xmlFile = this.watchdogXmlPath();
    // The watchdog XML is machine-generated and version-stamped in its
    // <Version>; always re-register on install (it is a 5-minute no-op task,
    // so re-creating it costs nothing and cannot disturb live sessions).
    fs.mkdirSync(path.dirname(xmlFile), { recursive: true });
    writeFileAtomic(xmlFile, '\ufeff' + xml.replace(/^\ufeff+/, ''), 'utf16le');
    this._execFileSync('schtasks', ['/create', '/tn', this.watchdogTaskName(), '/xml', xmlFile, '/f']);
    return { installed: true, taskName: this.watchdogTaskName(), taskXml: xmlFile };
  }

  removeWatchdogTask() {
    if (this._platform !== 'win32') return { removed: false, reason: 'not-win32' };
    try { this._execFileSync('schtasks', ['/end', '/tn', this.watchdogTaskName()]); } catch (_) { /* not running */ }
    try { this._execFileSync('schtasks', ['/delete', '/tn', this.watchdogTaskName(), '/f']); } catch (_) { /* absent */ }
    try { fs.rmSync(this.watchdogXmlPath(), { force: true }); } catch (_) { /* ignore */ }
    return { removed: true, taskName: this.watchdogTaskName() };
  }

  _systemdUnit(supervisorPath, opts = {}) {
    const nodePath = opts.nodePath || this._nodePath || process.execPath;
    const serverArgs = (opts.serverArgs || []).map(quoteArg).join(' ');
    const execStart = serverArgs
      ? `ExecStart=${quoteArg(nodePath)} ${quoteArg(supervisorPath)} ${serverArgs}`
      : `ExecStart=${quoteArg(nodePath)} ${quoteArg(supervisorPath)}`;
    return [
      '[Unit]',
      'Description=ai-or-die AI coding terminal (user service)',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      execStart,
      'Restart=always',
      'RestartSec=5',
      'Environment=AIORDIE_SERVICE=1',
      'WorkingDirectory=%h',
      `StandardOutput=append:${quoteArg(path.join(this._baseDir, 'logs', 'supervisor.log'))}`,
      'StandardError=inherit',
      'SyslogIdentifier=ai-or-die',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
  }

  _launchdPlist(supervisorPath, opts = {}) {
    const nodePath = opts.nodePath || this._nodePath || process.execPath;
    const serverArgs = opts.serverArgs || [];
    const progArgs = [nodePath, supervisorPath, ...serverArgs]
      .map((a) => `    <string>${escapeXml(a)}</string>`)
      .join('\n');
    const homePath = process.env.HOME || this._homedir;
    const installPath = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
      .filter(Boolean)
      .join(':');
    const logDir = path.join(this._baseDir, 'logs');
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      progArgs,
      '  </array>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      '    <key>AIORDIE_SERVICE</key><string>1</string>',
      `    <key>PATH</key><string>${escapeXml(installPath)}</string>`,
      `    <key>HOME</key><string>${escapeXml(homePath)}</string>`,
      '  </dict>',
      `  <key>WorkingDirectory</key><string>${escapeXml(homePath)}</string>`,
      `  <key>StandardOutPath</key><string>${escapeXml(path.join(logDir, 'supervisor.log'))}</string>`,
      `  <key>StandardErrorPath</key><string>${escapeXml(path.join(logDir, 'supervisor-error.log'))}</string>`,
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      '  <key>ThrottleInterval</key><integer>30</integer>',
      '  <key>ProcessType</key><string>Standard</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }

  _taskSchedulerXml(supervisorPath, opts = {}) {
    const nodePath = opts.nodePath || this._nodePath || process.execPath;
    const serverArgs = opts.serverArgs || [];
    const mode = opts.mode === 'boot' ? 'boot' : 'login';
    const userId = opts.userId !== undefined
      ? opts.userId
      : (mode === 'boot' ? currentUserIdentity({ spawnSync: this._spawnSync }) : null);
    const argLine = [supervisorPath, ...serverArgs].map(quoteArg).join(' ');
    const workDir = this._baseDir;
    // Boot mode: S4U starts the task in the user's context WITHOUT a stored
    // password and WITHOUT waiting for an interactive logon. Caveats (see
    // ADR-0062): the logon session has no network credential material (no
    // SMB/NTLM/EFS/DPAPI-to-user-scope) and no interactive desktop.
    // Login mode stays InteractiveToken, which requires the user to already be
    // logged on.
    const principal = mode === 'boot'
      ? [
        '    <Principal id="Author">',
        ...(userId ? [`      <UserId>${escapeXml(userId)}</UserId>`] : []),
        '      <LogonType>S4U</LogonType>',
        '      <RunLevel>LeastPrivilege</RunLevel>',
        '    </Principal>',
      ]
      : [
        '    <Principal id="Author">',
        '      <LogonType>InteractiveToken</LogonType>',
        '      <RunLevel>LeastPrivilege</RunLevel>',
        '    </Principal>',
      ];
    const triggers = [];
    if (mode === 'boot') {
      // A short delay lets the network stack and the user profile service come
      // up first (S4U needs the profile for HKCU/%APPDATA% to resolve).
      triggers.push(
        '    <BootTrigger>',
        '      <Enabled>true</Enabled>',
        '      <Delay>PT20S</Delay>',
        '    </BootTrigger>'
      );
    }
    triggers.push(
      '    <LogonTrigger>',
      '      <Enabled>true</Enabled>',
      '      <Repetition>',
      '        <Interval>PT5M</Interval>',
      '        <StopAtDurationEnd>false</StopAtDurationEnd>',
      '      </Repetition>',
      '    </LogonTrigger>'
    );
    // Self-healing backstop: a 5-minute tick that is a no-op while an instance
    // runs (MultipleInstancesPolicy=IgnoreNew) and restarts the daemon within
    // 5 minutes of any death that RestartOnFailure cannot see (crash dump, hard
    // terminate, Fast Startup resume which does not fire BootTrigger).
    triggers.push(
      '    <TimeTrigger>',
      '      <StartBoundary>2026-01-01T00:00:00</StartBoundary>',
      '      <Enabled>true</Enabled>',
      '      <Repetition>',
      '        <Interval>PT5M</Interval>',
      '        <StopAtDurationEnd>false</StopAtDurationEnd>',
      '      </Repetition>',
      '    </TimeTrigger>'
    );
    // Wake support. StateChange values are the Task Scheduler enum:
    // ConsoleConnect, ConsoleDisconnect, RemoteConnect, RemoteDisconnect,
    // SessionLock, SessionUnlock. `ConsoleUnlock` is NOT one of them and makes
    // schtasks reject the whole XML ((19,36):StateChange:ConsoleUnlock).
    for (const state of ['ConsoleConnect', 'SessionUnlock', 'RemoteConnect']) {
      triggers.push(
        '    <SessionStateChangeTrigger>',
        '      <Enabled>true</Enabled>',
        `      <StateChange>${state}</StateChange>`,
        '    </SessionStateChangeTrigger>'
      );
    }
    return [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo>',
      '    <Author>ai-or-die</Author>',
      `    <Description>ai-or-die AI coding terminal (${mode === 'boot' ? 'boot service, starts before login' : 'user login service'})</Description>`,
      '    <Version>1.1</Version>',
      '  </RegistrationInfo>',
      '  <Principals>',
      ...principal,
      '  </Principals>',
      '  <Triggers>',
      ...triggers,
      '  </Triggers>',
      '  <Actions Context="Author">',
      '    <Exec>',
      `      <Command>${escapeXml(nodePath)}</Command>`,
      `      <Arguments>${escapeXml(argLine)}</Arguments>`,
      `      <WorkingDirectory>${escapeXml(workDir)}</WorkingDirectory>`,
      '    </Exec>',
      '  </Actions>',
      '  <Settings>',
      '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      // PT0S = run indefinitely. The schema default is P3D, which hard-kills
      // the daemon (and every PTY in it) every three days.
      '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      // Count is xsd:unsignedByte (1-255). 999 is rejected at registration and
      // 0 as well, so this must be a real byte value.
      '    <RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure>',
      '    <StartWhenAvailable>true</StartWhenAvailable>',
      '    <WakeToRun>true</WakeToRun>',
      '    <AllowStartOnDemand>true</AllowStartOnDemand>',
      '    <AllowHardTerminate>true</AllowHardTerminate>',
      '    <Enabled>true</Enabled>',
      '    <Hidden>false</Hidden>',
      '  </Settings>',
      '</Task>',
      '',
    ].join('\n');
  }

  // True when the on-disk unit already matches what install() would write
  // (content + serverArgs + nodePath in meta). Lets reinstalls no-op instead
  // of restarting the daemon and killing live PTYs.
  _unitUnchanged(file, unit, results) {
    try {
      if (!fs.existsSync(file)) return false;
      let existing;
      if (this._platform === 'win32') {
        existing = fs.readFileSync(file, 'utf16le').replace(/^\ufeff/, '');
      } else {
        existing = fs.readFileSync(file, 'utf8');
      }
      if (existing !== unit) return false;
      const meta = this._readMeta();
      const sameArgs = JSON.stringify(meta.serverArgs || []) === JSON.stringify(results.serverArgs || []);
      const sameNode = (meta.nodePath || null) === (results.nodePath || null);
      const sameSup = (meta.supervisorPath || null) === (results.supervisorPath || null);
      // A supervisor-tree upgrade must restart the Task even when args/node
      // are unchanged — otherwise the staged new code never activates.
      // Compared against the version recorded BEFORE staging (results.
      // prevBundleVersion): meta on disk was already re-stamped by
      // ensureStableBinary(), so reading it here would always match.
      const prev = results.prevBundleVersion !== undefined
        ? results.prevBundleVersion
        : (meta.bundleVersion || null);
      const sameBundle = (prev || null) === supervisorVersion();
      return sameArgs && sameNode && sameSup && sameBundle;
    } catch (_) {
      return false;
    }
  }

  // Best-effort lingering so the user unit survives logout/reboot on headless
  // machines. Never throws — install must succeed even when loginctl is absent.
  _enableLinger() {
    try {
      if (this._platform !== 'linux') return 'n/a';
      const user = process.env.USER || process.env.LOGNAME || os.userInfo().username;
      const r = this._spawnSync('loginctl', ['enable-linger', user], { encoding: 'utf8' });
      if (r && r.status === 0) return 'enabled';
      if (r && r.error) return 'skipped'; // loginctl absent (non-systemd host)
      try { this._logger.log('  hint: run `loginctl enable-linger $USER` so the service survives logout; tail with `journalctl --user -u ai-or-die -f`'); } catch (_) {}
      return 'hinted';
    } catch (_) {
      return 'skipped';
    }
  }

  // Install-time hibernation handling (win32 only): non-privileged registry
  // read first; launch the existing elevated remediation (fire-and-forget, so
  // install never blocks 60s) only when hibernate is on, the session is
  // interactive, and the user did not opt out. Never throws.
  _maybeHibernationGuard(opts = {}) {
    try {
      if (this._platform !== 'win32') return 'n/a';
      if (process.env.AIORDIE_DISABLE_HIBERNATION === '1') return 'opt-out';
      // Boot mode runs in an S4U logon session: there is no interactive
      // desktop, so the remediation path (Start-Process -Verb RunAs) can never
      // show its UAC prompt and would fail silently. Report the honest answer
      // instead of pretending to remediate.
      if (opts.mode === 'boot') return 'boot-mode-headless';
      let value = null;
      try {
        const r = this._spawnSync(
          'reg',
          ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power', '/v', 'HibernateEnabled'],
          { encoding: 'utf8' }
        );
        const m = /HibernateEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(String((r && r.stdout) || ''));
        if (m) value = parseInt(m[1], 16);
      } catch (_) { value = null; }
      if (value === 0) return 'already-off';
      if (!process.stdout || !process.stdout.isTTY) return 'skipped-headless';
      try {
        const HibernationGuard = require('../hibernation-guard');
        new HibernationGuard({ enabled: true, platform: 'win32' }).run();
        return 'prompted';
      } catch (_) {
        return 'unavailable';
      }
    } catch (_) {
      return 'skipped';
    }
  }

  /**
   * True when a task with this name is registered. Never throws.
   *
   * Used to tell "first install" from "upgrade over a working install": on
   * win32 both look identical from the unit file alone, but only the latter has
   * a good definition worth preserving when /create fails.
   */
  _taskExists(name = SERVICE_NAME) {
    try {
      // stdio:'pipe' keeps schtasks' "cannot find the file specified" on
      // stderr instead of printing it over the CLI's JSON output.
      this._execFileSync('schtasks', ['/query', '/tn', name], { stdio: 'pipe' });
      return true;
    } catch (_) {
      return false;
    }
  }

  // Best-effort synchronous poll for the task reaching a non-Running state.
  // Bounded (one-shot CLI may block briefly); never throws.
  _pollTaskStopped(timeoutMs = 5000) {
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let state = '';
        try {
          const out = String(this._execFileSync(
            'schtasks', ['/query', '/tn', SERVICE_NAME, '/fo', 'LIST'], { encoding: 'utf8' }
          ));
          const m = /^Status:\s*(.+?)\s*$/im.exec(out);
          state = m ? m[1].trim().toLowerCase() : '';
        } catch (_) {
          return; // task already gone
        }
        if (state !== 'running') return;
        this._sleep(250);
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * Synchronous sleep without a new dependency.
   *
   * `Atomics.wait` on a throwaway buffer blocks the thread for real; the
   * previous bounded busy-wait spun a CPU core for the whole window, which on a
   * tiny VM is the difference between a slow install and a stalled one.
   */
  _sleep(ms) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (_) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { /* fallback: old behaviour */ }
    }
  }

  /** Watchdog task presence + last result, as reported by `service status`. */
  _watchdogStatus() {
    try {
      const out = String(this._execFileSync(
        'schtasks', ['/query', '/tn', this.watchdogTaskName(), '/fo', 'LIST'], { encoding: 'utf8' }
      ));
      const m = /^Status:\s*(.+?)\s*$/im.exec(out);
      return { installed: true, taskState: m ? m[1].trim() : 'Unknown' };
    } catch (_) {
      return { installed: false };
    }
  }

  /** Age of the daemon's liveness beacon (see heartbeat.js). Never throws. */
  _heartbeatStatus() {
    try {
      const { readHeartbeat, heartbeatAgeMs } = require('./heartbeat');
      // Read the beacon belonging to THIS install's base dir, not the default
      // one: an installer pointed at an alternate AI_OR_DIE_HOME must not
      // report another installation's daemon as its own.
      const file = this.heartbeatFilePath();
      const hb = readHeartbeat({ file });
      if (!hb) return { present: false };
      const ageMs = heartbeatAgeMs({ file });
      // Server identity lives under `status` in the payload written by
      // Heartbeat.beat (index.js passes a status() resolver); reading it off
      // the top level reports null forever.
      const st = (hb.status && typeof hb.status === 'object') ? hb.status : {};
      return {
        present: true,
        // Numeric value plus a friendlier rendering for humans reading JSON.
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
        ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
        phase: hb.phase || null,
        pid: hb.pid || null,
        serverPid: st.serverPid || null,
        serverVersion: st.serverVersion || null,
        version: st.version || null,
        ptys: Number.isFinite(st.ptys) ? st.ptys : null,
        updatedAt: hb.updatedAt || null,
      };
    } catch (_) {
      return { present: false };
    }
  }

  /** One field from `schtasks /query /fo LIST /v` (verbose) for this task. */
  _taskInfo(label) {
    try {
      const out = String(this._execFileSync(
        'schtasks', ['/query', '/tn', SERVICE_NAME, '/fo', 'LIST', '/v'], { encoding: 'utf8' }
      ));
      const re = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+?)\\s*$`, 'im');
      const m = re.exec(out);
      return m ? m[1].trim() : null;
    } catch (_) {
      return null;
    }
  }

  _writeMeta(meta) {
    try {
      fs.mkdirSync(this._baseDir, { recursive: true });
      // Temp file + rename, like every other persisted file in this class: a
      // torn write leaves unparseable JSON, _readMeta() silently degrades to
      // {}, and the next install's rollback then deletes service.json while a
      // task is still registered — that daemon boots believing it is NOT a
      // service (no hibernation guard, wrong mode). Same directory so the
      // rename is atomic (a cross-device rename falls back to copy+unlink).
      const tmp = `${this._metaFile}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this._metaFile);
    } catch (_) { /* best-effort */ }
  }

  _readMeta() {
    try {
      return JSON.parse(fs.readFileSync(this._metaFile, 'utf8'));
    } catch (_) {
      return {};
    }
  }
}

module.exports = {
  ServiceInstaller,
  isTempPackagePath,
  isServiceRuntime,
  stripSecrets,
  validateServerArgs,
  resolveNodeRuntime,
  escapeXml,
  quoteArg,
  currentUserIdentity,
  STAGED_FILES,
  SERVICE_NAME,
};
