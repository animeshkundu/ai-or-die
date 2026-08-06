'use strict';

const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');
const CircularBuffer = require('../src/utils/circular-buffer');

describe('session join replay buffer', function () {
  it('keeps the newest chunks within the byte budget', function () {
    const outputBuffer = new CircularBuffer(1000);
    outputBuffer.push('12345');
    outputBuffer.push('67890');
    outputBuffer.push('abc');
    const replay = ClaudeCodeWebServer.prototype._buildJoinReplay(
      { outputBuffer },
      8
    );
    assert.deepStrictEqual(replay, ['67890', 'abc']);
  });

  it('retains the newest chunk when it alone exceeds the budget', function () {
    const outputBuffer = new CircularBuffer(1000);
    outputBuffer.push('older');
    outputBuffer.push('newest-is-large');
    const replay = ClaudeCodeWebServer.prototype._buildJoinReplay(
      { outputBuffer },
      4
    );
    assert.deepStrictEqual(replay, ['newest-is-large']);
  });

  it('excludes geometry-held output that will be released after the join frame', function () {
    const outputBuffer = new CircularBuffer(1000);
    outputBuffer.push('before-resize');
    outputBuffer.push('held-redraw-a');
    outputBuffer.push('held-redraw-b');
    const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
      outputBuffer,
      _geometryOutputHold: ['held-redraw-a', 'held-redraw-b'],
      _geometryReplayBuffer: ['before-resize'],
    });
    assert.deepStrictEqual(replay, ['before-resize']);
  });

  it('keeps the pre-transaction replay stable when held output exceeds the ring', function () {
    const outputBuffer = new CircularBuffer(3);
    outputBuffer.push('held-c');
    outputBuffer.push('held-d');
    outputBuffer.push('held-e');
    const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
      outputBuffer,
      _geometryOutputHold: ['held-a', 'held-b', 'held-c', 'held-d', 'held-e'],
      _geometryReplayBuffer: ['before-resize'],
    });
    assert.deepStrictEqual(replay, ['before-resize']);
  });
});
