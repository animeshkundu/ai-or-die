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
    // Never download in unit tests: install() provisions the Server binary
    // before writing the unit, and a 166 MB fetch is not a unit test.
    provisionServer: (ctx) => ({
      provisioned: true,
      path: ctx.dest,
      version: '0.1.112',
      sha256: 'stub',
      verified: 'stub',
      releaseTag: 'v0.1.112',
    }),
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
      // Valid StateChange enum members only. ConsoleUnlock is not one of them:
      // schtasks rejects the entire XML with (19,36):StateChange:ConsoleUnlock.
      assert.ok(xml.includes('<StateChange>ConsoleConnect</StateChange>'));
      assert.ok(xml.includes('<StateChange>SessionUnlock</StateChange>'));
      assert.ok(xml.includes('<StateChange>RemoteConnect</StateChange>'));
      assert.ok(!xml.includes('ConsoleUnlock'), 'never emits the invalid enum');
      assert.ok(!xml.includes('<BootTrigger>'), 'login mode does not boot-start');
      assert.ok(xml.includes('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'));
      assert.ok(xml.includes('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'));
      assert.ok(xml.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'));
      assert.ok(xml.includes('<AllowHardTerminate>true</AllowHardTerminate>'));
      // RestartOnFailure/Count is xsd:unsignedByte (1-255); 999 is rejected.
      assert.ok(xml.includes('<Count>255</Count>'), 'restart backstop within range');
      // PT0S = no time limit. P3D silently killed the daemon every 3 days.
      assert.ok(xml.includes('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'));
      assert.ok(!xml.includes('<ExecutionTimeLimit>P3D</ExecutionTimeLimit>'));
      // 5-minute self-healing tick; a no-op while an instance runs.
      assert.ok(/<TimeTrigger>[\s\S]*<Interval>PT5M<\/Interval>/.test(xml), 'repeat trigger');
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

  it('never persists --auth into the unit', async function () {
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
        provisionServer: (ctx) => ({ provisioned: true, path: ctx.dest, version: null, sha256: null, verified: 'stub', releaseTag: null }),
      });
      const entry = fakeEntry(dir);
      const result = await inst.install(entry, { serverArgs: ['--port', '8888', '--auth', 'sekret'] });
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
  it('writes UTF-16LE+BOM and runs create then run', async function () {
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
        provisionServer: (ctx) => ({ provisioned: true, path: ctx.dest, version: '0.1.112', sha256: 'stub', verified: 'stub', releaseTag: 'v0.1.112' }),
      });
      const entry = fakeEntry(dir);
      const result = await inst.install(entry, { serverArgs: ['--port', '8888'] });
      assert.ok(result.taskXml.endsWith('ai-or-die-task.xml'));
      const raw = fs.readFileSync(result.taskXml);
      assert.strictEqual(raw[0], 0xFF, 'BOM lo');
      assert.strictEqual(raw[1], 0xFE, 'BOM hi');
      const text = raw.toString('utf16le').replace(/^﻿/, '');
      assert.ok(text.startsWith('<?xml'), 'xml decodes');
      const schtasks = calls.filter((c) => c[0] === 'schtasks').map((c) => c[1]);
      const taskName = (args) => args[args.indexOf('/tn') + 1];
      // /query is read-only diagnosis, so it is filtered rather than asserted:
      // install probes the task to decide whether a live daemon must be stopped
      // first, and the exact probe count is not this test's contract.
      const serviceVerbs = schtasks
        .filter((a) => taskName(a) === 'ai-or-die')
        .map((a) => a[0])
        .filter((v) => v !== '/query');
      assert.ok(serviceVerbs.includes('/create'), `the task is registered: ${serviceVerbs.join(',')}`);
      assert.ok(
        serviceVerbs.indexOf('/create') < serviceVerbs.indexOf('/run'),
        `create then run (saw ${serviceVerbs.join(',')})`
      );
      // The watchdog is a separate task in both modes, so it must be created
      // from the same install (uninstall removes it again).
      assert.ok(
        schtasks.some((a) => a[0] === '/create' && taskName(a) === 'ai-or-die-watchdog'),
        'watchdog task registered'
      );
      assert.ok(result.nodePath, 'node baked into result');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reinstall with identical content does not restart a running daemon', async function () {
    const dir = sandbox();
    try {
      const verbs = [];
      // The task reports Running, so an identical reinstall must not /create,
      // /end or /run anything: a restart would kill live PTYs for no reason.
      // Only the SERVICE task matters here; the watchdog is re-registered on
      // every install by design and never touches live PTYs.
      const serviceVerbs = (a) => a[0] === 'schtasks' && a[1][a[1].indexOf('/tn') + 1] === 'ai-or-die';
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile: path.join(dir, 'aod', 'service.json'),
        execFileSync: (...a) => {
          if (serviceVerbs(a)) {
            verbs.push(a[1][0]);
            if (a[1][0] === '/query') {
              // A real `/end` is followed by the task reporting Ready, and the
              // stop poll depends on that: answering "Running" forever burns its
              // whole 5s budget and looks like a hang. Same shape as the real
              // command, so the /end-then-Ready sequence is exercised here.
              const status = verbs.includes('/end') ? 'Ready' : 'Running';
              return Buffer.from(`TaskName:      \\ai-or-die\r\nStatus:        ${status}\r\n`);
            }
          }
          return Buffer.from('');
        },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        provisionServer: (ctx) => ({ provisioned: true, path: ctx.dest, version: '0.1.112', sha256: 'stub', verified: 'stub', releaseTag: 'v0.1.112' }),
      });
      const entry = fakeEntry(dir);
      const first = await inst.install(entry, { serverArgs: ['--port', '8888'] });
      assert.strictEqual(first.unchanged, undefined);
      verbs.length = 0;
      const second = await inst.install(entry, { serverArgs: ['--port', '8888'] });
      assert.strictEqual(second.unchanged, true);
      assert.strictEqual(second.restarted, 'running');
      for (const verb of ['/create', '/run', '/end']) {
        assert.ok(!verbs.includes(verb), `no ${verb} on an identical reinstall (saw ${verbs.join(',')})`);
      }
      const third = await inst.install(entry, { serverArgs: ['--port', '9999'] });
      assert.strictEqual(third.unchanged, undefined, 'changed args reinstall');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a supervisor-tree upgrade re-creates the task even with identical args', async function () {
    const dir = sandbox();
    try {
      const verbs = [];
      const serviceVerbs = (a) => a[0] === 'schtasks' && a[1][a[1].indexOf('/tn') + 1] === 'ai-or-die';
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile: path.join(dir, 'aod', 'service.json'),
        execFileSync: (...a) => {
          if (serviceVerbs(a)) {
            verbs.push(a[1][0]);
            if (a[1][0] === '/query') {
              // A real `/end` is followed by the task reporting Ready, and the
              // stop poll depends on that: answering "Running" forever burns its
              // whole 5s budget and looks like a hang. Same shape as the real
              // command, so the /end-then-Ready sequence is exercised here.
              const status = verbs.includes('/end') ? 'Ready' : 'Running';
              return Buffer.from(`TaskName:      \\ai-or-die\r\nStatus:        ${status}\r\n`);
            }
          }
          return Buffer.from('');
        },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        provisionServer: (ctx) => ({ provisioned: true, path: ctx.dest, version: '0.1.112', sha256: 'stub', verified: 'stub', releaseTag: 'v0.1.112' }),
      });
      const entry = fakeEntry(dir);
      await inst.install(entry, { serverArgs: ['--port', '8888'] });
      // Represent an install performed by an OLDER package: the task XML is
      // byte-identical, args and node are identical, only the recorded bundle
      // version differs. Without comparing against the version captured BEFORE
      // staging (ensureStableBinary re-stamps it), this reads back as a no-op
      // and the new supervisor code never starts.
      const metaFile = path.join(dir, 'aod', 'service.json');
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      fs.writeFileSync(metaFile, JSON.stringify({ ...meta, bundleVersion: '0.0.1' }));
      verbs.length = 0;
      const upgraded = await inst.install(entry, { serverArgs: ['--port', '8888'] });
      assert.notStrictEqual(upgraded.unchanged, true, 'an upgrade is not a no-op');
      assert.ok(verbs.includes('/create'), `task re-created on upgrade (saw ${verbs.join(',')})`);
      // And the recorded version is the current one again.
      const after = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      assert.notStrictEqual(after.bundleVersion, '0.0.1');
      assert.ok(!('prevBundleVersion' in after), 'comparison scaffolding never persisted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reinstall on a dead daemon starts it instead of leaving it down', async function () {
    const dir = sandbox();
    try {
      const verbs = [];
      // Only the SERVICE task matters here; the watchdog is re-registered on
      // every install by design and never touches live PTYs.
      const serviceVerbs = (a) => a[0] === 'schtasks' && a[1][a[1].indexOf('/tn') + 1] === 'ai-or-die';
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile: path.join(dir, 'aod', 'service.json'),
        execFileSync: (...a) => {
          if (serviceVerbs(a)) {
            verbs.push(a[1][0]);
            if (a[1][0] === '/query') return Buffer.from('Status:        Ready\r\n');
          }
          return Buffer.from('');
        },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        provisionServer: (ctx) => ({ provisioned: true, path: ctx.dest, version: '0.1.112', sha256: 'stub', verified: 'stub', releaseTag: 'v0.1.112' }),
      });
      const entry = fakeEntry(dir);
      await inst.install(entry, { serverArgs: ['--port', '8888'] });
      verbs.length = 0;
      const second = await inst.install(entry, { serverArgs: ['--port', '8888'] });
      assert.strictEqual(second.unchanged, true);
      assert.strictEqual(second.restarted, 'started');
      assert.ok(verbs.includes('/run'), 'a stopped task is started');
      assert.ok(!verbs.includes('/create'), 'the definition is not re-registered');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uninstall ends before delete and removes the xml', async function () {
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
        provisionServer: (ctx) => ({ provisioned: true, path: ctx.dest, version: '0.1.112', sha256: 'stub', verified: 'stub', releaseTag: 'v0.1.112' }),
      });
      const entry = fakeEntry(dir);
      const result = await inst.install(entry, {});
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

  it('rolls back the xml when schtasks is missing', async function () {
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
        provisionServer: (ctx) => ({ provisioned: true, path: ctx.dest, version: '0.1.112', sha256: 'stub', verified: 'stub', releaseTag: 'v0.1.112' }),
      });
      const entry = fakeEntry(dir);
      await assert.rejects(() => inst.install(entry, {}), /schtasks|service manager/i);
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

  it('status reports the live server identity from the heartbeat payload', function () {
    const dir = sandbox();
    try {
      const base = path.join(dir, 'aod');
      fs.mkdirSync(path.join(base, 'run'), { recursive: true });
      fs.writeFileSync(path.join(base, 'service.json'), JSON.stringify({
        platform: 'win32', mode: 'boot', userId: 'S-1-5-21-1', serverArgs: ['--port', '7777'],
        serverBinary: path.join(base, 'bin', 'ai-or-die-server.exe'), serverVersion: '0.1.112',
        installedAt: '2026-01-01T00:00:00.000Z',
      }));
      // The heartbeat shape index.js actually writes: identity nested in
      // `status`, not at the top level.
      fs.writeFileSync(path.join(base, 'run', 'heartbeat.json'), JSON.stringify({
        pid: 4242, phase: 'ready', updatedAt: new Date().toISOString(), updatedAtMs: Date.now(),
        status: { serverPid: 5151, serverVersion: '0.1.112', version: '0.1.112', ptys: 2 },
      }));
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: base,
        stableSupervisor: path.join(base, 'bin', 'ai-or-die-supervisor.js'),
        metaFile: path.join(base, 'service.json'),
        execFileSync: (cmd, args) => {
          if (cmd === 'schtasks' && args && args[0] === '/query') {
            if (String(args[2]).includes('watchdog')) throw new Error('not found');
            return Buffer.from('HostName: X\r\nTaskName: \\ai-or-die\r\nStatus: Running\r\n');
          }
          return Buffer.from('');
        },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      });
      const s = inst.status();
      assert.strictEqual(s.mode, 'boot');
      assert.strictEqual(s.userId, 'S-1-5-21-1');
      assert.strictEqual(s.heartbeat.present, true);
      assert.strictEqual(s.heartbeat.phase, 'ready');
      // These three were permanently null when read off the top level.
      assert.strictEqual(s.heartbeat.serverPid, 5151);
      assert.strictEqual(s.heartbeat.serverVersion, '0.1.112');
      assert.strictEqual(s.heartbeat.ptys, 2);
      assert.strictEqual(s.serverBinary, path.join(base, 'bin', 'ai-or-die-server.exe'));
      assert.strictEqual(s.watchdog.installed, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('every entry point routes `service` through the shared handler', function () {
    // bin/supervisor-service.js matters most: the watchdog task invokes it as
    // `node <supervisor-service> service watchdog`, and without the
    // interception those argv would boot a second supervisor instead.
    for (const bin of ['bin/supervisor.js', 'bin/ai-or-die.js', 'bin/supervisor-service.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', bin), 'utf8');
      assert.ok(src.includes('handleServiceArgv'), `${bin} uses the shared service handler`);
    }
    // The interception must fail CLOSED. A synchronous throw here (incomplete
    // staged service-cli closure) used to fall through and boot a second
    // supervisor; on the 5-minute watchdog task that fights the daemon for the
    // port. The catch has to exit, never continue into the boot.
    const entry = fs.readFileSync(path.join(__dirname, '..', 'bin', 'supervisor-service.js'), 'utf8');
    const guard = /handleServiceArgv[\s\S]*?\} catch \(([\s\S]*?)\n\}/.exec(entry);
    assert.ok(guard, 'the service interception is wrapped in try/catch');
    assert.ok(
      guard[1].includes('process.exit(1)'),
      `the catch on the service path must exit instead of booting a supervisor: ${guard[1]}`
    );
    assert.ok(
      !/catch \(_\) \{ \/\* fall through/.test(entry),
      'the silent fall-through on the service path is gone'
    );
  });

  it('fails closed when the service handler throws instead of booting a supervisor', function () {
    // Executed, not grepped: the old `catch (_) { /* fall through */ }` booted a
    // SECOND supervisor from the watchdog task, which then fights the running
    // daemon for the port every 5 minutes.
    const dir = sandbox();
    try {
      const root = path.join(dir, 'tree');
      const srcDir = path.join(root, 'src', 'supervisor');
      const binDir = path.join(root, 'bin');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.copyFileSync(
        path.join(__dirname, '..', 'bin', 'supervisor-service.js'),
        path.join(binDir, 'supervisor-service.js')
      );
      // The install defect under test: a staged service-cli closure that throws
      // while being required.
      fs.writeFileSync(path.join(srcDir, 'service-cli.js'), "throw new Error('staged closure incomplete');\n");
      // Stubs whose only job is to prove the supervisor was (not) started.
      fs.writeFileSync(
        path.join(srcDir, 'index.js'),
        "class Supervisor { constructor() {} start() { console.log('[supervisor] STARTED'); return Promise.resolve(); } }\n"
        + 'module.exports = { Supervisor };\n'
      );
      fs.writeFileSync(
        path.join(srcDir, 'constants.js'),
        "module.exports = { STABLE_SERVER_BIN: '/nonexistent/server', supervisorVersion: () => '0.0.0', SERVICE_META_FILE: 'no-such-file.json' };\n"
      );
      fs.writeFileSync(
        path.join(srcDir, 'service-logging.js'),
        'module.exports = { setupFileLogging: () => ({ active: false }) };\n'
      );
      const { spawnSync } = require('child_process');
      const run = (argv) => spawnSync(process.execPath, [path.join(binDir, 'supervisor-service.js'), ...argv], {
        encoding: 'utf8', timeout: 20000, cwd: dir, env: { ...process.env, AI_OR_DIE_HOME: path.join(dir, 'aod') },
      });
      const serviced = run(['service', 'watchdog']);
      assert.strictEqual(serviced.status, 1, `service path exits 1 (got ${serviced.status})`);
      assert.ok(/fail closed/.test(serviced.stderr || ''), `the reason is logged: ${serviced.stderr}`);
      assert.ok(
        !/\[supervisor\] STARTED/.test(serviced.stdout || ''),
        'no supervisor was booted in place of the service command'
      );
      // Control: without `service` argv the same tree MUST boot the supervisor,
      // otherwise this test would pass on a file that never starts anything.
      const normal = run(['--port', '1234']);
      assert.ok(/\[supervisor\] STARTED/.test(normal.stdout || ''), `normal path still boots: ${normal.stdout}${normal.stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the staged entry runs the watchdog verb without starting a supervisor', function () {
    // Prove it by execution, not by substring: the staged entry must handle
    // `service watchdog` itself.
    const dir = sandbox();
    try {
      const base = path.join(dir, 'aod');
      const inst = installerFor('win32', dir);
      const staged = inst.ensureStableBinary(path.join(__dirname, '..', 'bin', 'supervisor-service.js'));
      assert.ok(staged.path.startsWith(base), 'staged under the sandbox base');
      const { execFileSync } = require('child_process');
      let out = '';
      try {
        out = execFileSync(process.execPath, [staged.path, 'service', 'watchdog', '--dry-run'], {
          encoding: 'utf8',
          timeout: 20000,
          env: { ...process.env, AI_OR_DIE_HOME: base, AIORDIE_SERVICE_NAME: 'aod-staged-probe' },
        });
      } catch (err) {
        out = String((err && (err.stdout || err.message)) || '');
      }
      // The watchdog on a POSIX host (or a win32 host with nothing installed)
      // answers with its JSON verdict; either way it must NOT be a supervisor
      // start-up banner.
      assert.ok(/not-applicable|heartbeat-fresh|would-restart|debounced|booting|healthy-but-stale/.test(out), `watchdog ran: ${out.slice(0, 400)}`);
      assert.ok(!/\[supervisor\]/.test(out), 'no supervisor was started');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
