'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', 'src', 'public', 'splits.js');

function loadSplit() {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const noop = () => {};
  const terminal = {
    cols: 80,
    rows: 24,
    writes: [],
    refreshes: 0,
    write(data, callback) {
      this.writes.push(data);
      if (callback) callback();
    },
    clear() {},
    refresh() { this.refreshes += 1; },
    loadAddon: noop,
    open: noop,
    onData: noop,
    focus: noop,
    dispose: noop,
    buffer: { active: { viewportY: 0, baseY: 0 } },
    getSelectionPosition: () => null,
    scrollToLine: noop,
    modes: {},
  };
  class FakeWebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }
    send(data) { this.sent.push(data); }
    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose();
    }
  }
  FakeWebSocket.instances = [];
  const makeElement = () => ({
    classList: { add: noop, remove: noop },
    appendChild: noop,
    addEventListener: noop,
    setAttribute: noop,
    style: {},
    dataset: {},
    getBoundingClientRect: () => ({ width: 600, height: 400 }),
  });
  const sandbox = {
    window: {
      imageHandler: null,
      genericDropHandler: null,
      authManager: null,
      feedback: null,
    },
    document: {
      fonts: null,
      createElement: makeElement,
      querySelector: () => makeElement(),
      getElementById: () => null,
      addEventListener: noop,
      body: makeElement(),
    },
    localStorage: { getItem: () => null, setItem: noop },
    location: { protocol: 'http:', host: 'localhost' },
    WebSocket: FakeWebSocket,
    Terminal: function () { return terminal; },
    FitAddon: { FitAddon: function () {} },
    WebLinksAddon: { WebLinksAddon: function () {} },
    attachClipboardHandler: noop,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame: noop,
    console,
    TextEncoder,
    ArrayBuffer,
    Uint8Array,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\n;globalThis.__Split = Split;', sandbox, { filename: 'splits.js' });
  const Split = sandbox.__Split;
  const split = Object.create(Split.prototype);
  split.app = {
    fitCoordinator: {
      request: () => Promise.resolve(),
      applyAuthoritative: () => {},
    },
  };
  split.index = 0;
  split.terminal = terminal;
  split.socket = null;
  split.connectionId = null;
  split._socketGeneration = 1;
  split.socketGeneration = 1;
  split._transitionGeneration = 1;
  split.transitionGeneration = 1;
  split._transitionId = 1;
  split.transitionId = 1;
  split.desiredSessionId = 'session-a';
  split.sessionId = 'session-a';
  split.committedSessionId = 'session-a';
  split.paintedSessionId = 'session-a';
  split._focusedSessionId = null;
  split._viewId = 'split-0';
  split._joinAcked = true;
  split._awaitingJoinAck = false;
  split._joinTimer = null;
  split._connectWaiter = null;
  split._pendingWrites = [];
  split._pendingWriteBytes = 0;
  split._maxReplayQueueBytes = 20;
  split._maxReplayQueueEntries = 4;
  split._preAckQuarantine = [];
  split._preAckBytes = 0;
  split._replayInProgress = false;
  split._replayState = null;
  split._repainting = false;
  split._repaintGeneration = 1;
  split._repaintTimer = null;
  split._reconnectTimer = null;
  split._heartbeat = null;
  split._closing = false;
  return { split, terminal, FakeWebSocket };
}

describe('split output isolation', function () {
  it('does not mutate the main session identity when focus changes', function () {
    const { split } = loadSplit();
    const app = { currentClaudeSessionId: 'main-session', _lastFocusedPaneIndex: 0 };
    const container = { app, activeSplitIndex: 0, splits: [split] };
    split.desiredSessionId = 'split-session';
    container.activeSplitIndex = 0;
    container.app._lastFocusedPaneIndex = 0;
    split._focusedSessionId = split.desiredSessionId;
    assert.strictEqual(app.currentClaudeSessionId, 'main-session');
    assert.strictEqual(split._focusedSessionId, 'split-session');
  });

  it('fences stale socket or transition output', function () {
    const { split, terminal } = loadSplit();
    const stale = { socketGeneration: 1, transitionId: 1, sessionId: 'session-a' };
    split._socketGeneration = 2;
    split._transitionId = 2;
    split.desiredSessionId = 'session-b';
    split._enqueueOrdered({ kind: 'binary', value: new Uint8Array([65]) }, stale);
    assert.strictEqual(split._pendingWrites.length, 0);
    assert.strictEqual(terminal.writes.length, 0);
  });

  it('keeps JSON and binary queue entries in wire order', function () {
    const { split, terminal } = loadSplit();
    const fence = split._currentFence();
    split._pendingWrites.push({ kind: 'binary', value: new Uint8Array([65]) });
    split._pendingWrites.push({ kind: 'json', value: { type: 'output', data: 'B' } });
    split._pendingWriteBytes = 2;
    split._replayInProgress = false;
    split._repainting = false;
    split._flushOutput();
    split._replayInProgress = false;
    split._repainting = false;
    split._flushOutput();
    assert.strictEqual(terminal.writes[0][0], 65);
    assert.strictEqual(terminal.writes[1], 'B');
  });

  it('bounds queue memory and reports overflow', function () {
    const { split } = loadSplit();
    let warning = '';
    split._showRecovery = (message) => { warning = message; };
    const fence = split._currentFence();
    split._enqueueOrdered({ kind: 'binary', value: new Uint8Array(21) }, fence);
    assert.strictEqual(split._pendingWrites.length, 0);
    assert.match(warning, /overflowed|recovery/);
  });

  it('uses renderedSnapshot for inactive sessions', function () {
    const { split, terminal } = loadSplit();
    const fence = split._currentFence();
    split._awaitingJoinAck = true;
    split._joinAcked = false;
    split._beginReplay({ sessionId: 'session-a', active: false, renderedSnapshot: 'SNAP\nSHOT' }, fence);
    assert.ok(terminal.writes.some((value) => typeof value === 'string' && value.includes('SNAP\r\nSHOT')));
  });

  it('refreshes after replay and marks the painted identity', async function () {
    const { split, terminal } = loadSplit();
    const fence = split._currentFence();
    split._awaitingJoinAck = true;
    split._joinAcked = false;
    split._beginReplay({ sessionId: 'session-a', active: true, outputBuffer: ['LIVE'] }, fence);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(split.paintedSessionId, 'session-a');
    assert.ok(terminal.refreshes > 0);
  });

  it('drops pre-ack binary instead of painting it after replay', async function () {
    const { split, terminal } = loadSplit();
    const fence = split._currentFence();
    split._awaitingJoinAck = true;
    split._joinAcked = false;
    split._quarantinePreAck(new Uint8Array([90]), fence);
    split._beginReplay({ sessionId: 'session-a', active: true, outputBuffer: ['R'] }, fence);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(split.paintedSessionId, 'session-a');
    assert.ok(!terminal.writes.some((value) => value instanceof Uint8Array && value[0] === 90));
  });

  it('routes input through the current pane fence', function () {
    const { split, FakeWebSocket } = loadSplit();
    split.socket = new FakeWebSocket();
    const fence = split._currentFence();
    assert.strictEqual(split.sendInput('ok', fence), true);
    assert.strictEqual(JSON.parse(split.socket.sent[0]).sessionId, 'session-a');
    split.desiredSessionId = 'session-b';
    assert.strictEqual(split.sendInput('stale', fence), false);
    assert.strictEqual(split.socket.sent.length, 1);
  });

  it('waits for a matching joined replay before resolving setSession', async function () {
    const { split, FakeWebSocket } = loadSplit();
    const pending = split.setSession('session-c');
    const socket = FakeWebSocket.instances[0];
    socket.onopen();
    socket.onmessage({ data: JSON.stringify({ type: 'session_joined', sessionId: 'session-c', active: true, outputBuffer: ['C'] }) });
    const result = await pending;
    assert.strictEqual(result.success, true);
    assert.strictEqual(split.committedSessionId, 'session-c');
    assert.strictEqual(split.paintedSessionId, 'session-c');
  });

  it('keeps a tab switch scoped to the active split', async function () {
    const { split } = loadSplit();
    const app = { currentClaudeSessionId: 'main-session' };
    split.setSession = async (sessionId) => { split.desiredSessionId = sessionId; };
    const container = {
      app,
      enabled: true,
      activeSplitIndex: 0,
      splits: [split],
      getActiveSplit() { return this.splits[this.activeSplitIndex]; },
    };
    await container.getActiveSplit().setSession('session-d');
    assert.strictEqual(split.desiredSessionId, 'session-d');
    assert.strictEqual(app.currentClaudeSessionId, 'main-session');
  });

  it('accepts optional matching transitionId and rejects stale transitionId', function () {
    const { split, terminal } = loadSplit();
    const fence = split._currentFence();
    split._awaitingJoinAck = true;
    split._beginReplay({ sessionId: 'session-a', transitionId: 1, active: false, renderedSnapshot: 'OK' }, fence);
    assert.ok(terminal.writes.length > 0);
    const second = loadSplit().split;
    second._awaitingJoinAck = true;
    second._transitionId = 2;
    second.transitionId = 2;
    second.desiredSessionId = 'session-a';
    const mismatchedFence = second._currentFence();
    second.handleMessage({ type: 'session_joined', sessionId: 'session-a', transitionId: 999, active: false, renderedSnapshot: 'BAD' }, mismatchedFence);
    assert.ok(!second._fenceMatches({ socketGeneration: 1, transitionId: 999, sessionId: 'session-a' }));
  });

  it('keeps explicit identity and generation fields', function () {
    const { split } = loadSplit();
    assert.ok('desiredSessionId' in split);
    assert.ok('committedSessionId' in split);
    assert.ok('paintedSessionId' in split);
    assert.ok('_transitionGeneration' in split);
    assert.ok('_socketGeneration' in split);
  });

  it('does not reconnect the main socket when split closes', function () {
    const source = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(!source.includes('this.app.connect()'));
  });
});

module.exports = { loadSplit };
