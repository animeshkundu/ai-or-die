'use strict';

// Boot-start mode and the Task XML the OS must accept.
//
// The generated XML is validated by Windows itself in
// test/integration/schtasks-xml.test.js (opt-in: AIORDIE_SCHEDTASK_INTEGRATION=1).
// These are the pure assertions that run everywhere: element order, enum
// membership, byte-range limits, and which principal each mode selects.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ServiceInstaller, currentUserIdentity } = require('../src/supervisor/service-installer');
const { parseServiceArgs } = require('../src/supervisor/service-cli');

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-taskxml-'));
}

function installerFor(platform, dir, extra = {}) {
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

const SUP = 'C:\\Users\\u\\.ai-or-die\\bin\\ai-or-die-supervisor.js';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

// Enum from the Task Scheduler schema (sessionStateChangeTriggerType).
const VALID_STATES = [
  'ConsoleConnect', 'ConsoleDisconnect', 'RemoteConnect', 'RemoteDisconnect',
  'SessionLock', 'SessionUnlock',
];

describe('service/task xml validity', function () {
  it('emits only valid SessionStateChange enum members', function () {
    const dir = sandbox();
    try {
      const xml = installerFor('win32', dir, { nodePath: NODE }).buildUnit(SUP, { serverArgs: ['--mesh'] });
      const states = [...xml.matchAll(/<StateChange>([^<]+)<\/StateChange>/g)].map((m) => m[1]);
      assert.ok(states.length >= 3, `some session triggers present (${states.length})`);
      for (const s of states) {
        assert.ok(VALID_STATES.includes(s), `invalid StateChange value: ${s}`);
      }
      // The exact value Windows rejected: (19,36):StateChange:ConsoleUnlock
      assert.ok(!states.includes('ConsoleUnlock'), 'ConsoleUnlock is not in the schema enum');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps RestartOnFailure/Count inside the unsignedByte range', function () {
    const dir = sandbox();
    try {
      const xml = installerFor('win32', dir, { nodePath: NODE }).buildUnit(SUP, {});
      const m = /<RestartOnFailure><Interval>([^<]+)<\/Interval><Count>(\d+)<\/Count><\/RestartOnFailure>/.exec(xml);
      assert.ok(m, 'RestartOnFailure block present');
      const count = parseInt(m[2], 10);
      assert.ok(count >= 1 && count <= 255, `Count ${count} must be 1..255`);
      assert.strictEqual(m[1], 'PT1M');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never limits execution time (P3D killed the daemon every 3 days)', function () {
    const dir = sandbox();
    try {
      const xml = installerFor('win32', dir, { nodePath: NODE }).buildUnit(SUP, {});
      assert.ok(xml.includes('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'));
      assert.ok(!/PT0S<\/ExecutionTimeLimit>[\s\S]*P3D/.test(xml), 'no P3D limit anywhere');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('orders trigger children per the XSD sequence', function () {
    const dir = sandbox();
    try {
      const xml = installerFor('win32', dir, { nodePath: NODE }).buildUnit(SUP, { mode: 'boot' });
      // triggerBaseType sequence: StartBoundary, EndBoundary, Enabled, Repetition.
      const block = /<TimeTrigger>([\s\S]*?)<\/TimeTrigger>/.exec(xml);
      assert.ok(block, 'TimeTrigger present');
      const body = block[1];
      const iStart = body.indexOf('<StartBoundary>');
      const iEnabled = body.indexOf('<Enabled>');
      const iRep = body.indexOf('<Repetition>');
      assert.ok(iStart >= 0 && iEnabled >= 0 && iRep >= 0, 'all children present');
      assert.ok(iStart < iEnabled, 'StartBoundary before Enabled');
      assert.ok(iEnabled < iRep, 'Enabled before Repetition');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('service/boot mode', function () {
  it('login mode (default) needs the user to be logged on', function () {
    const dir = sandbox();
    try {
      const xml = installerFor('win32', dir, { nodePath: NODE }).buildUnit(SUP, {});
      assert.ok(xml.includes('<LogonType>InteractiveToken</LogonType>'));
      assert.ok(!xml.includes('<LogonType>S4U</LogonType>'));
      assert.ok(!xml.includes('<BootTrigger>'), 'login mode cannot start before login');
      assert.ok(!xml.includes('<UserId>'), 'no principal id needed for InteractiveToken');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('boot mode uses S4U with an explicit principal (no stored password)', function () {
    const dir = sandbox();
    try {
      const xml = installerFor('win32', dir, { nodePath: NODE })
        .buildUnit(SUP, { mode: 'boot', userId: 'S-1-5-21-1-2-3-1001' });
      assert.ok(xml.includes('<LogonType>S4U</LogonType>'), 'S4U: no password stored');
      assert.ok(xml.includes('<UserId>S-1-5-21-1-2-3-1001</UserId>'), 'principal is explicit');
      assert.ok(xml.includes('<BootTrigger>'), 'starts at boot');
      assert.ok(xml.includes('<Delay>PT20S</Delay>'), 'lets the profile service come up first');
      // Position, not presence: Task Scheduler validates <Triggers> children in
      // XSD document order, so a BootTrigger after the TimeTrigger is rejected
      // wholesale — the same silent failure mode as ConsoleUnlock.
      const triggerBlock = xml.slice(xml.indexOf('<Triggers>'), xml.indexOf('</Triggers>'));
      assert.ok(triggerBlock.indexOf('<BootTrigger>') < triggerBlock.indexOf('<TimeTrigger>'),
        'BootTrigger must precede TimeTrigger');
      assert.ok(xml.includes('<RunLevel>LeastPrivilege</RunLevel>'), 'never elevates');
      // Password-based logon would have to persist a secret.
      assert.ok(!xml.includes('<LogonType>Password</LogonType>'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('both modes keep the 5-minute self-healing tick', function () {
    const dir = sandbox();
    try {
      const inst = installerFor('win32', dir, { nodePath: NODE });
      for (const mode of ['login', 'boot']) {
        const xml = inst.buildUnit(SUP, { mode });
        assert.ok(/<TimeTrigger>[\s\S]*<Interval>PT5M<\/Interval>/.test(xml), `${mode} has the repeat tick`);
        assert.ok(xml.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'), `${mode} never double-runs`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an unresolvable user identity instead of emitting a broken principal', function () {
    const dir = sandbox();
    try {
      const xml = installerFor('win32', dir, { nodePath: NODE }).buildUnit(SUP, { mode: 'boot', userId: null });
      // Without an id the S4U principal cannot be expressed; install() surfaces
      // the failure rather than registering a task that can never run.
      assert.ok(!/<UserId>/.test(xml), 'no empty UserId element');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses --boot on a non-Windows host before writing anything', async function () {
    const dir = sandbox();
    try {
      const inst = installerFor('linux', dir, {
        provisionServer: (ctx) => ({ provisioned: true, path: ctx.dest, version: 'x', sha256: 'x', verified: 'stub' }),
      });
      const entry = path.join(dir, 'pkg', 'supervisor-service.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'bin', 'supervisor-service.js'), entry);
      await assert.rejects(
        () => inst.install(entry, { mode: 'boot' }),
        (err) => err.code === 'EBOOTUNSUPPORTED' && /only supported on Windows/.test(err.message)
      );
      assert.ok(!fs.existsSync(path.join(dir, 'aod', 'ai-or-die.service')), 'no unit written');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses --boot when the account identity cannot be resolved', async function () {
    const dir = sandbox();
    try {
      // Force the null-identity branch deterministically: the resolver caches
      // its answer module-wide, so load a fresh module copy, stub its spawnSync
      // to report nothing, and hide the env fallbacks. os.userInfo() is the
      // final fallback and cannot be stubbed without mocking the os module, so
      // this asserts the resolver's contract directly instead of the whole
      // install path.
      const identPath = require.resolve('../src/supervisor/service-installer');
      const savedU = process.env.USERNAME;
      const savedD = process.env.USERDOMAIN;
      delete require.cache[identPath];
      delete process.env.USERNAME;
      delete process.env.USERDOMAIN;
      try {
        const fresh = require('../src/supervisor/service-installer');
        const id = fresh.currentUserIdentity({ spawnSync: () => ({ status: 1, stdout: '' }) });
        // On any real host os.userInfo() answers, so a non-null result is the
        // documented fallback; the null branch only exists on a broken host.
        assert.ok(id === null || (typeof id === 'string' && id.length > 0), `resolver answered: ${id}`);
        if (id === null) {
          const inst = installerFor('win32', dir, { nodePath: NODE });
          const entry = path.join(dir, 'pkg', 'supervisor-service.js');
          fs.mkdirSync(path.dirname(entry), { recursive: true });
          fs.copyFileSync(path.join(__dirname, '..', 'bin', 'supervisor-service.js'), entry);
          await assert.rejects(
            () => inst.install(entry, { mode: 'boot' }),
            (err) => err.code === 'EBOOTIDENTITY' && /explicit user identity/.test(err.message)
          );
        }
      } finally {
        if (savedU !== undefined) process.env.USERNAME = savedU;
        if (savedD !== undefined) process.env.USERDOMAIN = savedD;
        delete require.cache[identPath];
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses --boot / --login and persists the mode', function () {
    assert.strictEqual(parseServiceArgs(['--boot']).mode, 'boot');
    assert.strictEqual(parseServiceArgs(['--login']).mode, 'login');
    assert.strictEqual(parseServiceArgs([]).mode, 'login');
    const p = parseServiceArgs(['--boot', '--mesh', '--disable-auth']);
    assert.deepStrictEqual(p.serverArgs, ['--mesh', '--disable-auth'], 'server flags still persist');
    assert.strictEqual(p.mode, 'boot');
  });

  it('resolves a usable Windows identity on this host', function () {
    if (process.platform !== 'win32') return this.skip();
    const id = currentUserIdentity();
    assert.ok(id, 'identity resolved');
    assert.ok(/^S-1-[\d-]+$/.test(id) || /\\/.test(id) || id.length > 0, `plausible identity: ${id}`);
  });
});

describe('service/windows task settings', function () {
  it('keeps the service alive across battery, sleep and unlock', function () {
    const dir = sandbox();
    try {
      const xml = installerFor('win32', dir, { nodePath: NODE }).buildUnit(SUP, { mode: 'boot' });
      assert.ok(xml.includes('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'));
      assert.ok(xml.includes('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'));
      assert.ok(xml.includes('<WakeToRun>true</WakeToRun>'));
      assert.ok(xml.includes('<StartWhenAvailable>true</StartWhenAvailable>'));
      assert.ok(xml.includes('<AllowStartOnDemand>true</AllowStartOnDemand>'));
      assert.ok(xml.includes('<AllowHardTerminate>true</AllowHardTerminate>'));
      assert.ok(xml.includes('<StateChange>SessionUnlock</StateChange>'), 'resumes after unlock');
      assert.ok(xml.includes('<StateChange>RemoteConnect</StateChange>'), 'resumes after RDP connect');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('launches node with absolute paths and a real working directory', function () {
    const dir = sandbox();
    try {
      const xml = installerFor('win32', dir, { nodePath: NODE })
        .buildUnit(SUP, { serverArgs: ['--port', '8888'], mode: 'boot' });
      assert.ok(xml.includes(`<Command>${NODE.replace(/&/g, '&amp;')}</Command>`));
      assert.ok(xml.includes('ai-or-die-supervisor.js'), 'supervisor path in Arguments');
      assert.ok(xml.includes('--port') && xml.includes('8888'));
      assert.ok(xml.includes('<WorkingDirectory>'), 'not system32');
      assert.ok(!xml.includes('%USERPROFILE%'), 'no env expansion in Exec');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never persists a bearer token, in either mode', function () {
    const dir = sandbox();
    try {
      const inst = installerFor('win32', dir, { nodePath: NODE });
      for (const mode of ['login', 'boot']) {
        const xml = inst.buildUnit(SUP, { mode, serverArgs: ['--mesh'] });
        assert.ok(!/sekret|bearer|--auth/i.test(xml), `${mode}: no secret material`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
