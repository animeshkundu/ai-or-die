'use strict';

// Rules for the installed service that the other suites do not cover:
// what happens on a NO-OP reinstall, and what happens when an install FAILS
// halfway. Both were silent-success paths: a byte-identical unit file proves
// nothing about a running daemon, and a failed install used to leave the new
// mode (and a newer bundle version) in the sentinel, so the retry looked like a
// no-op against the old code.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ServiceInstaller } = require('../src/supervisor/service-installer');

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-reinstall-'));
}

function fakeEntry(dir) {
  const entry = path.join(dir, 'pkg', 'supervisor-service.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'bin', 'supervisor-service.js'), entry);
  return entry;
}

function installerFor(platform, dir, opts = {}) {
  return new ServiceInstaller({
    platform,
    homedir: path.join(dir, 'home'),
    baseDir: path.join(dir, 'aod'),
    stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
    metaFile: path.join(dir, 'aod', 'service.json'),
    execFileSync: opts.execFileSync || (() => Buffer.from('')),
    spawnSync: () => ({ status: 0, stdout: '' }),
    logger: opts.logger || silent,
    provisionServer: (ctx) => ({
      provisioned: true,
      path: ctx.dest,
      version: '0.1.112',
      sha256: 'stub',
      verified: 'stub',
      releaseTag: 'v0.1.112',
    }),
  });
}

describe('service/unchanged install on linux and darwin', function () {
  it('systemd: a stopped unit is started, not reported as a successful no-op', async function () {
    const dir = sandbox();
    try {
      const calls = [];
      let active = 'inactive';
      const inst = installerFor('linux', dir, {
        execFileSync: (cmd, args) => {
          calls.push([cmd, ...args].join(' '));
          if (cmd === 'systemctl' && args[1] === 'is-active') {
            if (active === 'active') return Buffer.from('active\n');
            const err = new Error('inactive');
            err.stderr = 'inactive';
            throw err;
          }
          return Buffer.from('');
        },
      });
      const entry = fakeEntry(dir);
      await inst.install(entry, { serverArgs: ['--port', '8888'] });
      active = 'active';
      calls.length = 0;
      const second = await inst.install(entry, { serverArgs: ['--port', '8888'] });
      assert.strictEqual(second.unchanged, true);
      assert.strictEqual(second.restarted, 'running');
      assert.ok(!calls.some((c) => c.includes('enable --now')), 'already active: nothing to start');

      // Now the unit is stopped but the file is identical.
      active = 'inactive';
      calls.length = 0;
      const third = await inst.install(entry, { serverArgs: ['--port', '8888'] });
      assert.strictEqual(third.unchanged, true);
      assert.strictEqual(third.restarted, 'started');
      assert.ok(calls.some((c) => c.includes('enable --now')), 'the stopped unit was started');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('launchd: an unloaded agent is loaded, not reported as a successful no-op', async function () {
    const dir = sandbox();
    try {
      const calls = [];
      let loaded = true;
      const inst = installerFor('darwin', dir, {
        execFileSync: (cmd, args) => {
          calls.push([cmd, ...args].join(' '));
          if (cmd === 'launchctl' && args[0] === 'list') {
            if (!loaded) throw new Error('Could not find service');
            return Buffer.from('{ "PID" = 4242; }');
          }
          return Buffer.from('');
        },
      });
      const entry = fakeEntry(dir);
      await inst.install(entry, { serverArgs: [] });
      loaded = false;
      calls.length = 0;
      const second = await inst.install(entry, { serverArgs: [] });
      assert.strictEqual(second.unchanged, true);
      assert.strictEqual(second.restarted, 'started');
      assert.ok(calls.some((c) => c.startsWith('launchctl load')), 'the agent was loaded');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('service/failed install leaves nothing half-applied', function () {
  it('rolls the sentinel back to the pre-staging record (old bundle version too)', async function () {
    const dir = sandbox();
    try {
      const metaFile = path.join(dir, 'aod', 'service.json');
      fs.mkdirSync(path.dirname(metaFile), { recursive: true });
      // An install of an OLDER bundle that is currently running.
      fs.writeFileSync(metaFile, JSON.stringify({
        platform: 'win32',
        mode: 'login',
        serverArgs: ['--mesh'],
        bundleVersion: '0.0.1',
        supervisorPath: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
      }));
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile,
        execFileSync: (cmd) => {
          if (cmd === 'schtasks') throw new Error('ERROR: Access is denied.');
          return Buffer.from('');
        },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: silent,
        provisionServer: (ctx) => ({ provisioned: true, path: ctx.dest, version: 'x', sha256: 'x', verified: 'stub', releaseTag: 'v1' }),
      });
      const entry = fakeEntry(dir);
      await assert.rejects(() => inst.install(entry, { serverArgs: ['--mesh'] }), /Access is denied/);
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      // Staging stamped the NEW version before the failure. If it survives, the
      // retry compares the new version against itself, decides "unchanged", and
      // leaves the old daemon running while reporting success.
      assert.strictEqual(meta.bundleVersion, '0.0.1', 'old bundle version restored');
      assert.deepStrictEqual(meta.serverArgs, ['--mesh']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes only ITS OWN sentinel when there was none before', async function () {
    const dir = sandbox();
    try {
      const metaFile = path.join(dir, 'aod', 'service.json');
      const inst = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile,
        execFileSync: (cmd) => {
          if (cmd === 'schtasks') throw new Error('ERROR: Access is denied.');
          return Buffer.from('');
        },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: silent,
        provisionServer: (ctx) => ({ provisioned: true, path: ctx.dest, version: 'x', sha256: 'x', verified: 'stub', releaseTag: 'v1' }),
      });
      const entry = fakeEntry(dir);
      // The rollback used the module-level default path instead of the
      // configured one, so it deleted a DIFFERENT installation's sentinel.
      const real = path.join(os.homedir(), '.ai-or-die', 'service.json');
      const realBefore = fs.existsSync(real);
      await assert.rejects(() => inst.install(entry, { serverArgs: [] }), /Access is denied/);
      assert.ok(!fs.existsSync(metaFile), 'the sentinel this install created is gone');
      assert.strictEqual(fs.existsSync(real), realBefore, 'another install\'s sentinel is untouched');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The replace branch (a DIFFERENT unit file is already on disk) is the normal
// upgrade path over a WORKING install. The failure mode there is losing the
// operator's still-good task definition, so it must never be treated like a
// first install.
describe('service/win32 upgrade over a working install', function () {
  // Records the schtasks verbs for the SERVICE task only; the watchdog task is
  // re-registered on every install by design and never holds live PTYs.
  function recordingExec(state, calls) {
    return (cmd, args) => {
      if (cmd !== 'schtasks') return Buffer.from('');
      calls.push([cmd, ...args].join(' '));
      const taskName = args[args.indexOf('/tn') + 1];
      if (taskName !== 'ai-or-die') return Buffer.from('');
      const verb = args[0];
      if (verb === '/query') {
        if (state.taskMissing) {
          // schtasks exits non-zero when the task is not registered.
          throw new Error('ERROR: The system cannot find the file specified.');
        }
        // "Running" only while the task is actually started, so
        // _pollTaskStopped() after /end returns immediately instead of
        // busy-waiting its full 5s budget.
        return Buffer.from(
          `TaskName:      \\ai-or-die\r\nStatus:        ${state.running ? 'Running' : 'Ready'}\r\n`
        );
      }
      if (verb === '/end') { state.running = false; return Buffer.from(''); }
      if (verb === '/create' && state.createFails) {
        throw new Error('ERROR: The task XML contains a value which is incorrectly formatted or out of range.');
      }
      if (verb === '/run') { state.running = true; return Buffer.from(''); }
      return Buffer.from('');
    };
  }

  it('keeps the previously registered task when the new definition is rejected', async function () {
    const dir = sandbox();
    try {
      const calls = [];
      const state = { running: false, createFails: false, taskMissing: true };
      const inst = installerFor('win32', dir, { execFileSync: recordingExec(state, calls) });
      const entry = fakeEntry(dir);
      const first = await inst.install(entry, { serverArgs: ['--port', '8888'] });
      assert.notStrictEqual(first.unchanged, true);
      // The task now exists and is running: the upgrade is replacing a working
      // install, which is exactly the dangerous case.
      state.taskMissing = false;
      state.running = true;
      state.createFails = true;
      calls.length = 0;
      await assert.rejects(
        () => inst.install(entry, { serverArgs: ['--port', '9999'] }),
        /incorrectly formatted/
      );
      // /create with /f validates before it replaces, so a rejected definition
      // leaves the old one registered and runnable. Deleting it (the old
      // unconditional compensation) would leave the operator with NO service.
      assert.ok(
        !calls.some((c) => c.includes('/delete')),
        `the working task is never deleted (saw ${calls.join(' | ')})`
      );
      // The rolled-back sentinel must still describe that surviving install.
      const meta = inst._readMeta();
      assert.deepStrictEqual(meta.serverArgs, ['--port', '8888']);
      assert.strictEqual(meta.mode, 'login');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops the running task before replacing its definition', async function () {
    const dir = sandbox();
    try {
      const calls = [];
      const state = { running: false, createFails: false, taskMissing: true };
      const inst = installerFor('win32', dir, { execFileSync: recordingExec(state, calls) });
      const entry = fakeEntry(dir);
      await inst.install(entry, { serverArgs: ['--port', '8888'] });
      state.taskMissing = false;
      state.running = true;
      calls.length = 0;
      await inst.install(entry, { serverArgs: ['--port', '9999'] });
      const verbs = calls
        .filter((c) => c.startsWith('schtasks') && c.includes('/tn ai-or-die') && !c.includes('watchdog'))
        .map((c) => c.split(' ')[1]);
      // A live daemon holds the port and its whole PTY tree; /run would boot a
      // second instance that IgnoreNew then wedges. uninstall() and the
      // watchdog /end first for the same reason.
      assert.ok(verbs.includes('/end'), `the running task was stopped (saw ${verbs.join(',')})`);
      assert.ok(
        verbs.indexOf('/end') < verbs.indexOf('/create'),
        `/end precedes /create (saw ${verbs.join(',')})`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('service/sentinel durability', function () {
  it('a torn sentinel write leaves the previous record readable', function () {
    const dir = sandbox();
    try {
      const metaFile = path.join(dir, 'aod', 'service.json');
      fs.mkdirSync(path.dirname(metaFile), { recursive: true });
      const previous = {
        platform: 'win32',
        mode: 'login',
        serverArgs: ['--mesh'],
        bundleVersion: '0.0.1',
      };
      fs.writeFileSync(metaFile, JSON.stringify(previous, null, 2));
      const inst = installerFor('win32', dir);
      const realRename = fs.renameSync;
      let attempts = 0;
      // Simulate the rename failing (EPERM from AV/backup holding the file,
      // disk full) AFTER the payload was written to the temp file: only a
      // temp-file+rename write can still leave the old record intact.
      fs.renameSync = (from, to) => {
        attempts += 1;
        if (attempts === 1) throw new Error('EPERM: operation not permitted, rename');
        return realRename(from, to);
      };
      try {
        inst._writeMeta({ platform: 'win32', mode: 'boot', serverArgs: ['--port', '1'], bundleVersion: '9.9.9' });
      } finally {
        fs.renameSync = realRename;
      }
      // Truncating the live file in place would leave unparseable JSON here,
      // _readMeta() would degrade to {}, and the next install's rollback would
      // then delete service.json while a task is still registered — that
      // daemon boots believing it is not a service.
      assert.ok(attempts > 0, 'the write goes through a rename (atomic replace)');
      const meta = inst._readMeta();
      assert.notDeepStrictEqual(meta, {}, 'the previous record is still parseable');
      assert.deepStrictEqual(meta.serverArgs, ['--mesh']);
      assert.strictEqual(meta.mode, 'login');
      assert.strictEqual(meta.bundleVersion, '0.0.1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('service/unchanged install on windows', function () {
  it('warns when the task cannot be started on an unchanged reinstall', async function () {
    const dir = sandbox();
    try {
      const warnings = [];
      const verbs = [];
      let deny = false;
      const inst = installerFor('win32', dir, {
        logger: { ...silent, warn: (m) => warnings.push(String(m)) },
        execFileSync: (cmd, args) => {
          if (cmd !== 'schtasks') return Buffer.from('');
          const verb = args[0];
          const taskName = args[args.indexOf('/tn') + 1];
          if (taskName !== 'ai-or-die') return Buffer.from(''); // watchdog
          if (verb === '/query') {
            // `deny` flips to Ready AFTER the first install, so the second one
            // sees a stopped task and tries `/run`. While it is still Running
            // the stop poll must observe Ready once /end has been issued, or it
            // spends its whole budget here (that is a test-harness hang, not a
            // product behaviour).
            const ended = verbs.includes('/end');
            const status = (deny || ended) ? 'Ready' : 'Running';
            return Buffer.from(`TaskName:      \\ai-or-die\r\nStatus:        ${status}\r\n`);
          }
          verbs.push(verb);
          if (verb === '/run' && deny) throw new Error('ERROR: Access is denied.');
          return Buffer.from('');
        },
      });
      const entry = fakeEntry(dir);
      await inst.install(entry, { serverArgs: [], mode: 'boot' });
      warnings.length = 0;
      deny = true;
      const second = await inst.install(entry, { serverArgs: [], mode: 'boot' });
      assert.strictEqual(second.unchanged, true);
      assert.strictEqual(second.restarted, 'start-failed');
      const text = warnings.join('\n');
      assert.ok(/could not be started/.test(text), `warns: ${text}`);
      assert.ok(/SeBatchLogonRight/.test(text), 'names the boot-mode remediation');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
