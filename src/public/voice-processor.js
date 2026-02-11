'use strict';

/**
 * AudioWorklet processor for voice recording.
 *
 * Runs off the main thread. Forwards mono audio chunks to the main
 * thread via port.postMessage for accumulation by LocalVoiceRecorder.
 */
class VoiceProcessor extends AudioWorkletProcessor {
  process(inputs) {
    var input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Copy the mono channel and send to main thread
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}

registerProcessor('voice-processor', VoiceProcessor);
