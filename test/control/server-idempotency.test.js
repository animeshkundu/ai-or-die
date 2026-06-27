'use strict';

const assert = require('assert');
const { ClaudeCodeWebServer } = require('../../src/server');

function makeHarness() {
  const events = [];
  const server = Object.create(ClaudeCodeWebServer.prototype);
  server.baseFolder = process.cwd();
  server.selectedWorkingDir = null;
  server.claudeSessions = new Map();
  server._controlIdempotency = new Map();
  server.sessionStore = { markDirty: () => {} };
  server.saveSessionsToDisk = () => {};
  server.validatePath = (p) => ({ valid: true, path: p });
  server._pushEvictionEntry = () => {};
  server.controlEventBus = { append: (sessionId, kind) => events.push({ sessionId, kind }) };
  return { server, events };
}

describe('control server idempotency helpers', function () {
  it('_controlCreateSession reuses the prior result for the same idempotency key', async function () {
    const { server, events } = makeHarness();

    const first = await server._controlCreateSession({ name: 'fleet', idempotencyKey: 'create-1' });
    const second = await server._controlCreateSession({ name: 'fleet', idempotencyKey: 'create-1' });

    assert.equal(server.claudeSessions.size, 1);
    assert.equal(events.length, 1);
    assert.equal(first.sessionId, second.sessionId);
    assert.equal(first.lifecycle, 'created');
    assert.equal(first.duplicated, false);
    assert.equal(second.duplicated, true);
  });

  it('_controlStopSession only performs the stop once for the same idempotency key', async function () {
    const { server } = makeHarness();
    let calls = 0;
    let modeSeen;
    server.claudeSessions.set('s1', { active: true, agent: 'claude' });
    server.getBridgeForAgent = () => ({});
    server.stopToolSession = async (id, mode) => {
      calls++;
      modeSeen = mode;
      assert.equal(id, 's1');
    };

    const first = await server._controlStopSession('s1', 'kill', 'stop-1');
    const second = await server._controlStopSession('s1', 'kill', 'stop-1');

    assert.equal(calls, 1);
    assert.equal(modeSeen, 'kill');
    assert.equal(first.stopped, true);
    assert.equal(first.duplicated, false);
    assert.equal(second.stopped, true);
    assert.equal(second.duplicated, true);
  });
});
