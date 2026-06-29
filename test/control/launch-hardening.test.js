'use strict';

// F6 — control-spawned PTYs must disable interactive pagers + credential prompts
// so a headless fleet shell can't hang on `git log | less`. We drive the real
// _controlStartAgent on the prototype with a stub bridge that captures the
// options.extraEnv handed to bridge.startSession.

const assert = require('assert');
const { ClaudeCodeWebServer } = require('../../src/server');

const proto = ClaudeCodeWebServer.prototype;

describe('F6 control-spawned pager/prompt hardening', function () {
  async function startAndCaptureEnv(agent) {
    const sid = 's-pager';
    const captured = {};
    const stubBridge = {
      _commandReady: Promise.resolve(),
      isAvailable: () => true,
      startSession: async (id, options) => { captured.extraEnv = options.extraEnv; return {}; },
    };
    const fakeThis = {
      claudeSessions: new Map([[sid, { id: sid, workingDir: '/tmp', outputBuffer: { push() {} }, active: false }]]),
      getBridgeForAgent: () => stubBridge,
      _prepareClaudeBindSidecar: () => null,
      auth: null,
      activityBroadcastTimestamps: new Map(),
      sessionStore: { markDirty() {} },
      controlEventBus: null,
      _maybeStartStickyNotes: () => {},
      _controlReapTrustPrompt: () => {},
      _controlError: proto._controlError,
      _artifactEnvForSession: proto._artifactEnvForSession,
    };
    await proto._controlStartAgent.call(fakeThis, sid, agent, {});
    return captured.extraEnv;
  }

  it('sets GIT_PAGER/PAGER/GIT_TERMINAL_PROMPT for a control-spawned terminal', async function () {
    const env = await startAndCaptureEnv('terminal');
    assert.equal(env.GIT_PAGER, 'cat');
    assert.equal(env.PAGER, 'cat');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  });

  it('also covers the pagers that ignore PAGER', async function () {
    const env = await startAndCaptureEnv('terminal');
    assert.equal(env.GH_PAGER, 'cat');
    assert.equal(env.DELTA_PAGER, 'cat');
    assert.equal(env.MANPAGER, 'cat');
    assert.equal(env.AWS_PAGER, '');
    assert.equal(env.SYSTEMD_PAGER, '');
    assert.equal(env.LESS, 'FRX');
  });

  it('applies to a control-spawned claude too (headless agent has no human to press q)', async function () {
    const env = await startAndCaptureEnv('claude');
    assert.equal(env.GIT_PAGER, 'cat');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  });
});
