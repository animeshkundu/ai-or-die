'use strict';

// REAL Task Scheduler validation of the generated XML.
//
// Every other task-XML test asserts substrings, which is exactly how
// `StateChange:ConsoleUnlock` and `Count:999` shipped: both are invalid, both
// pass a substring assertion, and both make `schtasks /create` reject the WHOLE
// definition. This suite hands the file to Windows and asks the OS.
//
// Opt-in because it mutates the task store:
//   AIORDIE_SCHEDTASK_INTEGRATION=1
// It creates, queries and deletes uniquely-named probe tasks, so it never
// touches a real `ai-or-die` install.
//
// Note: `schtasks /create` requires a session token that is allowed to register
// tasks. In a restricted/sandboxed agent session it fails with
// `ERROR: Access is denied.` for EVERY task, including a trivial one; run this
// from a normal interactive PowerShell window.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { ServiceInstaller } = require('../../src/supervisor/service-installer');

const ENABLED = process.env.AIORDIE_SCHEDTASK_INTEGRATION === '1';
const isWin = process.platform === 'win32';

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-schtasks-'));
}

function writeXml(dir, xml, name) {
  const file = path.join(dir, `${name}.xml`);
  fs.writeFileSync(file, '\ufeff' + xml.replace(/^\ufeff+/, ''), 'utf16le');
  return file;
}

function schtasks(args) {
  return execFileSync('schtasks', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function probeTaskName(suffix) {
  return `aod-xml-probe-${process.pid}-${suffix}`;
}

(ENABLED && isWin ? describe : describe.skip)('integration/schtasks xml acceptance', function () {
  this.timeout(60000);

  let dir;
  let inst;
  let sup;

  // Task registration needs a session token that the Task Scheduler service
  // accepts. Restricted/sandboxed sessions get `ERROR: Access is denied.` for
  // EVERY create, including a trivial one, which would make the negative
  // controls pass for the wrong reason. Detect that once and skip loudly.
  let denied = null;

  before(function () {
    const probe = `aod-xml-preflight-${process.pid}`;
    try {
      execFileSync('schtasks', ['/create', '/tn', probe, '/tr', 'notepad.exe', '/sc', 'onlogon', '/f'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      try { execFileSync('schtasks', ['/delete', '/tn', probe, '/f'], { stdio: 'ignore' }); } catch (_) { /* ignore */ }
    } catch (err) {
      const msg = String((err && (err.stderr || err.message)) || '');
      if (/access is denied/i.test(msg)) {
        denied = `schtasks /create is denied in this session (${msg.trim()}); ` +
          'run this suite from a normal interactive PowerShell window';
      } else {
        throw err;
      }
    }
    if (denied) {
      // Mocha's "pending" list does not carry a skip reason, so print it: a
      // silent skip here would look identical to "the XML is valid".
      console.warn(`\n[schtasks-xml] SKIPPED — ${denied}\n`);
      this.skip(denied);
    }
  });

  beforeEach(function () {
    if (denied) {
      // Mocha's "pending" list does not carry a skip reason, so print it: a
      // silent skip here would look identical to "the XML is valid".
      console.warn(`\n[schtasks-xml] SKIPPED — ${denied}\n`);
      this.skip(denied);
    }
    dir = sandbox();
    inst = new ServiceInstaller({
      platform: 'win32',
      homedir: path.join(dir, 'home'),
      baseDir: path.join(dir, 'aod'),
      stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
      metaFile: path.join(dir, 'aod', 'service.json'),
      execFileSync: () => Buffer.from(''),
      spawnSync: () => ({ status: 0, stdout: '' }),
      logger: silent,
    });
    // The action path must exist? No: schtasks validates the XML and registers
    // the definition; a missing executable only fails at RUN time.
    sup = path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js');
  });

  afterEach(function () {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const mode of ['login', 'boot']) {
    it(`Windows accepts the ${mode}-mode task definition`, function () {
      const name = probeTaskName(mode);
      const xml = inst.buildUnit(sup, { serverArgs: ['--mesh', '--disable-auth'], mode });
      const file = writeXml(dir, xml, name);
      try {
        schtasks(['/create', '/tn', name, '/xml', file, '/f']);
        const query = schtasks(['/query', '/tn', name, '/fo', 'LIST', '/v']);
        assert.ok(query.includes(name), 'task registered');
        // The mode must be visible in the registered definition too.
        const dumped = schtasks(['/query', '/tn', name, '/xml', 'ONE']);
        if (mode === 'boot') {
          assert.ok(/S4U/.test(dumped), 'S4U principal survived registration');
          assert.ok(/BootTrigger/.test(dumped), 'boot trigger survived registration');
        } else {
          assert.ok(/InteractiveToken/.test(dumped), 'interactive principal survived registration');
        }
        assert.ok(!/ConsoleUnlock/.test(dumped), 'no invalid enum in the registered definition');
      } finally {
        try { schtasks(['/delete', '/tn', name, '/f']); } catch (_) { /* already gone */ }
      }
    });
  }

  it('confirms the historical values are really rejected (negative control)', function () {
    const name = probeTaskName('negative');
    const bad = inst.buildUnit(sup, { serverArgs: [] })
      .replace('<StateChange>ConsoleConnect</StateChange>', '<StateChange>ConsoleUnlock</StateChange>');
    const file = writeXml(dir, bad, name);
    try {
      assert.throws(
        () => schtasks(['/create', '/tn', name, '/xml', file, '/f']),
        (err) => {
          const msg = String((err && (err.stderr || err.message)) || '');
          // Must fail because of the bad ENUM, not because of permissions.
          assert.ok(!/access is denied/i.test(msg), `unexpected permission failure: ${msg}`);
          return /incorrectly formatted|out of range|ConsoleUnlock|malformed/i.test(msg);
        },
        'the OS rejects ConsoleUnlock (proves the fixed value matters)'
      );
    } finally {
      try { schtasks(['/delete', '/tn', name, '/f']); } catch (_) { /* never created */ }
    }
  });

  it('confirms Count above the unsignedByte range is rejected (negative control)', function () {
    const name = probeTaskName('count');
    const bad = inst.buildUnit(sup, { serverArgs: [] }).replace('<Count>255</Count>', '<Count>999</Count>');
    const file = writeXml(dir, bad, name);
    try {
      assert.throws(
        () => schtasks(['/create', '/tn', name, '/xml', file, '/f']),
        (err) => {
          const msg = String((err && (err.stderr || err.message)) || '');
          assert.ok(!/access is denied/i.test(msg), `unexpected permission failure: ${msg}`);
          return /incorrectly formatted|out of range|malformed|Count/i.test(msg);
        },
        'the OS rejects Count=999'
      );
    } finally {
      try { schtasks(['/delete', '/tn', name, '/f']); } catch (_) { /* never created */ }
    }
  });
});

if (!ENABLED || !isWin) {
  describe('integration/schtasks xml acceptance (skipped)', function () {
    it('is opt-in: set AIORDIE_SCHEDTASK_INTEGRATION=1 on Windows', function () {
      assert.ok(true);
    });
  });
}
