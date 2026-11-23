'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ServiceInstaller, isTempPackagePath } = require('../src/supervisor/service-installer');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-svc-'));
}

function installerFor(platform, dir) {
  const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  return new ServiceInstaller({
    platform,
    homedir: path.join(dir, 'home'),
    baseDir: path.join(dir, 'aod'),
    stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
    metaFile: path.join(dir, 'aod', 'service.json'),
    execFileSync: () => Buffer.from(''), // never touch systemctl/launchctl/schtasks
    spawnSync: () => ({ status: 0, stdout: '' }),
    logger: silent,
  });
}

describe('supervisor/service-installer', function () {
  it('detects ephemeral npx/bunx package paths', function () {
    assert.strictEqual(isTempPackagePath('/root/.npm/_npx/abc123/node_modules/ai-or-die/bin/ai-or-die.js'), true);
    assert.strictEqual(isTempPackagePath('/home/u/.bun/install/cache/ai-or-die/bin/x.js'), true);
    assert.strictEqual(isTempPackagePath('/usr/lib/node_modules/ai-or-die/bin/ai-or-die.js'), false);
    assert.strictEqual(isTempPackagePath('/home/u/.ai-or-die/bin/ai-or-die-supervisor.js'), false);
    // A bare temp dir is NOT ephemeral (the test sandbox itself lives
    // there) — only temp + node_modules together signal a staged runner.
    assert.strictEqual(isTempPackagePath(require('os').tmpdir() + '/plain-checkout/bin/x.js'), false);
    assert.strictEqual(
      isTempPackagePath(require('path').join(require('os').tmpdir(), 'pkg', 'node_modules', 'ai-or-die', 'bin', 'x.js')),
      true
    );
  });

  it('copies an npx-cache entry point to the stable path', function () {
    const dir = sandbox();
    try {
      const fakeCache = path.join(dir, '.npm', '_npx', 'abc', 'node_modules', 'ai-or-die', 'bin');
      fs.mkdirSync(fakeCache, { recursive: true });
      const entry = path.join(fakeCache, 'supervisor-service.js');
      fs.writeFileSync(entry, '// supervisor');
      const installer = installerFor('linux', dir);
      const result = installer.ensureStableBinary(entry);
      assert.strictEqual(result.copied, true);
      assert.strictEqual(result.path, path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'));
      assert.ok(fs.existsSync(result.path), 'stable copy exists');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stages a global install into the stable tree (never references it directly)', function () {
    // A global npm path is pruned on upgrade, so the installer always stages
    // the supervisor closure under the stable base instead of referencing it.
    const dir = sandbox();
    try {
      const globalBin = path.join(dir, 'global', 'bin');
      fs.mkdirSync(globalBin, { recursive: true });
      const entry = path.join(globalBin, 'supervisor-service.js');
      fs.writeFileSync(entry, '// supervisor');
      const installer = installerFor('linux', dir);
      const result = installer.ensureStableBinary(entry);
      assert.strictEqual(result.copied, true);
      assert.strictEqual(result.path, path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'));
      assert.ok(fs.existsSync(result.path), 'stable copy exists');
      assert.ok(
        fs.existsSync(path.join(dir, 'aod', 'src', 'supervisor', 'index.js')),
        'staged src closure exists (require must resolve)'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('systemd unit references only the stable supervisor path', function () {
    const dir = sandbox();
    try {
      const installer = installerFor('linux', dir);
      const unit = installer.buildUnit('/home/u/.ai-or-die/bin/ai-or-die-supervisor.js');
      assert.ok(unit.includes('ExecStart='), 'has ExecStart');
      assert.ok(unit.includes('/home/u/.ai-or-die/bin/ai-or-die-supervisor.js'));
      assert.ok(!unit.includes('_npx'), 'never references the npx cache');
      assert.ok(unit.includes('Restart=always'));
      assert.ok(unit.includes('AIORDIE_SERVICE=1'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('launchd plist references only the stable supervisor path', function () {
    const dir = sandbox();
    try {
      const installer = installerFor('darwin', dir);
      const plist = installer.buildUnit('/Users/u/.ai-or-die/bin/ai-or-die-supervisor.js');
      assert.ok(plist.includes('com.ai-or-die'));
      assert.ok(plist.includes('/Users/u/.ai-or-die/bin/ai-or-die-supervisor.js'));
      assert.ok(plist.includes('<key>KeepAlive</key>'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('task scheduler XML has logon + wake triggers and wake-to-run', function () {
    const dir = sandbox();
    try {
      const installer = installerFor('win32', dir);
      const xml = installer.buildUnit('C:\\Users\\u\\.ai-or-die\\bin\\ai-or-die-supervisor.js');
      assert.ok(xml.includes('LogonTrigger'));
      // `ConsoleUnlock` is NOT a valid StateChange value (schtasks rejects the
      // whole XML with (19,36):StateChange:ConsoleUnlock). ConsoleConnect is the
      // enum member that fires when a session attaches.
      assert.ok(xml.includes('<StateChange>ConsoleConnect</StateChange>'), 'console-connect wake trigger');
      assert.ok(!xml.includes('ConsoleUnlock'), 'never emits the invalid enum');
      assert.ok(xml.includes('<WakeToRun>true</WakeToRun>'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('install() writes the unit file and metadata without touching the OS', async function () {
    const dir = sandbox();
    try {
      const calls = [];
      const installer = new ServiceInstaller({
        platform: 'linux',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile: path.join(dir, 'aod', 'service.json'),
        execFileSync: (...args) => { calls.push(args); return Buffer.from(''); },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        provisionServer: () => ({
          provisioned: true,
          path: path.join(dir, 'aod', 'bin', 'ai-or-die-server'),
          version: '0.1.112',
          sha256: 'deadbeef',
          verified: 'stub',
          releaseTag: 'v0.1.112',
        }),
      });
      const entry = path.join(dir, 'pkg', 'supervisor-service.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, '// supervisor');
      const result = await installer.install(entry);
      assert.ok(result.unitFile.endsWith('ai-or-die.service'));
      assert.ok(fs.existsSync(result.unitFile));
      assert.ok(calls.some((c) => c[0] === 'systemctl'), 'enables via systemctl');
      assert.strictEqual(result.serverVersion, '0.1.112', 'server version recorded');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls the sentinel back when the unit cannot be registered', async function () {
    const dir = sandbox();
    try {
      const metaFile = path.join(dir, 'aod', 'service.json');
      fs.mkdirSync(path.dirname(metaFile), { recursive: true });
      fs.writeFileSync(metaFile, JSON.stringify({
        platform: 'win32', mode: 'login', serverArgs: ['--mesh'], supervisorPath: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
      }));
      const installer = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile,
        // Registration fails; everything else succeeds.
        execFileSync: (cmd) => {
          if (cmd === 'schtasks') throw new Error('ERROR: Access is denied.');
          return Buffer.from('');
        },
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        provisionServer: () => ({
          provisioned: true,
          path: path.join(dir, 'aod', 'bin', 'ai-or-die-server'),
          version: '0.1.112',
          sha256: 'deadbeef',
          verified: 'stub',
          releaseTag: 'v0.1.112',
        }),
      });
      const entry = path.join(dir, 'pkg', 'supervisor-service.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'bin', 'supervisor-service.js'), entry);
      await assert.rejects(() => installer.install(entry, { mode: 'boot', userId: 'S-1-5-21-1-2-3-1001' }), /Access is denied/);
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      // The early write exists so the FIRST start knows its mode; if the unit
      // never registered, keeping mode=boot would silently change how the still
      // installed login task's daemon behaves.
      assert.strictEqual(meta.mode, 'login', 'mode rolled back to the installed one');
      assert.deepStrictEqual(meta.serverArgs, ['--mesh'], 'previous args preserved');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls the sentinel back when the install is interrupted after the early write', async function () {
    const dir = sandbox();
    try {
      const metaFile = path.join(dir, 'aod', 'service.json');
      fs.mkdirSync(path.dirname(metaFile), { recursive: true });
      // A working login-mode install whose recorded mode must survive.
      fs.writeFileSync(metaFile, JSON.stringify({
        platform: 'win32',
        mode: 'login',
        serverArgs: ['--mesh'],
        supervisorPath: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
      }));
      const installer = new ServiceInstaller({
        platform: 'win32',
        homedir: path.join(dir, 'home'),
        baseDir: path.join(dir, 'aod'),
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
        metaFile,
        execFileSync: () => Buffer.from(''),
        spawnSync: () => ({ status: 0, stdout: '' }),
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        provisionServer: (ctx) => ({
          provisioned: true,
          path: ctx.dest,
          version: '0.1.112',
          sha256: 'deadbeef',
          verified: 'stub',
          releaseTag: 'v0.1.112',
        }),
      });
      // Simulate the interrupt (Ctrl-C, SIGTERM surfaced as an exception, OOM
      // kill) landing in the window AFTER the early sentinel write persisted and
      // BEFORE the unit is registered. The early write is the one carrying
      // `mode` but no serverArgs; if it sits outside the try, the new boot mode
      // survives with no unit change and no rollback: status() then reports boot
      // mode for a login install, and the running login task's daemon applies
      // boot-mode defaults (hibernation guard off).
      const realWrite = installer._writeMeta.bind(installer);
      let interrupted = false;
      installer._writeMeta = (meta) => {
        // The early write is the FIRST one that carries the new boot mode (the
        // staging write above it still carries the installed login mode).
        const early = !!meta && meta.mode === 'boot';
        const result = realWrite(meta);
        if (early && !interrupted) {
          interrupted = true;
          throw new Error('interrupted before unit registration');
        }
        return result;
      };
      const entry = path.join(dir, 'pkg', 'supervisor-service.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'bin', 'supervisor-service.js'), entry);
      await assert.rejects(
        () => installer.install(entry, { mode: 'boot', userId: 'S-1-5-21-1-2-3-1001' }),
        /interrupted before unit registration/
      );
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      assert.strictEqual(meta.mode, 'login', 'the failed boot install does not outlive the rollback');
      assert.deepStrictEqual(meta.serverArgs, ['--mesh'], 'the installed record is untouched');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
