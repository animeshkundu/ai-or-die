'use strict';

// ServiceInstaller — install/remove/status the user-level ai-or-die service.
//
// Platform mapping (user-level only — never requires admin):
//   linux  -> systemd --user unit  (~/.config/systemd/user/ai-or-die.service)
//   darwin -> launchd agent        (~/Library/LaunchAgents/com.ai-or-die.plist)
//   win32  -> Task Scheduler task  (logon trigger + workstation-unlock wake)
//
// STABLE-PATH GUARANTEE (the npx/bunx requirement): the service NEVER points
// at the invoking package location (npm npx cache, bun install cache, /tmp).
// On `service install`, the supervisor entry point is copied to
// ~/.ai-or-die/bin/ai-or-die-supervisor.js (STABLE_SUPERVISOR_JS) and every
// generated unit references ONLY that path. Updates replace
// ~/.ai-or-die/bin/ai-or-die-server in place, so the service definition is
// written once and never changes afterwards.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { STABLE_BASE } = require('./constants');

const SERVICE_NAME = process.env.AIORDIE_SERVICE_NAME || 'ai-or-die';
const LAUNCHD_LABEL = 'com.ai-or-die';

function isTempPackagePath(p) {
  if (!p) return true;
  const s = String(p);
  return /\.npm[\\/]_npx/i.test(s)
    || /\.bun[\\/]install[\\/]cache/i.test(s)
    || /node_modules[\\/]\.cache/i.test(s)
    || /(^|[\\/])tmp[\\/]/i.test(s)
    || /AppData[\\/]Local[\\/]Temp/i.test(s)
    || /\/tmp\//.test(s);
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

  /**
   * Copy the running supervisor entry point to the stable location when the
   * current package path is ephemeral (npx/bunx cache). Idempotent: when the
   * source already IS the stable path, this is a no-op returning it.
   * Returns { path, copied }.
   */
  ensureStableBinary(sourceScript = process.argv[1]) {
    const stable = this._stableSupervisor;
    const resolvedSource = sourceScript ? path.resolve(sourceScript) : null;
    if (resolvedSource && path.resolve(stable) === resolvedSource) {
      return { path: stable, copied: false };
    }
    fs.mkdirSync(this.stableBinDir(), { recursive: true });
    if (resolvedSource && fs.existsSync(resolvedSource) && !isTempPackagePath(resolvedSource)) {
      // Global npm install or source checkout: reference it directly — the
      // path is already stable. Still record metadata.
      this._writeMeta({ supervisorPath: resolvedSource, stable: false });
      return { path: resolvedSource, copied: false };
    }
    if (resolvedSource && fs.existsSync(resolvedSource)) {
      fs.copyFileSync(resolvedSource, stable);
      try { fs.chmodSync(stable, 0o755); } catch (_) { /* windows */ }
      this._writeMeta({ supervisorPath: stable, stable: true });
      return { path: stable, copied: true };
    }
    // Source unavailable (packed SEA?): record intent; unit still references stable.
    this._writeMeta({ supervisorPath: stable, stable: true });
    return { path: stable, copied: false };
  }

  buildUnit(supervisorPath) {
    if (this._platform === 'linux') return this._systemdUnit(supervisorPath);
    if (this._platform === 'darwin') return this._launchdPlist(supervisorPath);
    if (this._platform === 'win32') return this._taskSchedulerXml(supervisorPath);
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

  install(sourceScript) {
    const { path: supervisorPath } = this.ensureStableBinary(sourceScript);
    const unit = this.buildUnit(supervisorPath);
    const results = { supervisorPath, platform: this._platform };
    if (this._platform === 'linux') {
      const file = this.unitPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, unit, 'utf8');
      this._execFileSync('systemctl', ['--user', 'daemon-reload']);
      this._execFileSync('systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
      results.unitFile = file;
    } else if (this._platform === 'darwin') {
      const file = this.unitPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, unit, 'utf8');
      this._execFileSync('launchctl', ['load', file]);
      results.unitFile = file;
    } else if (this._platform === 'win32') {
      const xmlFile = this.taskXmlPath();
      fs.mkdirSync(path.dirname(xmlFile), { recursive: true });
      fs.writeFileSync(xmlFile, unit, 'utf8');
      this._execFileSync('schtasks', ['/create', '/tn', SERVICE_NAME, '/xml', xmlFile, '/f']);
      results.taskXml = xmlFile;
    }
    results.installedAt = new Date().toISOString();
    this._writeMeta({ ...this._readMeta(), ...results });
    return results;
  }

  uninstall() {
    if (this._platform === 'linux') {
      try { this._execFileSync('systemctl', ['--user', 'disable', '--now', SERVICE_NAME]); } catch (_) { /* ignore */ }
      try { fs.rmSync(this.unitPath(), { force: true }); } catch (_) { /* ignore */ }
    } else if (this._platform === 'darwin') {
      try { this._execFileSync('launchctl', ['unload', this.unitPath()]); } catch (_) { /* ignore */ }
      try { fs.rmSync(this.unitPath(), { force: true }); } catch (_) { /* ignore */ }
    } else if (this._platform === 'win32') {
      try { this._execFileSync('schtasks', ['/delete', '/tn', SERVICE_NAME, '/f']); } catch (_) { /* ignore */ }
    }
    return { uninstalled: true, platform: this._platform };
  }

  status() {
    try {
      if (this._platform === 'linux') {
        const out = this._execFileSync('systemctl', ['--user', 'is-active', SERVICE_NAME], { encoding: 'utf8' });
        return { platform: this._platform, active: String(out).trim() === 'active' };
      }
      if (this._platform === 'darwin') {
        const out = this._execFileSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf8' });
        return { platform: this._platform, active: /"PID" = \d+/.test(String(out)) };
      }
      if (this._platform === 'win32') {
        const out = this._execFileSync('schtasks', ['/query', '/tn', SERVICE_NAME, '/fo', 'LIST'], { encoding: 'utf8' });
        return { platform: this._platform, active: /Running/i.test(String(out)) };
      }
    } catch (_) { /* fall through */ }
    return { platform: this._platform, active: false };
  }

  _systemdUnit(supervisorPath) {
    return [
      '[Unit]',
      'Description=ai-or-die AI coding terminal (user service)',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${process.execPath} ${supervisorPath}`,
      'Restart=always',
      'RestartSec=5',
      'Environment=AIORDIE_SERVICE=1',
      // Wake support: hold a sleep inhibitor while the supervisor runs and
      // restart the unit when the machine wakes.
      'ExecStartPre=/usr/bin/systemd-inhibit --what=sleep --who=ai-or-die --why="Keep PTY sessions alive" sleep infinity',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
  }

  _launchdPlist(supervisorPath) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      `    <string>${process.execPath}</string>`,
      `    <string>${supervisorPath}</string>`,
      '  </array>',
      '  <key>EnvironmentVariables</key>',
      '  <dict><key>AIORDIE_SERVICE</key><string>1</string></dict>',
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      '  <!-- Wake support: hourly check + PowerNap wake -->',
      '  <key>StartCalendarInterval</key>',
      '  <array><dict><key>Minute</key><integer>0</integer></dict></array>',
      '  <key>ProcessType</key><string>Background</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }

  _taskSchedulerXml(supervisorPath) {
    const userProfile = '%USERPROFILE%';
    const exe = supervisorPath.replace(os.homedir(), userProfile);
    return [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <Triggers>',
      '    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>',
      '    <!-- Wake support: restart on workstation unlock -->',
      '    <SessionStateChangeTrigger>',
      '      <Enabled>true</Enabled>',
      '      <StateChange>ConsoleUnlock</StateChange>',
      '    </SessionStateChangeTrigger>',
      '  </Triggers>',
      '  <Actions Context="Author">',
      `    <Exec><Command>${process.execPath}</Command><Arguments>"${exe}"</Arguments></Exec>`,
      '  </Actions>',
      '  <Settings>',
      '    <WakeToRun>true</WakeToRun>',
      '    <StartWhenAvailable>true</StartWhenAvailable>',
      '    <RestartOnFailure><Interval>PT5M</Interval><Count>3</Count></RestartOnFailure>',
      '  </Settings>',
      '</Task>',
      '',
    ].join('\n');
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

module.exports = { ServiceInstaller, isTempPackagePath, SERVICE_NAME };
