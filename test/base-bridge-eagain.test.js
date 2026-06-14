// test/base-bridge-eagain.test.js
//
// Regression suite for the bounded transient-EAGAIN suppression in
// BaseBridge.shouldSwallowTransientEagain / isEagainError (src/base-bridge.js).
//
// Background: node-pty's PTY master can emit a benign read EAGAIN ("fs.ReadStream
// gets EAGAIN twice at first") at startup under Node; we attach a second 'error'
// listener and must swallow those transient blips so they don't tear the session
// down and surface a fatal "Connection Error" (which makes the client retry +
// double-spawn).
//
// But under Bun, node-pty's read fails with a *sustained* EAGAIN flood and the
// PTY master never delivers data (oven-sh/bun#25822). Swallowing EAGAIN
// unconditionally turned that into a silent 30s hang. The fix bounds the swallow:
// only a sustained flood (count >= threshold) with no life-sign past a startup
// grace window is surfaced. A stray late EAGAIN on a slow Node session is never
// enough to false-fail it (worst case it falls through to the 30s watchdog).

'use strict';

const assert = require('assert');
const BaseBridge = require('../src/base-bridge');

const GRACE_MS = 3000;
const THRESHOLD = 50; // PTY_EAGAIN_FAIL_THRESHOLD

describe('BaseBridge.isEagainError', function () {
  it('detects EAGAIN by code and by message; rejects others', function () {
    assert.strictEqual(BaseBridge.isEagainError({ code: 'EAGAIN' }), true);
    assert.strictEqual(BaseBridge.isEagainError({ message: 'read EAGAIN' }), true);
    assert.strictEqual(BaseBridge.isEagainError({ code: 'EIO', message: 'read EIO' }), false);
    assert.strictEqual(BaseBridge.isEagainError(new Error('command not found')), false);
    assert.strictEqual(BaseBridge.isEagainError(null), false);
    assert.strictEqual(BaseBridge.isEagainError(undefined), false);
  });
});

describe('BaseBridge.shouldSwallowTransientEagain (bounded EAGAIN suppression)', function () {
  const eagain = { code: 'EAGAIN', message: 'read EAGAIN' };
  const eagainByMessage = { message: 'Error: resource temporarily unavailable, read EAGAIN' };

  it('swallows an early EAGAIN before the grace window (Node transient startup blip)', function () {
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(eagain, false, 0, 1), true);
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(eagain, false, GRACE_MS - 1, 2), true);
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(eagainByMessage, false, 100, 1), true);
  });

  it('swallows EAGAIN after a life-sign regardless of elapsed time or count (post-startup blip)', function () {
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(eagain, true, 100, 1), true);
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(eagain, true, 999999, 999), true);
  });

  it('keeps swallowing a stray late EAGAIN below the sustained-failure threshold (no Node false-fail)', function () {
    // Past the grace window but only a handful of EAGAINs — a slow Node session,
    // NOT the Bun flood. Must NOT tear down; falls through to the 30s watchdog.
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(eagain, false, 5000, 1), true);
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(eagain, false, 10000, THRESHOLD - 1), true);
  });

  it('SURFACES a sustained EAGAIN flood with no life-sign past the grace window (Bun #25822)', function () {
    // The load-bearing case: under Bun the read never succeeds, EAGAIN floods
    // continuously, and no life-sign ever arrives. Past the grace window AND
    // past the threshold the error must NOT be swallowed — it falls through to
    // tear down the dead session and notify the client instead of hanging.
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(eagain, false, GRACE_MS + 1, THRESHOLD), false);
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(eagain, false, 30000, 5000), false);
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(eagainByMessage, false, 5000, THRESHOLD), false);
  });

  it('does NOT surface a flood that is still within the grace window (count high, time low)', function () {
    // Both conditions must hold — a fast flood inside the first 3s is still
    // swallowed until the grace window elapses.
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(eagain, false, GRACE_MS - 1, 10000), true);
  });

  it('never swallows non-EAGAIN errors (e.g. EIO, generic spawn failure)', function () {
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain({ code: 'EIO', message: 'read EIO' }, false, 0, 0), false);
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain({ code: 'EIO', message: 'read EIO' }, true, 0, 0), false);
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(new Error('command not found'), false, 99999, 99999), false);
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(null, false, 0, 0), false);
    assert.strictEqual(BaseBridge.shouldSwallowTransientEagain(undefined, true, 100, 0), false);
  });
});
