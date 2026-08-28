'use strict';

const assert = require('assert');
const WebSocket = require('ws');
const { ClaudeCodeWebServer } = require('../src/server');
const CircularBuffer = require('../src/utils/circular-buffer');

function fakeSocket() {
  const sent = [];
  return {
    sent,
    readyState: WebSocket.OPEN,
    send(value) { sent.push(Buffer.isBuffer(value) ? value : JSON.parse(value)); },
  };
}

function makeHarness() {
  const server = Object.create(ClaudeCodeWebServer.prototype);
  const ws = fakeSocket();
  const wsInfo = {
    id: 'ws1',
    ws,
    claudeSessionId: null,
    membershipGeneration: 0,
    committedTransitionId: null,
    membershipQueue: Promise.resolve(),
    membershipQueueClosed: false,
  };
  const sessions = new Map();
  server.webSocketConnections = new Map([['ws1', wsInfo]]);
  server.claudeSessions = sessions;
  server.terminalGeometry = {
    detachConnection: () => Promise.resolve(),
    getFrame: () => null,
  };
  server._pushEvictionEntry = () => {};
  server.sessionStore = { markDirty() {} };
  server.baseFolder = process.cwd();
  server.selectedWorkingDir = null;
  server._stickyNotesEnabledGlobally = false;
  server.stickyNoteEngine = { getStatus: () => 'disabled' };
  server._prepareClaudeBindSidecar = () => null;
  server.artifactReviews = { get: () => null };
  server._buildJoinReplay = ClaudeCodeWebServer.prototype._buildJoinReplay;
  server._peekWithTimeout = () => Promise.resolve(null);
  server.saveSessionsToDisk = () => Promise.resolve();
  server.activityBroadcastTimestamps = new Map();
  server.terminalBridge = {};
  server.stickyNoteSummarizer = { isEnabled: () => false, flushExit() {} };
  server.sendToWebSocket = (socket, frame) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };
  return { server, ws, wsInfo, sessions };
}

function makeSession(id) {
  return {
    id,
    name: id,
    workingDir: process.cwd(),
    active: false,
    wasActive: false,
    agent: null,
    connections: new Set(),
    outputBuffer: new CircularBuffer(1000),
    stickyNote: null,
    autoTitle: null,
    nameIsUserSet: false,
    stickyNotesEnabled: false,
  };
}

describe('server WebSocket membership transitions', function () {
  it('serializes same-socket membership operations FIFO and leaves final membership last', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    sessions.set('a', makeSession('a'));
    sessions.set('b', makeSession('b'));
    const first = server.joinClaudeSession('ws1', 'a', { transitionId: 'a' });
    const second = server.joinClaudeSession('ws1', 'b', { transitionId: 'b' });
    const third = server.leaveClaudeSession('ws1', { transitionId: 'leave' });
    await Promise.all([first, second, third]);
    assert.strictEqual(wsInfo.claudeSessionId, null);
    assert.strictEqual(sessions.get('a').connections.has('ws1'), false);
    assert.strictEqual(sessions.get('b').connections.has('ws1'), false);
    assert.deepStrictEqual(wsInfo.ws.sent.map((frame) => frame.type), [
      'session_joined', 'session_left', 'session_joined', 'session_left',
    ]);
    assert.strictEqual(wsInfo.ws.sent[0].transitionId, 'a');
    assert.strictEqual(wsInfo.ws.sent[2].transitionId, 'b');
    assert.strictEqual(wsInfo.ws.sent[3].transitionId, 'leave');
  });

  it('preserves same-session committed transition across untagged rejoin without echoing it', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    sessions.set('a', makeSession('a'));
    await server.joinClaudeSession('ws1', 'a', { transitionId: 'committed' });
    wsInfo.ws.sent.length = 0;
    await server.joinClaudeSession('ws1', 'a');
    assert.strictEqual(wsInfo.committedTransitionId, 'committed');
    assert.strictEqual(wsInfo.ws.sent[0].transitionId, undefined);
    assert.deepStrictEqual(wsInfo.ws.sent.map((frame) => frame.type), ['session_joined']);
    assert.strictEqual(sessions.get('a').connections.has('ws1'), true);
  });

  it('does not detach geometry or membership for a same-session rejoin', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    const session = makeSession('a');
    session.connections.add('ws1');
    sessions.set('a', session);
    wsInfo.claudeSessionId = 'a';
    wsInfo.committedTransitionId = 'committed';
    let detachCalls = 0;
    server.terminalGeometry.detachConnection = async () => { detachCalls++; };
    await server.joinClaudeSession('ws1', 'a');
    assert.strictEqual(detachCalls, 0);
    assert.strictEqual(wsInfo.claudeSessionId, 'a');
    assert.strictEqual(wsInfo.committedTransitionId, 'committed');
    assert.strictEqual(session.connections.has('ws1'), true);
    assert.strictEqual(wsInfo.ws.sent.some((frame) => frame.type === 'session_left'), false);
  });

  it('resumes a previously paused socket after a successful same-session rejoin', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    const session = makeSession('a');
    session.connections.add('ws1');
    sessions.set('a', session);
    wsInfo.claudeSessionId = 'a';
    wsInfo.committedTransitionId = 'committed';
    wsInfo._flowPaused = true;

    await server.joinClaudeSession('ws1', 'a');

    assert.strictEqual(wsInfo._flowPaused, false);

    session._pendingChunks = ['post-join output'];
    session._pendingBytes = 'post-join output'.length;
    server._flushSessionOutput('a');
    assert.strictEqual(wsInfo.ws.sent.at(-1).toString(), 'post-join output');
  });

  it('keeps membership live while same-session replay is awaiting a snapshot', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    const session = makeSession('a');
    session.connections.add('ws1');
    session._ctlTranscript = {};
    sessions.set('a', session);
    wsInfo.claudeSessionId = 'a';
    wsInfo.committedTransitionId = 'committed';
    let release;
    server._peekWithTimeout = () => new Promise((resolve) => { release = resolve; });

    const join = server.joinClaudeSession('ws1', 'a');
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(sessions.get('a').connections.has('ws1'), true);
    assert.strictEqual(wsInfo.claudeSessionId, 'a');
    assert.strictEqual(wsInfo.committedTransitionId, 'committed');
    assert.strictEqual(typeof release, 'function');

    release(null);
    await join;
  });

  it('accepts tagged input when both membership tags match', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    const session = makeSession('a');
    session.active = true;
    session.agent = 'terminal';
    session.connections.add('ws1');
    sessions.set('a', session);
    wsInfo.claudeSessionId = 'a';
    wsInfo.committedTransitionId = 'committed';
    let writes = 0;
    server.getBridgeForAgent = () => ({ sendInput: async () => { writes++; } });
    server.terminalGeometry = null;

    await server.handleMessage('ws1', {
      type: 'input', data: 'ok', sessionId: 'a', transitionId: 'committed',
    });

    assert.strictEqual(writes, 1);
  });

  it('rejects a single tagged input field without PTY access', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    const session = makeSession('a');
    session.active = true;
    session.agent = 'terminal';
    session.connections.add('ws1');
    sessions.set('a', session);
    wsInfo.claudeSessionId = 'a';
    wsInfo.committedTransitionId = 'committed';
    let writes = 0;
    server.getBridgeForAgent = () => ({ sendInput: async () => { writes++; } });
    server.terminalGeometry = null;
    server.sendToWebSocket = (socket, frame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };
    // A partial tag is rejected by the production fence, before bridge lookup.
    // Keep this assertion independent of any later input error frames.
    const before = wsInfo.ws.sent.length;

    await server.handleMessage('ws1', {
      type: 'input', data: 'nope', sessionId: 'a',
    });

    assert.strictEqual(writes, 0);
    assert.strictEqual(wsInfo.ws.sent.length, before + 1);
    assert.strictEqual(wsInfo.ws.sent.at(-1).code, 'stale_session_transition');
  });

  it('rejects tagged input whose session or transition is stale without PTY access', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    const session = makeSession('a');
    session.active = true;
    session.agent = 'terminal';
    session.connections.add('ws1');
    sessions.set('a', session);
    wsInfo.claudeSessionId = 'a';
    wsInfo.committedTransitionId = 'new';
    let writes = 0;
    server.getBridgeForAgent = () => ({ sendInput: async () => { writes++; } });
    await server.handleMessage('ws1', {
      type: 'input', data: 'nope', sessionId: 'a', transitionId: 'old',
    });
    assert.strictEqual(writes, 0);
    assert.strictEqual(wsInfo.ws.sent.at(-1).code, 'stale_session_transition');
  });

  it('invalidates a socket synchronously and does not re-add it after close', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    const session = makeSession('a');
    session.connections.add('ws1');
    sessions.set('a', session);
    wsInfo.claudeSessionId = 'a';
    const pending = new Promise((resolve) => { server._pendingMembershipTest = resolve; });
    server._peekWithTimeout = () => pending;
    const join = server.joinClaudeSession('ws1', 'a');
    server.invalidateWebSocketMembership('ws1');
    wsInfo.ws.readyState = WebSocket.CLOSED;
    server._pendingMembershipTest();
    await join;
    assert.strictEqual(sessions.get('a').connections.has('ws1'), false);
    assert.strictEqual(wsInfo.claudeSessionId, null);
  });

  it('keeps queue usable after a rejected membership operation', async function () {
    const { server, wsInfo } = makeHarness();
    let calls = 0;
    const failing = server._queueMembership('ws1', { transitionId: 'bad' }, async () => {
      calls++;
      throw Object.assign(new Error('boom'), { code: 'test_failure' });
    });
    const succeeding = server._queueMembership('ws1', { transitionId: 'ok' }, async () => {
      calls++;
      return true;
    });
    await Promise.all([failing, succeeding]);
    assert.strictEqual(calls, 2);
    assert.strictEqual(wsInfo.membershipQueueClosed, false);
  });

  it('releases a geometry output hold when a bridge returns no session', async function () {
    const { server, wsInfo } = makeHarness();
    const session = makeSession('A');
    session.workingDir = process.cwd();
    server.claudeSessions.set('A', session);
    wsInfo.claudeSessionId = 'A';
    server.getBridgeForAgent = () => ({
      _commandReady: Promise.resolve(),
      isAvailable: () => true,
      startSession: async () => null,
    });
    const released = [];
    server._beginGeometryOutputHold = () => {};
    server._releaseGeometryOutput = (sessionId) => released.push(sessionId);
    server.terminalGeometry = {
      advertise: async () => {},
      takeControl: async () => {},
      getOwnerCapacity: () => null,
      commitSpawn: async () => {},
      reconcile: async () => {},
    };
    await server.startToolSession('ws1', 'terminal', server.getBridgeForAgent('terminal'), {}, 80, 24, 'main');
    assert.deepStrictEqual(released, ['A']);
    assert.strictEqual(session._geometrySpawning, false);
  });

  it('adds sessionId to stop lifecycle frames', async function () {
    const { server } = makeHarness();
    const session = makeSession('A');
    session.active = true;
    session.agent = 'terminal';
    server.claudeSessions.set('A', session);
    server.getBridgeForAgent = () => ({ stopSession: async () => {} });
    const frames = [];
    server.broadcastToSession = (_sessionId, frame) => frames.push(frame);
    await server.stopToolSession('A');
    assert.strictEqual(frames.length, 1);
    assert.deepStrictEqual(frames[0], { type: 'terminal_stopped', sessionId: 'A' });
  });

  it('does not echo an auto-join as an explicit transition', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    sessions.set('A', makeSession('A'));
    await server.joinClaudeSession('ws1', 'A', { autoJoin: true });
    assert.strictEqual(wsInfo.committedTransitionId, null);
    assert.strictEqual(wsInfo.ws.sent[0].transitionId, undefined);
  });

  it('preserves the geometry-held replay carve-out during join', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    const session = makeSession('A');
    session.outputBuffer.push('before');
    session.outputBuffer.push('held');
    session._geometryOutputHold = ['held'];
    session._geometryReplayBuffer = ['before'];
    sessions.set('A', session);
    await server.joinClaudeSession('ws1', 'A');
    assert.deepStrictEqual(wsInfo.ws.sent[0].outputBuffer, ['before']);
  });

  it('does not send a stale join acknowledgement after socket close', async function () {
    const { server, ws, wsInfo, sessions } = makeHarness();
    const session = makeSession('A');
    sessions.set('A', session);
    let release;
    server._peekWithTimeout = () => new Promise((resolve) => { release = resolve; });
    const join = server.joinClaudeSession('ws1', 'A');
    await new Promise((resolve) => setImmediate(resolve));
    if (typeof release !== 'function') {
      server.invalidateWebSocketMembership('ws1');
      ws.readyState = WebSocket.CLOSED;
      await join;
      assert.strictEqual(wsInfo.claudeSessionId, null);
      assert.strictEqual(session.connections.has('ws1'), false);
      return;
    }
    server.invalidateWebSocketMembership('ws1');
    ws.readyState = WebSocket.CLOSED;
    release(null);
    await join;
    assert.strictEqual(wsInfo.claudeSessionId, null);
    assert.strictEqual(session.connections.has('ws1'), false);
  });

  it('echoes transitionId on explicit leave only', async function () {
    const { server, wsInfo, sessions } = makeHarness();
    sessions.set('A', makeSession('A'));
    await server.joinClaudeSession('ws1', 'A', { transitionId: 'join' });
    wsInfo.ws.sent.length = 0;
    await server.leaveClaudeSession('ws1', { transitionId: 'leave' });
    assert.deepStrictEqual(wsInfo.ws.sent, [{ type: 'session_left', sessionId: 'A', transitionId: 'leave' }]);
  });

  it('rejects an overlong transition ID without echoing it', async function () {
    const { server, wsInfo } = makeHarness();
    await server.createAndJoinSession('ws1', 'invalid', undefined, { transitionId: 'x'.repeat(257) });
    assert.strictEqual(wsInfo.ws.sent[0].code, 'invalid_transition_id');
    assert.strictEqual(wsInfo.ws.sent[0].transitionId, undefined);
  });
});
