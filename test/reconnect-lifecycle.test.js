const assert = require('assert');

function mockElement() {
  return {
    style: {},
    textContent: '',
    innerHTML: '',
    appendChild() {},
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

global.window = global.window || {};
global.document = global.document || {
  hidden: false,
  createElement() { return mockElement(); },
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  head: { appendChild() {} },
  body: { appendChild() {} },
};
global.requestAnimationFrame = global.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
global.WebSocket = global.WebSocket || { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

const { ClaudeCodeWebInterface } = require('../src/public/app');

function createApp() {
  const app = Object.create(ClaudeCodeWebInterface.prototype);
  app.sessionTabManager = null;
  app.currentClaudeSessionId = null;
  app.socket = null;
  app._lastVisibleReconnectAt = 0;
  app._visibilityReconnectCooldownMs = 3000;
  app._socketConnectStartedAt = 0;
  app._replayJoinTimer = null;
  app._receivedSessionJoinedAfterConnect = false;
  app.isIOSDevice = () => false;
  app.send = () => {};
  return app;
}

describe('ClaudeCodeWebInterface reconnect lifecycle', function () {
  it('getReconnectSessionId should prefer active tab id', function () {
    const app = createApp();
    app.currentClaudeSessionId = 'current-session';
    app.sessionTabManager = { activeTabId: 'active-tab' };
    assert.strictEqual(app.getReconnectSessionId(), 'active-tab');
  });

  it('handleVisibilityChange should reconnect on visible when socket is closed', function () {
    const app = createApp();
    global.document.hidden = false;
    app.currentClaudeSessionId = 'session-1';
    app.socket = { readyState: WebSocket.CLOSED };
    let foregroundSessionId = null;
    let reconnectArgs = null;
    app.sendSessionPriority = (sessionId) => { foregroundSessionId = sessionId; };
    app.reconnect = (reason, delayMs) => { reconnectArgs = { reason, delayMs }; };

    app.handleVisibilityChange();

    assert.strictEqual(foregroundSessionId, 'session-1');
    assert.deepStrictEqual(reconnectArgs, { reason: 'visibility', delayMs: 0 });
  });

  it('handleVisibilityChange should not reconnect again during cooldown window', function () {
    const app = createApp();
    global.document.hidden = false;
    app.socket = { readyState: WebSocket.CLOSED };
    app._lastVisibleReconnectAt = Date.now();
    let reconnectCount = 0;
    app.reconnect = () => { reconnectCount++; };

    app.handleVisibilityChange();

    assert.strictEqual(reconnectCount, 0);
  });

  it('scheduleReplayJoin should send join_session when replay is needed', async function () {
    const app = createApp();
    app.socket = { readyState: WebSocket.OPEN };
    const sent = [];
    app.send = (msg) => sent.push(msg);

    app.scheduleReplayJoin('session-1', 5);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepStrictEqual(sent, [{ type: 'join_session', sessionId: 'session-1' }]);
  });

  it('scheduleReplayJoin should skip join_session once session_joined arrived', async function () {
    const app = createApp();
    app.socket = { readyState: WebSocket.OPEN };
    app._receivedSessionJoinedAfterConnect = true;
    let sendCount = 0;
    app.send = () => { sendCount++; };

    app.scheduleReplayJoin('session-1', 5);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.strictEqual(sendCount, 0);
  });

  it('handleVisibilityChange should not reconnect iOS sockets that are already open', function () {
    const app = createApp();
    global.document.hidden = false;
    app.isIOSDevice = () => true;
    app.socket = { readyState: WebSocket.OPEN };
    let reconnectArgs = null;
    app.reconnect = (reason, delayMs) => { reconnectArgs = { reason, delayMs }; };

    app.handleVisibilityChange();

    assert.strictEqual(reconnectArgs, null);
  });
});
