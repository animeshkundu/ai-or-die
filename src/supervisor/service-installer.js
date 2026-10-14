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

const SERVICE_NAME = process.env.AIORDIE_SERVICE_NAME || 'ai-or-die';
const LAUNCHD_LABEL = 'com.ai-or-die';

// Files staged from the package into the stable base, as [packageRel, baseRel]
// pairs. Covers the full supervisor require closure (all built-ins except the
// optional koffi native, which degrades gracefully when absent).
const STAGED_FILES = [
  ['bin/supervisor-service.js', path.join('bin', 'ai-or-die-supervisor.js')],
  ['src/supervisor/index.js', path.join('src', 'supervisor', 'index.js')],
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
    this._execFileSync = options.execFileSync || execFileSync;
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
    // Merge (never clobber): install() compares meta.serverArgs/nodePath for
    // idempotent reinstalls, and a bare _writeMeta here would wipe them.
    this._writeMeta({
      ...this._readMeta(),
      supervisorPath: stable,
      stable: true,
      bundleVersion: supervisorVersion(),
      stagedFrom,
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

  install(sourceScript, opts = {}) {
    const { args: serverArgs } = stripSecrets(opts.serverArgs || []);
    validateServerArgs(serverArgs);
    const nodePath = opts.nodePath || this._nodePath || resolveNodeRuntime({ spawnSync: this._spawnSync }).nodePath;
    const { path: supervisorPath } = this.ensureStableBinary(sourceScript);
    const unit = this.buildUnit(supervisorPath, { serverArgs, nodePath });
    const results = { supervisorPath, platform: this._platform, nodePath, serverArgs };
    const written = [];
    try {
      if (this._platform === 'linux') {
        const file = this.unitPath();
        if (this._unitUnchanged(file, unit, results)) {
          results.unchanged = true;
          results.unitFile = file;
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
        } else {
          fs.mkdirSync(path.dirname(xmlFile), { recursive: true });
          // Match the UTF-16 prolog: UTF-16LE *with BOM* (dedup: buildUnit
          // never emits one, but a second BOM would fail schtasks parsing and
          // defeat the idempotency comparison below).
          writeFileAtomic(xmlFile, '\ufeff' + unit.replace(/^\ufeff+/, ''), 'utf16le');
          written.push(xmlFile);
          try {
            this._execFileSync('schtasks', ['/create', '/tn', SERVICE_NAME, '/xml', xmlFile, '/f']);
          } catch (createErr) {
            // Compensate: /create may have partially registered before failing.
            try { this._execFileSync('schtasks', ['/delete', '/tn', SERVICE_NAME, '/f']); } catch (_) {}
            throw createErr;
          }
          try {
            this._execFileSync('schtasks', ['/run', '/tn', SERVICE_NAME]);
          } catch (runErr) {
            // Best-effort start (IgnoreNew refuses when already running), but
            // never silent: a schema-valid yet runtime-broken task would
            // otherwise report success and be discovered only after reboot.
            try {
              this._logger.warn(`service install: task created but immediate start failed (${runErr && runErr.message}); it will start at next logon — verify with \`ai-or-die service status\``);
            } catch (_) {}
          }
          results.taskXml = xmlFile;
          results.hibernation = this._maybeHibernationGuard();
        }
      }
    } catch (err) {
      for (const f of written) {
        try { fs.rmSync(f, { force: true }); } catch (_) { /* ignore */ }
      }
      if (err && err.code === 'ENOENT' && /systemctl|launchctl|schtasks|loginctl/.test(err.message || '')) {
        throw new Error(`${err.message} — is the service manager available on this machine?`);
      }
      throw err;
    }
    results.installedAt = new Date().toISOString();
    results.bundleVersion = supervisorVersion();
    this._writeMeta({ ...this._readMeta(), ...results });
    return results;
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
          return { ...base, installed: false, active: false, taskState: 'Unknown' };
        }
        // Line-anchored parse (not substring): /Running/ also matches paths.
        const m = /^Status:\s*(.+?)\s*$/im.exec(out);
        const taskState = m ? m[1].trim() : 'Unknown';
        return { ...base, installed: true, active: /^running$/i.test(taskState), taskState };
      }
    } catch (_) { /* fall through */ }
    return { ...base, installed: false, active: false };
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
    const argLine = [supervisorPath, ...serverArgs].map(quoteArg).join(' ');
    const workDir = this._baseDir;
    return [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo>',
      '    <Author>ai-or-die</Author>',
      '    <Description>ai-or-die AI coding terminal (user login service)</Description>',
      '    <Version>1.0</Version>',
      '  </RegistrationInfo>',
      '  <Principals>',
      '    <Principal id="Author">',
      '      <LogonType>InteractiveToken</LogonType>',
      '      <RunLevel>LeastPrivilege</RunLevel>',
      '    </Principal>',
      '  </Principals>',
      '  <Triggers>',
      '    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>',
      '    <!-- Wake support: restart on workstation unlock / reconnect -->',
      '    <SessionStateChangeTrigger>',
      '      <Enabled>true</Enabled>',
      '      <StateChange>ConsoleUnlock</StateChange>',
      '    </SessionStateChangeTrigger>',
      '    <SessionStateChangeTrigger>',
      '      <Enabled>true</Enabled>',
      '      <StateChange>SessionUnlock</StateChange>',
      '    </SessionStateChangeTrigger>',
      '    <SessionStateChangeTrigger>',
      '      <Enabled>true</Enabled>',
      '      <StateChange>RemoteConnect</StateChange>',
      '    </SessionStateChangeTrigger>',
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
      '    <ExecutionTimeLimit>P3D</ExecutionTimeLimit>',
      '    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>',
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
      const sameBundle = (meta.bundleVersion || null) === supervisorVersion();
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
  _maybeHibernationGuard() {
    try {
      if (this._platform !== 'win32') return 'n/a';
      if (process.env.AIORDIE_DISABLE_HIBERNATION === '1') return 'opt-out';
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
        // Synchronous sleep without new deps: spawnSync a no-op with timeout.
        try { this._spawnSync('schtasks', ['/query', '/tn', SERVICE_NAME], { encoding: 'utf8', timeout: 400 }); } catch (_) {}
        const t0 = Date.now();
        while (Date.now() - t0 < 400) { /* bounded busy-wait, one-shot CLI only */ }
      }
    } catch (_) { /* ignore */ }
  }

  _writeMeta(meta) {
    try {
      fs.mkdirSync(this._baseDir, { recursive: true });
      fs.writeFileSync(this._metaFile, JSON.stringify(meta, null, 2), { mode: 0o600 });
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
  SERVICE_NAME,
};
