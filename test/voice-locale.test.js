'use strict';

const assert = require('assert');
const { SpeechRecognitionRecorder } = require('../src/public/voice-handler');

// The cloud (browser SpeechRecognition) recorder must request the en-IN locale.
// This is the only locale knob in the codebase; the local parakeet path takes none.

describe('voice: cloud recognition locale', function () {
  it('requests en-IN', async function () {
    let captured = null;

    function FakeRecognition() {
      this.continuous = false;
      this.interimResults = false;
      this.lang = null;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this.onstart = null;
      captured = this;
    }
    FakeRecognition.prototype.start = function () {
      const self = this;
      setTimeout(function () { if (self.onstart) self.onstart(); }, 0);
    };
    FakeRecognition.prototype.stop = function () {};
    FakeRecognition.prototype.abort = function () {};

    const prevWindow = global.window;
    global.window = { SpeechRecognition: FakeRecognition, isSecureContext: true };
    try {
      const rec = new SpeechRecognitionRecorder();
      await rec.start();
      assert.ok(captured, 'a recognition instance was created');
      assert.strictEqual(captured.lang, 'en-IN');
    } finally {
      if (prevWindow === undefined) {
        delete global.window;
      } else {
        global.window = prevWindow;
      }
    }
  });
});
