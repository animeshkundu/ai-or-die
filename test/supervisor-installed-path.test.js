'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('installed CLI supervisor path', function () {
  it('maps both package commands to the supervisor', function () {
    const pkg = require('../package.json');
    assert.deepStrictEqual(pkg.bin, {
      'ai-or-die': './bin/supervisor.js',
      aiordie: './bin/supervisor.js',
    });
  });

  it('forwards argv and exposes gc in the core child', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-observer-'));
    const output = path.join(dir, 'result.json');
    try {
      const result = spawnSync(process.execPath, [
        path.join(__dirname, '..', 'bin', 'supervisor.js'),
        '--port', '12345', '--', 'literal',
      ], {
        env: {
          ...process.env,
          SUPERVISOR_CHILD_SCRIPT: path.join(__dirname, 'fixtures', 'supervisor-observer.js'),
          SUPERVISOR_OBSERVER_FILE: output,
        },
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      const observed = JSON.parse(fs.readFileSync(output, 'utf8'));
      assert.strictEqual(observed.gcAvailable, true);
      assert.ok(observed.execArgv.includes('--expose-gc'));
      assert.deepStrictEqual(observed.args, ['--port', '12345', '--', 'literal']);
      assert.strictEqual(observed.supervised, '1');
      assert.strictEqual(observed.ppid, result.pid, 'installed path must be supervisor -> core');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
