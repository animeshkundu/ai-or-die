'use strict';

// A terminal tab where the user runs `github-router claude` themselves gets the
// same artifact-review trio a claude tab gets (server.js:5210). The trio embeds
// the per-tab sessionId, so multiple terminal claudes never share a review.

const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

const proto = ClaudeCodeWebServer.prototype;

describe('artifact env trio (terminal tab)', function () {
  it('produces a complete trio for a terminal-tab session', function () {
    const server = new ClaudeCodeWebServer({ noAuth: true, port: 7777, https: true });
    const env = server._artifactEnvForSession('term-1');
    assert.strictEqual(env.AIORDIE_BASE_URL, 'https://127.0.0.1:7777');
    assert.strictEqual(env.AIORDIE_TOKEN, 'noauth');
    assert.strictEqual(env.AIORDIE_SESSION_ID, 'term-1');
  });

  it('keeps two terminal tabs isolated by distinct AIORDIE_SESSION_ID', function () {
    const server = new ClaudeCodeWebServer({ auth: 'tok-x', port: 7777 });
    const a = server._artifactEnvForSession('term-a');
    const b = server._artifactEnvForSession('term-b');
    assert.strictEqual(a.AIORDIE_SESSION_ID, 'term-a');
    assert.strictEqual(b.AIORDIE_SESSION_ID, 'term-b');
    assert.notStrictEqual(a.AIORDIE_SESSION_ID, b.AIORDIE_SESSION_ID);
  });
});

// Regression: the GATE lives in the manual startToolSession path. Before the
// fix it was `toolName === 'claude'`, so a terminal tab got no trio and an
// in-terminal github-router stayed NOT_IN_AIORDIE_TAB. Drive the real method
// with a stub bridge and capture the extraEnv handed to bridge.startSession.
describe('startToolSession injects artifact trio for terminal + claude tabs', function () {
  async function captureEnv(toolName) {
    const sid = 'sess-gate';
    const captured = {};
    const bridge = {
      _commandReady: Promise.resolve(),
      isAvailable: () => true,
      startSession: async (id, options) => { captured.extraEnv = options.extraEnv; return {}; },
    };
    const fakeThis = {
      webSocketConnections: new Map([['ws1', { ws: {}, claudeSessionId: sid }]]),
      claudeSessions: new Map([[sid, { id: sid, workingDir: '/tmp', outputBuffer: { push() {} }, active: false }]]),
      getBridgeForAgent: () => bridge,
      _prepareClaudeBindSidecar: () => '/tmp/bind.json',
      _artifactEnvForSession: proto._artifactEnvForSession,
      auth: null, noAuth: true, port: 7778, useHttps: false,
      activityBroadcastTimestamps: new Map(),
      sessionStore: { markDirty() {} },
      sendToWebSocket() {}, broadcastToSession() {}, broadcastSessionActivity() {},
      _pushEvictionEntry() {}, _maybeStartStickyNotes() {}, validatePath: () => true, dev: false,
    };
    await proto.startToolSession.call(fakeThis, 'ws1', toolName, bridge, {}, 80, 24);
    return captured.extraEnv;
  }

  it('terminal tab gets the trio (the fix)', async function () {
    const env = await captureEnv('terminal');
    assert.strictEqual(env.AIORDIE_BASE_URL, 'http://127.0.0.1:7778');
    assert.strictEqual(env.AIORDIE_TOKEN, 'noauth');
    assert.strictEqual(env.AIORDIE_SESSION_ID, 'sess-gate');
    assert.strictEqual(env.AIORDIE_CLAUDE_BIND, '/tmp/bind.json'); // sidecar still rides along
  });

  it('claude tab still gets the trio', async function () {
    const env = await captureEnv('claude');
    assert.strictEqual(env.AIORDIE_SESSION_ID, 'sess-gate');
    assert.ok(env.AIORDIE_BASE_URL && env.AIORDIE_TOKEN);
  });

  it('codex tab gets NO trio (gate unchanged for others)', async function () {
    const env = await captureEnv('codex');
    assert.strictEqual(env.AIORDIE_BASE_URL, undefined);
    assert.strictEqual(env.AIORDIE_SESSION_ID, undefined);
  });
});
