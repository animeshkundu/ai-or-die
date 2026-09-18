'use strict';

const assert = require('assert');
const ipc = require('../src/supervisor/ipc-protocol');

describe('supervisor/ipc-protocol', function () {
  it('defines all handoff message types', function () {
    for (const key of ['SHUTDOWN', 'HANDOFF_START', 'READY', 'SHUTDOWN_COMPLETE', 'HANDOFF_COMPLETE', 'UPDATE_READY']) {
      assert.strictEqual(typeof ipc.MSG[key], 'string', key);
    }
  });

  it('isValidFrame accepts typed objects and rejects junk', function () {
    assert.strictEqual(ipc.isValidFrame({ type: 'shutdown' }), true);
    assert.strictEqual(ipc.isValidFrame(null), false);
    assert.strictEqual(ipc.isValidFrame({}), false);
    assert.strictEqual(ipc.isValidFrame('shutdown'), false);
  });

  it('builders produce well-formed frames', function () {
    assert.deepStrictEqual(ipc.shutdown('update'), { type: 'shutdown', reason: 'update' });
    assert.deepStrictEqual(
      ipc.handoffStart([{ ptyId: 'a', pid: 1 }]),
      { type: 'handoff_start', ptys: [{ ptyId: 'a', pid: 1 }] }
    );
    assert.deepStrictEqual(
      ipc.handoffComplete(2),
      { type: 'handoff_complete', receivedPtys: 2 }
    );
    assert.deepStrictEqual(
      ipc.updateReady('0.1.109'),
      { type: 'update_ready', version: '0.1.109' }
    );
  });
});
