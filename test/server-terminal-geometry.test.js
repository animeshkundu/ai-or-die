'use strict';

const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

describe('server authoritative geometry transaction', function () {
  it('preserves existing held output and resizes every PTY-mirroring transcript after success', async function () {
    const order = [];
    const session = {
      active: true,
      agent: 'terminal',
      _geometryOutputHold: ['startup-output'],
      _ctlTranscript: {
        resize(cols, rows) { order.push(`transcript:${cols}x${rows}`); },
      },
    };
    const fake = {
      claudeSessions: new Map([['s1', session]]),
      getBridgeForAgent: () => ({
        async resize(_sessionId, cols, rows) {
          order.push(`pty:${cols}x${rows}`);
        },
      }),
      stickyNoteSummarizer: {
        isEnabled: () => true,
        resize(_sessionId, cols, rows) { order.push(`sticky:${cols}x${rows}`); },
      },
    };
    await ClaudeCodeWebServer.prototype._applyTerminalGeometry.call(
      fake,
      's1',
      { cols: 120, rows: 35 }
    );
    assert.deepStrictEqual(session._geometryOutputHold, ['startup-output']);
    assert.deepStrictEqual(order, [
      'pty:120x35',
      'transcript:120x35',
      'sticky:120x35',
    ]);
  });

  it('bounds held output and releases it after the watchdog expires', async function () {
    const broadcasts = [];
    const output = [];
    const session = {
      outputBuffer: { toArray: () => ['before-resize'] },
    };
    const fake = {
      claudeSessions: new Map([['s1', session]]),
      broadcastToSession(_sessionId, frame) { broadcasts.push(frame); },
      _throttledOutputBroadcast(_sessionId, data) { output.push(data); },
    };
    fake._releaseGeometryOutput = (sessionId) => (
      ClaudeCodeWebServer.prototype._releaseGeometryOutput.call(fake, sessionId)
    );

    ClaudeCodeWebServer.prototype._beginGeometryOutputHold.call(fake, 's1', 10);
    const chunkA = 'a'.repeat(5 * 1024 * 1024);
    const chunkB = 'b'.repeat(5 * 1024 * 1024);
    ClaudeCodeWebServer.prototype._broadcastOrHoldSessionOutput.call(fake, 's1', chunkA);
    ClaudeCodeWebServer.prototype._broadcastOrHoldSessionOutput.call(fake, 's1', chunkB);

    assert.strictEqual(session._geometryOutputHold.length, 1);
    assert.strictEqual(session._geometryOutputHold[0], chunkB);
    assert.strictEqual(session._geometryOutputDropped, 1);
    assert.deepStrictEqual(session._geometryReplayBuffer, ['before-resize']);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(session._geometryOutputHold, null);
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0], chunkB);
    assert.strictEqual(broadcasts[0].code, 'geometry_transaction_timeout');
    assert.strictEqual(broadcasts[1].code, 'geometry_output_truncated');
  });

  it('flushes pre-transaction coalesced output before starting the hold', function () {
    const order = [];
    const session = {
      outputBuffer: { toArray: () => ['before-resize'] },
    };
    const fake = {
      claudeSessions: new Map([['s1', session]]),
      _flushAndClearOutputTimer() {
        assert.strictEqual(session._geometryOutputHold, undefined);
        order.push('flush');
      },
      _releaseGeometryOutput: ClaudeCodeWebServer.prototype._releaseGeometryOutput,
      broadcastToSession() {},
      _throttledOutputBroadcast() {},
    };

    ClaudeCodeWebServer.prototype._beginGeometryOutputHold.call(fake, 's1');
    order.push('hold');
    fake._releaseGeometryOutput('s1');
    assert.deepStrictEqual(order, ['flush', 'hold']);
  });

  it('does not claim geometry for idempotent or rejected start requests', async function () {
    const advertised = [];
    const claims = [];
    const messages = [];
    const session = {
      active: true,
      agent: 'terminal',
      workingDir: process.cwd(),
    };
    const fake = {
      webSocketConnections: new Map([['ws1', {
        claudeSessionId: 's1',
        ws: {},
      }]]),
      claudeSessions: new Map([['s1', session]]),
      terminalGeometry: {
        async advertise(...args) { advertised.push(args); },
        async takeControl(...args) { claims.push(args); },
      },
      sendToWebSocket(_ws, frame) { messages.push(frame); },
    };
    const bridge = {
      _commandReady: Promise.resolve(),
      isAvailable: () => true,
    };

    await ClaudeCodeWebServer.prototype.startToolSession.call(
      fake,
      'ws1',
      'terminal',
      bridge,
      {},
      120,
      35,
      'main'
    );
    assert.strictEqual(advertised.length, 1);
    assert.strictEqual(claims.length, 0);
    assert.strictEqual(messages[0].type, 'terminal_started');

    session.active = false;
    bridge.isAvailable = () => false;
    await ClaudeCodeWebServer.prototype.startToolSession.call(
      fake,
      'ws1',
      'terminal',
      bridge,
      {},
      100,
      30,
      'main'
    );
    assert.strictEqual(advertised.length, 2);
    assert.strictEqual(claims.length, 0);
    assert.strictEqual(messages.at(-1).type, 'error');
  });
});
