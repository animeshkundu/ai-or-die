'use strict';

// Win11 login-service coverage: arg forwarding, secret stripping, node
// resolution, Task XML validity, UTF-16LE install, uninstall order,
// idempotent reinstall, status parsing, stable-tree staging, sentinel
// service detection, file logging, updater checksum gate.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ServiceInstaller,
  stripSecrets,
  validateServerArgs,
  resolveNodeRuntime,
  isServiceRuntime,
} = require('../src/supervisor/service-installer');
const { parseServiceArgs, findServiceEntry } = require('../src/supervisor/service-cli');
const { setupFileLogging, maybeRotate, teardown: teardownLogging } = require('../src/supervisor/service-logging');
const { supervisorVersion } = require('../src/supervisor/constants');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-win11-'));
}

function installerFor(platform, dir, extra = {}) {
  const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  return new ServiceInstaller({
    platform,
    homedir: path.join(dir, 'home'),
    baseDir: path.join(dir, 'aod'),
    stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
    metaFile: path.join(dir, 'aod', 'service.json'),
    execFileSync: () => Buffer.from(''),
    spawnSync: () => ({ status: 0, stdout: '' }),
    logger: silent,
    ...extra,
  });
}

function fakeEntry(dir, sub = 'pkg') {
  const entry = path.join(dir, sub, 'supervisor-service.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// supervisor');
  return entry;
}

describe('win11/service-cli args', function () {
  it('forwards server flags and consumes service-own flags', function () {
    const p = parseServiceArgs(['--port', '8888', '--mesh', '--no-hibernation-guard']);
    assert.deepStrictEqual(p.serverArgs, ['--port', '8888', '--mesh']);
    assert.strictEqual(p.noHibernationGuard, true);
  });

  it('drops --auth bearers (flag+value and =form)', function () {
    const p = parseServiceArgs(['--port', '8888', '--auth', 'sekret', '--mesh']);
    assert.deepStrictEqual(p.serverArgs, ['--port', '8888', '--mesh']);
    assert.strictEqual(p.droppedAuth, true);
    const q = parseServiceArgs(['--auth=sekret', '--token=sekret2']);
    assert.deepStrictEqual(q.serverArgs, []);
    assert.strictEqual(q.droppedAuth, true);
  });

  it('supports -- separator and --lines/--json', function () {
    const p = parseServiceArgs(['--', '--auth', 'x']);
    assert.deepStrictEqual(p.serverArgs, ['--auth', 'x']);
    const q = parseServiceArgs(['--lines', '50', '--json']);
    assert.strictEqual(q.lines, 50);
    assert.strictEqual(q.json, true);
  });

  it('findServiceEntry prefers the repo entry, falls back to the staged name', function () {
    const dir = sandbox();
    try {
      const binDir = path.join(dir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      assert.strictEqual(
        findServiceEntry(binDir),
        path.join(binDir, 'supervisor-service.js'),
        'missing both -> first candidate (caller throws actionable error)'
      );
      fs.writeFileSync(path.join(binDir, 'ai-or-die-supervisor.js'), '// staged');
      assert.strictEqual(findServiceEntry(binDir), path.join(binDir, 'ai-or-die-supervisor.js'));
      fs.writeFileSync(path.join(binDir, 'supervisor-service.js'), '// repo');
      assert.strictEqual(findServiceEntry(binDir), path.join(binDir, 'supervisor-service.js'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('quotes trailing backslashes so args do not merge (CommandLineToArgvW)', function () {
    const dir = sandbox();
    try {
      const inst = installerFor('win32', dir);
      const xml = inst.buildUnit('C:\\s\\x.js', { serverArgs: ['--dir', 'C:\\My Models\\'] });
      // Correct: "C:\My Models\\" (doubled). Broken: "C:\My Models\" (merges).
      assert.ok(xml.includes('My Models\\\\'), 'trailing backslash doubled inside quotes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AIORDIE_SERVICE=0 opts out even with the sentinel present', function () {
    const dir = sandbox();
    try {
      const stable = path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js');
      const meta = path.join(dir, 'aod', 'service.json');
      fs.mkdirSync(path.dirname(stable), { recursive: true });
      fs.writeFileSync(stable, '// staged');
      fs.writeFileSync(meta, '{}');
      process.env.AIORDIE_SERVICE = '0';
      assert.strictEqual(
        isServiceRuntime({ argv1: stable, baseDir: path.join(dir, 'aod') }),
        false
      );
    } finally {
      delete process.env.AIORDIE_SERVICE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stripSecrets + validateServerArgs guard the installer layer too', function () {
    assert.deepStrictEqual(stripSecrets(['--auth', 's', '--port', '1']).args, ['--port', '1']);
    assert.throws(() => validateServerArgs(['--port', '99999']), /invalid --port/);
    assert.throws(() => validateServerArgs(['--port', '0']), /invalid --port/);
    assert.doesNotThrow(() => validateServerArgs(['--port', '8888', '--mesh']));
  });
});

describe('win11/node resolution', function () {
  it('resolves the running Node 22+ via execPath', function () {
    const r = resolveNodeRuntime({ spawnSync: () => ({ status: 0, stdout: '' }) });
    assert.ok(r.nodePath, 'has nodePath');
    assert.strictEqual(r.source, 'execPath');
    assert.ok(fs.existsSync(r.nodePath));
  });
});

describe('win11/task xml', function () {
  it('is a valid user-logon task: principals, triggers, limits, battery, workdir', function () {
    const dir = sandbox();
    try {
      const inst = installerFor('win32', dir, { nodePath: 'C:\\Program Files\\nodejs\\node.exe' });
      const sup = 'C:\\Users\\u\\.ai-or-die\\bin\\ai-or-die-supervisor.js';
      const xml = inst.buildUnit(sup, { serverArgs: ['--port', '8888', '--mesh'] });
      assert.ok(xml.includes('encoding="UTF-16"'), 'utf16 prolog');
      assert.ok(xml.includes('<LogonType>InteractiveToken</LogonType>'), 'principals');
      assert.ok(xml.includes('<RunLevel>LeastPrivilege</RunLevel>'));
      assert.ok(xml.includes('<Actions Context="Author">'), 'principal ref');
      assert.ok(xml.includes('<LogonTrigger>'), 'logon trigger');
      assert.ok(xml.includes('<StateChange>ConsoleUnlock</StateChange>'));
      assert.ok(xml.includes('<StateChange>SessionUnlock</StateChange>'));
      assert.ok(xml.includes('<StateChange>RemoteConnect</StateChange>'));
      assert.ok(xml.includes('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'));
      assert.ok(xml.includes('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'));
      assert.ok(xml.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'));
      assert.ok(xml.includes('<AllowHardTerminate>true</AllowHardTerminate>'));
      assert.ok(xml.includes('<Count>999</Count>'), 'restart backstop');
      assert.ok(xml.includes('<WorkingDirectory>'), 'no system32 cwd');
      assert.ok(xml.includes('--port') && xml.includes('8888') && xml.includes('--mesh'), 'args persisted');
      assert.ok(!xml.includes('%USERPROFILE%'), 'absolute paths in Exec (no env expansion gamble)');
      assert.ok(xml.includes('C:\\Program Files\\nodejs\\node.exe'), 'baked node');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escapes XML metacharacters in args', function () {
    const dir = sandbox();
    try {
      const inst = installerFor('win32', dir);
      const xml = inst.buildUnit('C:\\s\\x.js', { serverArgs: ['--stt-model-dir', 'C:\\My & Models\\a<b>'] });
      assert.ok(xml.includes('&amp;') && xml.includes('&lt;'), 'escaped');
      assert.ok(!xml.includes('My & Models'), 'no raw ampersand');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never persists --auth into the unit', function () {
    const dir = sandbox();
    try {
      const calls = [];
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile: path.join(dir, 'aod', 'service.json'),
        execFileSync: (...a) => { calls.push(a); return Buffer.from(''); },
        spawnSync: () => ({ status: 0, stdout: '' }),
      });
      const entry = fakeEntry(dir);
      const result = inst.install(entry, { serverArgs: ['--port', '8888', '--auth', 'sekret'] });
      assert.deepStrictEqual(result.serverArgs, ['--port', '8888']);
      const xml = fs.readFileSync(result.taskXml, 'utf16le').replace(/^﻿/, '');
      assert.ok(!xml.includes('sekret'), 'secret not in task xml');
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'aod', 'service.json'), 'utf8'));
      assert.ok(!JSON.stringify(meta).includes('sekret'), 'secret not in service.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('win11/install lifecycle', function () {
  it('writes UTF-16LE+BOM and runs create then run', function () {
    const dir = sandbox();
    try {
      const calls = [];
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile: path.join(dir, 'aod', 'service.json'),
        execFileSync: (...a) => { calls.push(a); return Buffer.from(''); },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      });
      const entry = fakeEntry(dir);
      const result = inst.install(entry, { serverArgs: ['--port', '8888'] });
      assert.ok(result.taskXml.endsWith('ai-or-die-task.xml'));
      const raw = fs.readFileSync(result.taskXml);
      assert.strictEqual(raw[0], 0xFF, 'BOM lo');
      assert.strictEqual(raw[1], 0xFE, 'BOM hi');
      const text = raw.toString('utf16le').replace(/^﻿/, '');
      assert.ok(text.startsWith('<?xml'), 'xml decodes');
      const verbs = calls.filter((c) => c[0] === 'schtasks').map((c) => c[1][0]);
      assert.deepStrictEqual(verbs, ['/create', '/run'], 'create then run');
      assert.ok(result.nodePath, 'node baked into result');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reinstall with identical content is a no-op (no daemon restart)', function () {
    const dir = sandbox();
    try {
      let n = 0;
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile: path.join(dir, 'aod', 'service.json'),
        execFileSync: (...a) => { n += 1; return Buffer.from(''); },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      });
      const entry = fakeEntry(dir);
      const first = inst.install(entry, { serverArgs: ['--port', '8888'] });
      assert.strictEqual(first.unchanged, undefined);
      const before = n;
      const second = inst.install(entry, { serverArgs: ['--port', '8888'] });
      assert.strictEqual(second.unchanged, true);
      assert.strictEqual(n, before, 'no OS calls on identical reinstall');
      const third = inst.install(entry, { serverArgs: ['--port', '9999'] });
      assert.strictEqual(third.unchanged, undefined, 'changed args reinstall');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uninstall ends before delete and removes the xml', function () {
    const dir = sandbox();
    try {
      const calls = [];
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile: path.join(dir, 'aod', 'service.json'),
        execFileSync: (...a) => { calls.push(a); return Buffer.from(''); },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      });
      const entry = fakeEntry(dir);
      const result = inst.install(entry, {});
      assert.ok(fs.existsSync(result.taskXml));
      inst.uninstall();
      const verbs = calls.filter((c) => c[0] === 'schtasks').map((c) => c[1][0]);
      assert.ok(verbs.indexOf('/end') !== -1 && verbs.indexOf('/delete') !== -1, 'end + delete');
      assert.ok(verbs.indexOf('/end') < verbs.lastIndexOf('/delete'), '/end before /delete');
      assert.ok(!fs.existsSync(result.taskXml), 'xml cleaned');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back the xml when schtasks is missing', function () {
    const dir = sandbox();
    try {
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile: path.join(dir, 'aod', 'service.json'),
        execFileSync: () => { const e = new Error('spawn schtasks ENOENT'); e.code = 'ENOENT'; throw e; },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      });
      const entry = fakeEntry(dir);
      assert.throws(() => inst.install(entry, {}), /schtasks|service manager/i);
      assert.ok(!fs.existsSync(path.join(dir, 'aod', 'ai-or-die-task.xml')), 'xml rolled back');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('win11/status', function () {
  function statusWith(output) {
    const dir = sandbox();
    const inst = new ServiceInstaller({
      platform: 'win32',
      homedir: path.join(dir, 'home'),
      baseDir: path.join(dir, 'aod'),
      stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
      metaFile: path.join(dir, 'aod', 'service.json'),
      execFileSync: () => Buffer.from(output),
      spawnSync: () => ({ status: 0, stdout: '' }),
    });
    return { dir, inst };
  }

  it('Running -> installed+active; Ready -> installed, inactive', function () {
    const a = statusWith('HostName: X\r\nTaskName: \\ai-or-die\r\nStatus: Running\r\n');
    try {
      const s = a.inst.status();
      assert.strictEqual(s.installed, true);
      assert.strictEqual(s.active, true);
      assert.strictEqual(s.taskState, 'Running');
    } finally { fs.rmSync(a.dir, { recursive: true, force: true }); }
    const b = statusWith('HostName: X\r\nTaskName: \\ai-or-die-running-backup\r\nStatus: Ready\r\n');
    try {
      const s = b.inst.status();
      // "ai-or-die-running-backup" in TaskName must NOT count as Running.
      assert.strictEqual(s.installed, true);
      assert.strictEqual(s.active, false);
      assert.strictEqual(s.taskState, 'Ready');
    } finally { fs.rmSync(b.dir, { recursive: true, force: true }); }
  });

  it('missing task -> not installed', function () {
    const dir = sandbox();
    try {
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile: path.join(dir, 'aod', 'service.json'),
        execFileSync: () => { throw new Error('ERROR: The system cannot find the file specified.'); },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      });
      const s = inst.status();
      assert.strictEqual(s.installed, false);
      assert.strictEqual(s.active, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('win11/stable tree + sentinel', function () {
  it('stages the require closure so the service can boot', function () {
    const dir = sandbox();
    try {
      const inst = installerFor('linux', dir);
      const entry = fakeEntry(dir);
      const result = inst.ensureStableBinary(entry);
      assert.strictEqual(result.copied, true);
      for (const rel of [
        path.join('bin', 'ai-or-die-supervisor.js'),
        path.join('src', 'supervisor', 'index.js'),
        path.join('src', 'supervisor', 'server-manager.js'),
        path.join('src', 'keepalive-manager.js'),
        path.join('src', 'job-guard.js'),
        path.join('src', 'utils', 'process-tree.js'),
      ]) {
        assert.ok(fs.existsSync(path.join(dir, 'aod', rel)), `staged ${rel}`);
      }
      // The staged entry's relative require resolves inside the stage.
      const idx = path.join(dir, 'aod', 'src', 'supervisor', 'index.js');
      assert.ok(fs.existsSync(idx));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws (no dangling unit) when the entry is missing', function () {
    const dir = sandbox();
    try {
      const inst = installerFor('linux', dir);
      assert.throws(
        () => inst.ensureStableBinary(path.join(dir, 'nope', 'supervisor-service.js')),
        /requires the supervisor entry file/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isServiceRuntime: env OR sentinel, never throws', function () {
    const dir = sandbox();
    try {
      process.env.AIORDIE_SERVICE = '1';
      assert.strictEqual(isServiceRuntime(), true);
      delete process.env.AIORDIE_SERVICE;
      const stable = path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js');
      const meta = path.join(dir, 'aod', 'service.json');
      fs.mkdirSync(path.dirname(stable), { recursive: true });
      fs.writeFileSync(stable, '// staged');
      fs.writeFileSync(meta, '{}');
      assert.strictEqual(
        isServiceRuntime({ argv1: stable, baseDir: path.join(dir, 'aod') }),
        true,
        'sentinel detects Task-launched service without env'
      );
      assert.strictEqual(
        isServiceRuntime({ argv1: '/some/other.js', baseDir: path.join(dir, 'aod') }),
        false
      );
    } finally {
      delete process.env.AIORDIE_SERVICE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supervisorVersion falls back outside a checkout', function () {
    assert.ok(supervisorVersion(), 'has version');
  });
});

describe('win11/units (systemd/launchd) + entry + bins', function () {
  it('systemd: quoted ExecStart with args, log redirect, no blocking Pre', function () {
    const dir = sandbox();
    try {
      const inst = installerFor('linux', dir, { nodePath: '/usr/bin/node' });
      const unit = inst.buildUnit('/home/u/.ai-or-die/bin/ai-or-die-supervisor.js', {
        serverArgs: ['--port', '8888', '--mesh'],
      });
      assert.ok(!unit.includes('sleep infinity'), 'fatal ExecStartPre removed');
      assert.ok(!unit.includes('ExecStartPre'), 'no blocking Pre at all');
      assert.ok(unit.includes('WorkingDirectory=%h'));
      assert.ok(unit.includes('StandardOutput=append:'), 'logs wired');
      assert.ok(unit.includes('--port') && unit.includes('--mesh'), 'args persisted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('launchd: PATH, log paths, Standard tier, no dead calendar tick', function () {
    const dir = sandbox();
    try {
      const inst = installerFor('darwin', dir);
      const plist = inst.buildUnit('/Users/u/.ai-or-die/bin/ai-or-die-supervisor.js', {
        serverArgs: ['--port', '8888'],
      });
      assert.ok(plist.includes('<key>PATH</key>'), 'cli discovery path');
      assert.ok(plist.includes('/opt/homebrew/bin'), 'homebrew covered');
      assert.ok(plist.includes('StandardOutPath'), 'stdout captured');
      assert.ok(plist.includes('<string>Standard</string>'), 'not Background-throttled');
      assert.ok(!plist.includes('StartCalendarInterval'), 'dead hourly tick removed');
      assert.ok(plist.includes('--port'), 'args persisted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supervisor-service entry defaults to STABLE_SERVER_BIN (exists post-stage)', function () {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'supervisor-service.js'), 'utf8');
    assert.ok(src.includes('STABLE_SERVER_BIN'), 'uses stable server binary');
    assert.ok(!src.includes("path.join(__dirname, 'ai-or-die.js')"), 'no dangling sibling default');
    assert.ok(src.includes('uncaughtException'), 'never-exit guard');
  });

  it('both packaged bins route `service` through the shared handler', function () {
    for (const bin of ['bin/supervisor.js', 'bin/ai-or-die.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', bin), 'utf8');
      assert.ok(src.includes('service-cli'), `${bin} uses shared service handler`);
    }
  });
});

describe('win11/service logging', function () {
  afterEach(function () {
    try { teardownLogging(); } catch (_) {}
  });

  it('tees console to the log file', async function () {
    const dir = sandbox();
    try {
      const logFile = path.join(dir, 'logs', 'supervisor.log');
      // Fresh module state per test via cache bust.
      delete require.cache[require.resolve('../src/supervisor/service-logging.js')];
      const logging = require('../src/supervisor/service-logging.js');
      const r = logging.setupFileLogging({ logFile });
      assert.strictEqual(r.active, true);
      console.log('win11-logging-probe-line');
      await new Promise((res) => setTimeout(res, 100));
      const text = fs.readFileSync(logFile, 'utf8');
      assert.ok(text.includes('win11-logging-probe-line'), 'tee wrote the line');
      assert.strictEqual(logging.isHealthy(), true);
      logging.teardown();
    } finally {
      try { teardownLogging(); } catch (_) {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maybeRotate truncates an over-limit log (copy-truncate, never rename)', function () {
    const dir = sandbox();
    const prevMax = process.env.AIORDIE_LOG_MAX_BYTES;
    const prevKeep = process.env.AIORDIE_LOG_KEEP_BYTES;
    try {
      // Small limits keep this test light on all platforms.
      process.env.AIORDIE_LOG_MAX_BYTES = String(64 * 1024);
      process.env.AIORDIE_LOG_KEEP_BYTES = String(16 * 1024);
      delete require.cache[require.resolve('../src/supervisor/service-logging.js')];
      const logging = require('../src/supervisor/service-logging.js');
      const logFile = path.join(dir, 'supervisor.log');
      fs.writeFileSync(logFile, Buffer.alloc(128 * 1024, 'x'));
      logging.maybeRotate(logFile);
      const st = fs.statSync(logFile);
      assert.ok(st.size < 128 * 1024, `rotated 131072 -> ${st.size}`);
    } finally {
      if (prevMax === undefined) delete process.env.AIORDIE_LOG_MAX_BYTES;
      else process.env.AIORDIE_LOG_MAX_BYTES = prevMax;
      if (prevKeep === undefined) delete process.env.AIORDIE_LOG_KEEP_BYTES;
      else process.env.AIORDIE_LOG_KEEP_BYTES = prevKeep;
      delete require.cache[require.resolve('../src/supervisor/service-logging.js')];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('win11/updater checksum gate', function () {
  it('refuses to swap a corrupted staged binary and self-heals', async function () {
    const { AutoUpdater } = require('../src/supervisor/autoupdater');
    const dir = sandbox();
    try {
      const staging = path.join(dir, 'staging');
      const serverBin = path.join(dir, 'bin', 'ai-or-die-server');
      fs.mkdirSync(staging, { recursive: true });
      const staged = path.join(staging, 'ai-or-die-server-9.9.9');
      fs.writeFileSync(staged, 'good-binary');
      let swapped = false;
      const fakeSupervisor = {
        swapServer: async () => { swapped = true; return { swapped: true }; },
      };
      const updater = new AutoUpdater({
        supervisor: fakeSupervisor,
        stagingDir: staging,
        serverBin,
        enabled: true,
      });
      const { sha256File } = AutoUpdater;
      const good = sha256File(staged);
      updater.pendingUpdate = { version: '9.9.9', binaryPath: staged, sha256: good, downloadedAt: Date.now() };
      const ok = await updater.apply();
      assert.strictEqual(ok.applied, true, 'clean staged binary applies');
      assert.strictEqual(swapped, true);
      assert.ok(fs.existsSync(serverBin), 'promoted atomically');

      swapped = false;
      fs.writeFileSync(staged, 'tampered-binary');
      updater.pendingUpdate = { version: '9.9.9', binaryPath: staged, sha256: good, downloadedAt: Date.now() };
      const bad = await updater.apply();
      assert.strictEqual(bad.applied, false, 'corrupt staged binary refused');
      assert.strictEqual(bad.reason, 'staged_checksum_mismatch');
      assert.strictEqual(swapped, false, 'never executed');
      assert.ok(!fs.existsSync(staged), 'tampered staged file discarded so next check re-stages');
      assert.strictEqual(updater.pendingUpdate, null, 'pending cleared');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maybeAutoApply vetoes while sessions are owned (conservative gate)', async function () {
    const { AutoUpdater } = require('../src/supervisor/autoupdater');
    const dir = sandbox();
    try {
      const updater = new AutoUpdater({
        supervisor: { ptyManager: { size: 2 }, swapServer: async () => ({ swapped: true }) },
        stagingDir: path.join(dir, 'staging'),
        serverBin: path.join(dir, 'bin', 's'),
        enabled: true,
      });
      updater.pendingUpdate = { version: '1', binaryPath: path.join(dir, 'x'), sha256: null, downloadedAt: 0 };
      updater._lastPtyActivityAt = Date.now() - 99999999; // long idle
      const r = await updater.maybeAutoApply();
      assert.strictEqual(r.applied, false);
      assert.strictEqual(r.reason, 'sessions_active');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
