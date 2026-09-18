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
  return new ServiceInstaller({
    platform,
    homedir: path.join(dir, 'home'),
    baseDir: path.join(dir, 'aod'),
    stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
    metaFile: path.join(dir, 'aod', 'service.json'),
    execFileSync: () => Buffer.from(''), // never touch systemctl/launchctl/schtasks
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

  it('references a global install directly (already stable)', function () {
    const dir = sandbox();
    try {
      const globalBin = path.join(dir, 'global', 'bin');
      fs.mkdirSync(globalBin, { recursive: true });
      const entry = path.join(globalBin, 'supervisor-service.js');
      fs.writeFileSync(entry, '// supervisor');
      const installer = installerFor('linux', dir);
      const result = installer.ensureStableBinary(entry);
      assert.strictEqual(result.copied, false);
      assert.strictEqual(result.path, entry);
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

  it('task scheduler XML has logon + unlock triggers and wake-to-run', function () {
    const dir = sandbox();
    try {
      const installer = installerFor('win32', dir);
      const xml = installer.buildUnit('C:\\Users\\u\\.ai-or-die\\bin\\ai-or-die-supervisor.js');
      assert.ok(xml.includes('LogonTrigger'));
      assert.ok(xml.includes('ConsoleUnlock'), 'workstation-unlock wake trigger');
      assert.ok(xml.includes('<WakeToRun>true</WakeToRun>'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('install() writes the unit file and metadata without touching the OS', function () {
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
      });
      const entry = path.join(dir, 'pkg', 'supervisor-service.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, '// supervisor');
      const result = installer.install(entry);
      assert.ok(result.unitFile.endsWith('ai-or-die.service'));
      assert.ok(fs.existsSync(result.unitFile));
      assert.ok(calls.some((c) => c[0] === 'systemctl'), 'enables via systemctl');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
