// test/base-bridge-resize-propagation.test.js
//
// Regression suite for BaseBridge.resize error propagation (src/base-bridge.js).
//
// Background: the multi-viewer geometry coordinator commits the authoritative
// applied geometry ONLY after its applyResize callback resolves —
// TerminalGeometryCoordinator awaits _applyResize, and on a throw calls
// _afterFailure (which releases the output hold) and rethrows, leaving
// state.persisted.applied untouched. ClaudeCodeWebServer._applyTerminalGeometry
// likewise sets session.cols/rows only after `await bridge.resize(...)` returns.
//
// That contract is only honest if a failed native resize actually reaches the
// caller. Previously BaseBridge.resize caught the node-pty failure and merely
// warned, so a PTY that never resized still produced a committed `applied`
// geometry and a broadcast telling every viewer the new size was live. Viewers
// would then render against dimensions the PTY does not have, which is exactly
// the desync the coordinator exists to prevent — and it would be invisible,
// because the only signal was a console warning on the server.
//
// The resize must therefore propagate. The original error is preserved as
// `cause` so the node-pty reason is not lost.

'use strict';

const assert = require('assert');
const BaseBridge = require('../src/base-bridge');

function bridgeWithSession(processStub, { active = true } = {}) {
  const bridge = new BaseBridge('terminal');
  bridge.sessions.set('s1', { active, process: processStub });
  return bridge;
}

describe('BaseBridge.resize error propagation', function () {
  it('propagates a native resize failure instead of swallowing it', async function () {
    const native = new Error('ioctl TIOCSWINSZ failed');
    const bridge = bridgeWithSession({
      resize() { throw native; },
    });

    await assert.rejects(
      () => bridge.resize('s1', 120, 40),
      (err) => {
        assert.ok(err instanceof Error, 'expected an Error');
        assert.match(err.message, /s1/, 'error should name the session');
        assert.match(err.message, /ioctl TIOCSWINSZ failed/, 'error should carry the native reason');
        return true;
      }
    );
  });

  it('preserves the original error as `cause` so the node-pty reason survives', async function () {
    const native = new Error('EBADF');
    native.code = 'EBADF';
    const bridge = bridgeWithSession({
      resize() { throw native; },
    });

    const err = await bridge.resize('s1', 80, 24).then(
      () => { throw new Error('expected resize to reject'); },
      (e) => e
    );
    assert.strictEqual(err.cause, native, 'original error should be attached as cause');
    assert.strictEqual(err.cause.code, 'EBADF');
  });

  it('resolves and forwards the requested dimensions when the PTY accepts them', async function () {
    const seen = [];
    const bridge = bridgeWithSession({
      resize(cols, rows) { seen.push([cols, rows]); },
    });

    await bridge.resize('s1', 163, 45);
    assert.deepStrictEqual(seen, [[163, 45]]);
  });

  it('still rejects for an unknown or inactive session', async function () {
    const bridge = bridgeWithSession({ resize() {} }, { active: false });
    await assert.rejects(() => bridge.resize('s1', 80, 24), /not found or not active/);
    await assert.rejects(() => bridge.resize('nope', 80, 24), /not found or not active/);
  });
});
