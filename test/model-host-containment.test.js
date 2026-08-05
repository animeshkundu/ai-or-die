'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const KeepaliveManager = require('../src/keepalive-manager');
const {
  buildOrphanSweepScript,
  sweepOrphanHosts,
} = require('../src/model-host-containment');

describe('model-host Windows orphan sweep', function () {
  it('requires a model-host runtime, entrypoint, host name, and original parent', function () {
    const script = buildOrphanSweepScript(1234);
    assert.match(script, /Name -match/);
    assert.match(script, /stt-host\|sticky-note-host/);
    assert.match(script, /--ai-or-die-model-host/);
    assert.match(script, /--host=\(\?:stt\|sticky-note\)/);
    assert.match(script, /ParentProcessId -eq \$ownerPid/);
    assert.match(script, /\$ownerPid -ne \$self/);
  });

  it('does not classify shell executables as model hosts', function () {
    const script = buildOrphanSweepScript(1234);
    assert.match(script, /\^\(\?:node\|bun\)/);
    assert.ok(!script.includes('powershell|pwsh|cmd'));
  });

  it('spawns the existing anchored PowerShell path without consulting PATH', function () {
    const env = {
      ...process.env,
      PATH: '',
    };
    const calls = [];
    sweepOrphanHosts({
      platform: 'win32',
      env,
      execFile(binary, args, options, callback) {
        calls.push({ binary, args, options });
        callback(null);
      },
      logger: { warn() {} },
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].binary, KeepaliveManager.powershellPath(env));
    assert.strictEqual(path.win32.isAbsolute(calls[0].binary), true);
    if (process.platform === 'win32') {
      assert.strictEqual(fs.existsSync(calls[0].binary), true);
    }
  });

  it('resolves PowerShell through SystemRoot, windir, then C:\\Windows', function () {
    const calls = [];
    const env = { windir: 'E:\\Windows', PATH: '' };
    sweepOrphanHosts({
      platform: 'win32',
      env,
      execFile(binary, args, options, callback) {
        calls.push(binary);
        callback(null);
      },
      logger: { warn() {} },
    });

    assert.strictEqual(calls[0], KeepaliveManager.powershellPath(env));
    assert.ok(calls[0].startsWith('E:\\Windows'));
    assert.ok(KeepaliveManager.powershellPath({}).startsWith('C:\\Windows'));
    assert.strictEqual(path.win32.isAbsolute(calls[0]), true);
  });

  it('warns exactly once when PowerShell is not found', function () {
    const warnings = [];
    sweepOrphanHosts({
      platform: 'win32',
      env: {},
      execFile(binary, args, options, callback) {
        const error = new Error('spawn ENOENT');
        error.code = 'ENOENT';
        callback(error);
        callback(error);
      },
      logger: { warn(message) { warnings.push(message); } },
    });

    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /not found/i);
    assert.ok(warnings[0].includes(KeepaliveManager.powershellPath({})));
  });

  it('warns once and never throws when execFile throws synchronously', function () {
    const warnings = [];
    assert.doesNotThrow(() => sweepOrphanHosts({
      platform: 'win32',
      env: {},
      execFile() {
        throw new Error('invalid spawn options');
      },
      logger: { warn(message) { warnings.push(message); } },
    }));

    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /failed/i);
  });

  it('warns exactly once when PowerShell exits with a generic failure', function () {
    const warnings = [];
    sweepOrphanHosts({
      platform: 'win32',
      env: {},
      execFile(binary, args, options, callback) {
        callback(new Error('process exited 1'));
      },
      logger: { warn(message) { warnings.push(message); } },
    });

    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /failed/i);
    assert.doesNotMatch(warnings[0], /not found/i);
  });

  it('remains a no-op off Windows and when explicitly skipped', function () {
    let calls = 0;
    let warnings = 0;
    const options = {
      execFile() { calls++; },
      logger: { warn() { warnings++; } },
    };

    sweepOrphanHosts({ ...options, platform: 'linux', env: {} });
    sweepOrphanHosts({
      ...options,
      platform: 'win32',
      env: { AI_OR_DIE_SKIP_ORPHAN_SWEEP: '1' },
    });

    assert.strictEqual(calls, 0);
    assert.strictEqual(warnings, 0);
  });
});
