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
});
