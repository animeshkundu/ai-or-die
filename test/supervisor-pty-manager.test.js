'use strict';

const assert = require('assert');
const { PtyManager } = require('../src/supervisor/pty-manager');

function fakeJobGuard() {
  const closed = [];
  return {
    closed,
    isAvailable: () => false, // POSIX path in tests: no job handles
    createKillOnCloseJob: () => null,
    assignPid: () => false,
    closeJob: (h) => { closed.push(h); return true; },
  };
}

describe('supervisor/pty-manager', function () {
  it('registers and retrieves PTYs', function () {
    const mgr = new PtyManager({ jobGuard: fakeJobGuard(), platform: 'linux' });
    mgr.register('pty-1', 4242, 'claude', 100);
    assert.strictEqual(mgr.size, 1);
    const rec = mgr.get('pty-1');
    assert.strictEqual(rec.pid, 4242);
    assert.strictEqual(rec.bridgeType, 'claude');
    assert.strictEqual(rec.ownerServerPid, 100);
  });

  it('transferOwnership re-parents without killing (update path)', function () {
    const mgr = new PtyManager({ jobGuard: fakeJobGuard(), platform: 'linux' });
    mgr.register('pty-1', 4242, 'claude', 100);
    mgr.register('pty-2', 4243, 'copilot', 100);
    mgr.register('pty-3', 4244, 'opencode', 999); // other server: untouched
    const result = mgr.transferOwnership(100, 200);
    assert.deepStrictEqual(result, { transferred: 2, failed: 0 });
    assert.strictEqual(mgr.get('pty-1').ownerServerPid, 200);
    assert.strictEqual(mgr.get('pty-2').ownerServerPid, 200);
    assert.strictEqual(mgr.get('pty-3').ownerServerPid, 999);
    assert.strictEqual(mgr.size, 3, 'no PTY record is dropped during transfer');
  });

  it('reapServer only reaps the dead server’s PTYs', function () {
    const killed = [];
    const mgr = new PtyManager({
      jobGuard: fakeJobGuard(),
      platform: 'linux',
      killTreeSync: (pid) => { killed.push(pid); return true; },
    });
    mgr.register('pty-1', 4242, 'claude', 100);
    mgr.register('pty-2', 4243, 'copilot', 200);
    const reaped = mgr.reapServer(100);
    assert.strictEqual(reaped, 1);
    assert.strictEqual(mgr.get('pty-1'), null);
    assert.ok(mgr.get('pty-2'), 'surviving server PTY untouched');
    assert.deepStrictEqual(killed, [4242]);
  });

  it('describeForHandoff emits JSON-safe descriptors', function () {
    const mgr = new PtyManager({ jobGuard: fakeJobGuard(), platform: 'linux' });
    mgr.register('pty-1', 4242, 'claude', 100);
    const desc = mgr.describeForHandoff(100);
    assert.deepStrictEqual(desc, [{ ptyId: 'pty-1', bridgeType: 'claude', pid: 4242 }]);
    assert.deepStrictEqual(mgr.describeForHandoff(999), []);
  });

  it('confirmUnregister swallows the post-handoff death rattle once', function () {
    const killed = [];
    const mgr = new PtyManager({
      jobGuard: fakeJobGuard(),
      platform: 'linux',
      killTreeSync: (pid) => { killed.push(pid); return true; },
    });
    mgr.register('pty-1', 4242, 'claude', 100);
    mgr.transferOwnership(100, 200);
    assert.strictEqual(mgr.confirmUnregister('pty-1'), 'ignored', 'old server echo consumed');
    assert.ok(mgr.get('pty-1'), 'record survives the death rattle');
    assert.deepStrictEqual(killed, [], 'no teardown on the echo');
    assert.strictEqual(mgr.confirmUnregister('pty-1'), 'destroyed', 'genuine end reaps');
    assert.strictEqual(mgr.get('pty-1'), null);
    assert.deepStrictEqual(killed, [4242]);
  });

  it('confirmUnregister reports unknown for missing records', function () {
    const mgr = new PtyManager({ jobGuard: fakeJobGuard(), platform: 'linux' });
    assert.strictEqual(mgr.confirmUnregister('nope'), 'unknown');
  });

  it('destroy is idempotent', function () {
    const mgr = new PtyManager({ jobGuard: fakeJobGuard(), platform: 'linux' });
    mgr.register('pty-1', 4242, 'claude', 100);
    assert.strictEqual(mgr.destroy('pty-1'), true);
    assert.strictEqual(mgr.destroy('pty-1'), false);
  });
});
