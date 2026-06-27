'use strict';

// Regression for a bug the live smoke test caught: after a control-plane stop,
// session_status reported lifecycle 'created' (looked never-started) instead of
// 'exited', because stopToolSession clears session.agent and the PTY onExit can
// lag the synchronous stop. _controlStopSession now records a clean-exit marker.

const assert = require('assert');
const { ClaudeCodeWebServer } = require('../../src/server');

describe('control _controlStopSession lifecycle', function () {
  it('records a clean-exit marker so status reports exited (not created) after stop', async function () {
    const session = { id: 's1', active: true, agent: 'claude' };
    let stopped = false;
    const fakeThis = {
      claudeSessions: new Map([['s1', session]]),
      getBridgeForAgent: () => ({ /* truthy bridge */ }),
      stopToolSession: async () => { stopped = true; session.active = false; },
      _controlWithIdempotency: (id, key, fn) => fn(),
    };
    const out = await ClaudeCodeWebServer.prototype._controlStopSession.call(fakeThis, 's1', 'graceful');
    assert.equal(out.stopped, true);
    assert.equal(stopped, true);
    assert.ok(session._lastExit, 'a _lastExit marker is set so deriveStatus reports exited');
    assert.equal(session._lastExit.signal, null); // clean exit, not a crash
  });

  it('does not mark a never-started (no active) session', async function () {
    const session = { id: 's2', active: false, agent: null };
    const fakeThis = {
      claudeSessions: new Map([['s2', session]]),
      getBridgeForAgent: () => null,
      stopToolSession: async () => { throw new Error('should not be called'); },
      _controlWithIdempotency: (id, key, fn) => fn(),
    };
    const out = await ClaudeCodeWebServer.prototype._controlStopSession.call(fakeThis, 's2', 'graceful');
    assert.equal(out.stopped, true);
    assert.equal(session._lastExit, undefined);
  });
});
