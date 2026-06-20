'use strict';

// Unit tests for src/utils/process-tree.js — the best-effort cross-platform tree-kill
// fallback. The internal helpers (_killGroup, _taskkillTree) are platform-independent
// (they take injected spawn/kill), so these assert the kill shapes on every CI OS.

const assert = require('assert');
const { killProcessTree, killProcessTreeSync, _killGroup, _taskkillTree } = require('../src/utils/process-tree');
const { EventEmitter } = require('events');

describe('process-tree', function () {
  describe('_killGroup (POSIX group kill)', function () {
    it('kills the negative pid (group) then the pid itself', function () {
      const calls = [];
      const fakeKill = (target, sig) => { calls.push([target, sig]); };
      const ok = _killGroup(1234, 'SIGKILL', fakeKill);
      assert.strictEqual(ok, true);
      assert.deepStrictEqual(calls, [[-1234, 'SIGKILL'], [1234, 'SIGKILL']]);
    });

    it('still reports success if the group kill throws (ESRCH) but the pid kill works', function () {
      const calls = [];
      const fakeKill = (target, sig) => {
        if (target < 0) throw new Error('ESRCH');
        calls.push([target, sig]);
      };
      const ok = _killGroup(50, 'SIGTERM', fakeKill);
      assert.strictEqual(ok, true);
      assert.deepStrictEqual(calls, [[50, 'SIGTERM']]);
    });

    it('returns false when both kills throw', function () {
      const fakeKill = () => { throw new Error('EPERM'); };
      assert.strictEqual(_killGroup(7, 'SIGKILL', fakeKill), false);
    });
  });

  describe('_taskkillTree (Windows tree kill)', function () {
    it('spawns taskkill /T /F /PID <pid> and resolves true on exit 0', async function () {
      let seen = null;
      const fakeSpawn = (cmd, args, opts) => {
        seen = { cmd, args, opts };
        const ee = new EventEmitter();
        setImmediate(() => ee.emit('exit', 0));
        return ee;
      };
      const ok = await _taskkillTree(99, fakeSpawn);
      assert.strictEqual(ok, true);
      assert.strictEqual(seen.cmd, 'taskkill');
      assert.deepStrictEqual(seen.args, ['/T', '/F', '/PID', '99']);
      assert.strictEqual(seen.opts.shell, false);
      assert.strictEqual(seen.opts.windowsHide, true);
    });

    it('resolves false on non-zero exit', async function () {
      const fakeSpawn = () => { const ee = new EventEmitter(); setImmediate(() => ee.emit('exit', 128)); return ee; };
      assert.strictEqual(await _taskkillTree(1, fakeSpawn), false);
    });

    it('resolves false on spawn error', async function () {
      const fakeSpawn = () => { const ee = new EventEmitter(); setImmediate(() => ee.emit('error', new Error('ENOENT'))); return ee; };
      assert.strictEqual(await _taskkillTree(1, fakeSpawn), false);
    });
  });

  describe('killProcessTree dispatch', function () {
    it('rejects invalid pids', async function () {
      assert.strictEqual(await killProcessTree(0), false);
      assert.strictEqual(await killProcessTree(-5), false);
      assert.strictEqual(killProcessTreeSync(0), false);
    });

    it('uses the platform-appropriate mechanism', async function () {
      if (process.platform === 'win32') {
        let spawned = false;
        const fakeSpawn = () => { spawned = true; const ee = new EventEmitter(); setImmediate(() => ee.emit('exit', 0)); return ee; };
        await killProcessTree(123, { spawn: fakeSpawn });
        assert.strictEqual(spawned, true, 'win32 should taskkill');
      } else {
        const calls = [];
        await killProcessTree(123, { kill: (t, s) => calls.push([t, s]) });
        assert.deepStrictEqual(calls, [[-123, 'SIGKILL'], [123, 'SIGKILL']]);
      }
    });
  });
});
