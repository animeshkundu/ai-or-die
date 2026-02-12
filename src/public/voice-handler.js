'use strict';

/**
 * Voice recording handler for Claude Code Web.
 *
 * Two recording backends:
 *   - SpeechRecognitionRecorder (cloud mode): browser-native SpeechRecognition API
 *   - LocalVoiceRecorder (local mode): Web Audio API capture → Int16 PCM → server
 *
 * Plus a VoiceInputController that manages push-to-talk vs toggle detection.
 *
 * Follows the same dual-export pattern as image-handler.js:
 *   - Browser: exposes window.VoiceHandler
 *   - Node.js:  module.exports for unit testing
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var MAX_RECORDING_SECONDS = 120;
var MIN_RECORDING_SECONDS = 0.5;
var PUSH_TO_TALK_THRESHOLD_MS = 300;
var TARGET_SAMPLE_RATE = 16000;
// ---------------------------------------------------------------------------
// Utility: Float32 → Int16 conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Float32Array of audio samples to Int16Array (PCM16).
 * Clamps values to [-1, 1] before scaling.
 *
 * @param {Float32Array} float32Array
 * @returns {Int16Array}
 */
function float32ToInt16(float32Array) {
  var len = float32Array.length;
  var int16 = new Int16Array(len);
  for (var i = 0; i < len; i++) {
    var s = float32Array[i];
    // Clamp to [-1, 1]
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}

// ---------------------------------------------------------------------------
// Utility: Resample
// ---------------------------------------------------------------------------

/**
 * Resample audio samples via linear interpolation.
 *
 * @param {Float32Array} samples - Input samples
 * @param {number} fromRate - Source sample rate
 * @param {number} toRate - Target sample rate
 * @returns {Float32Array}
 */
function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) {
    return samples;
  }
  var ratio = fromRate / toRate;
  var outputLength = Math.round(samples.length / ratio);
  var output = new Float32Array(outputLength);
  for (var i = 0; i < outputLength; i++) {
    var srcIndex = i * ratio;
    var low = Math.floor(srcIndex);
    var high = Math.min(low + 1, samples.length - 1);
    var frac = srcIndex - low;
    output[i] = samples[low] * (1 - frac) + samples[high] * frac;
  }
  return output;
}

// ---------------------------------------------------------------------------
// SpeechRecognitionRecorder — Cloud mode
// ---------------------------------------------------------------------------

/**
 * Cloud-mode recorder using the browser's built-in SpeechRecognition API.
 * Audio is sent to Google/cloud for transcription. No audio data touches
 * our server — text results are returned directly.
 *
 * @constructor
 */
function SpeechRecognitionRecorder() {
  this._recognition = null;
  this._recording = false;
  this._startTime = null;
  this._resultText = '';
  this._resolveStop = null;
  this._rejectStop = null;
}

/**
 * Whether the SpeechRecognition API is available in this browser.
 * @returns {boolean}
 */
SpeechRecognitionRecorder.isSupported = function () {
  return !!(typeof window !== 'undefined' &&
    (window.SpeechRecognition || window.webkitSpeechRecognition));
};

/**
 * Start cloud speech recognition.
 * @returns {Promise<void>}
 */
SpeechRecognitionRecorder.prototype.start = function () {
  var self = this;
  if (self._recording) {
    return Promise.reject(new Error('Already recording'));
  }

  return new Promise(function (resolve, reject) {
    var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      return reject(new Error('SpeechRecognition API not available'));
    }

    var recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    self._recognition = recognition;
    self._resultText = '';
    self._recording = true;
    self._startTime = Date.now();

    recognition.onresult = function (event) {
      for (var i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          var transcript = event.results[i][0].transcript;
          if (self._resultText) {
            self._resultText += ' ';
          }
          self._resultText += transcript;
        }
      }
    };

    recognition.onerror = function (event) {
      self._recording = false;
      if (self._rejectStop) {
        self._rejectStop(new Error('Speech recognition error: ' + event.error));
        self._rejectStop = null;
        self._resolveStop = null;
      } else {
        reject(new Error('Speech recognition error: ' + event.error));
      }
    };

    recognition.onend = function () {
      self._recording = false;
      if (self._resolveStop) {
        var durationMs = Date.now() - self._startTime;
        self._resolveStop({ text: self._resultText, durationMs: durationMs });
        self._resolveStop = null;
        self._rejectStop = null;
      }
    };

    recognition.onstart = function () {
      resolve();
    };

    try {
      recognition.start();
    } catch (err) {
      self._recording = false;
      reject(err);
    }
  });
};

/**
 * Stop cloud speech recognition and return the transcribed text.
 * @returns {Promise<{ text: string, durationMs: number }>}
 */
SpeechRecognitionRecorder.prototype.stop = function () {
  var self = this;
  if (!self._recording || !self._recognition) {
    return Promise.resolve({ text: '', durationMs: 0 });
  }

  return new Promise(function (resolve, reject) {
    self._resolveStop = resolve;
    self._rejectStop = reject;
    try {
      self._recognition.stop();
    } catch (err) {
      self._recording = false;
      self._resolveStop = null;
      self._rejectStop = null;
      reject(err);
    }
  });
};

Object.defineProperty(SpeechRecognitionRecorder.prototype, 'isRecording', {
  get: function () { return this._recording; }
});

Object.defineProperty(SpeechRecognitionRecorder.prototype, 'elapsed', {
  get: function () {
    if (!this._startTime) return 0;
    return Math.floor((Date.now() - this._startTime) / 1000);
  }
});

/**
 * Abort and clean up the recognition instance.
 */
SpeechRecognitionRecorder.prototype.destroy = function () {
  this._recording = false;
  this._resolveStop = null;
  this._rejectStop = null;
  if (this._recognition) {
    try { this._recognition.abort(); } catch (e) { /* ignore */ }
    this._recognition = null;
  }
};

// ---------------------------------------------------------------------------
// LocalVoiceRecorder — Local mode (Web Audio API)
// ---------------------------------------------------------------------------

/**
 * Local-mode recorder. Captures audio via Web Audio API (AudioWorklet primary,
 * ScriptProcessorNode fallback), resamples to 16kHz if needed, and returns
 * Int16 PCM samples for server-side transcription.
 *
 * @constructor
 */
function LocalVoiceRecorder() {
  this._recording = false;
  this._startTime = null;
  this._audioContext = null;
  this._stream = null;
  this._sourceNode = null;
  this._workletNode = null;
  this._scriptNode = null;
  this._chunks = [];
  this._needsResample = false;
  this._nativeSampleRate = TARGET_SAMPLE_RATE;
  this._autoStopTimer = null;
  this._resolveStop = null;
}

/**
 * Create an AudioContext, preferring 16kHz for Chromium (skips resampling).
 * Falls back to native sample rate for Firefox/Safari.
 *
 * @returns {{ ctx: AudioContext, needsResample: boolean }}
 */
LocalVoiceRecorder.prototype._createRecordingContext = function () {
  var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('Web Audio API not available');
  }

  // Chromium fast path: request 16kHz directly
  try {
    var ctx = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
    if (ctx.sampleRate === TARGET_SAMPLE_RATE) {
      return { ctx: ctx, needsResample: false };
    }
    ctx.close();
  } catch (e) {
    // Firefox throws on non-standard sample rates — expected
  }

  // Fallback: use native sample rate, resample client-side
  return { ctx: new AudioContextCtor(), needsResample: true };
};

/**
 * Start local audio recording.
 * @returns {Promise<void>}
 */
LocalVoiceRecorder.prototype.start = function () {
  var self = this;
  if (self._recording) {
    return Promise.reject(new Error('Already recording'));
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true
    }
  }).then(function (stream) {
    var ctxInfo = self._createRecordingContext();
    self._audioContext = ctxInfo.ctx;
    self._needsResample = ctxInfo.needsResample;
    self._nativeSampleRate = self._audioContext.sampleRate;
    self._stream = stream;
    self._chunks = [];
    self._recording = true;
    self._startTime = Date.now();

    self._sourceNode = self._audioContext.createMediaStreamSource(stream);

    // Set up auto-stop timer
    self._autoStopTimer = setTimeout(function () {
      if (self._recording) {
        self._forceStop();
      }
    }, MAX_RECORDING_SECONDS * 1000);

    // Try AudioWorklet first, fall back to ScriptProcessorNode
    return self._attachWorklet().catch(function () {
      return self._attachScriptProcessor();
    });
  });
};

/**
 * Attach AudioWorklet processor for off-main-thread capture.
 * @returns {Promise<void>}
 */
LocalVoiceRecorder.prototype._attachWorklet = function () {
  var self = this;
  if (!self._audioContext.audioWorklet) {
    return Promise.reject(new Error('AudioWorklet not supported'));
  }

  return self._audioContext.audioWorklet.addModule('voice-processor.js').then(function () {
    var workletNode = new AudioWorkletNode(self._audioContext, 'voice-processor');
    workletNode.port.onmessage = function (event) {
      if (self._recording && event.data instanceof Float32Array) {
        self._chunks.push(event.data);
      }
    };
    self._sourceNode.connect(workletNode);
    workletNode.connect(self._audioContext.destination);
    self._workletNode = workletNode;
  });
};

/**
 * Attach ScriptProcessorNode fallback for older browsers.
 * @returns {Promise<void>}
 */
LocalVoiceRecorder.prototype._attachScriptProcessor = function () {
  var self = this;
  return new Promise(function (resolve) {
    var scriptNode = self._audioContext.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = function (event) {
      if (self._recording) {
        var inputData = event.inputBuffer.getChannelData(0);
        self._chunks.push(new Float32Array(inputData));
      }
    };
    self._sourceNode.connect(scriptNode);
    scriptNode.connect(self._audioContext.destination);
    self._scriptNode = scriptNode;
    resolve();
  });
};

/**
 * Stop local audio recording and return the captured PCM samples.
 * @returns {Promise<{ samples: Int16Array, durationMs: number }>}
 */
LocalVoiceRecorder.prototype.stop = function () {
  var self = this;
  if (!self._recording) {
    return Promise.resolve({ samples: new Int16Array(0), durationMs: 0 });
  }

  return new Promise(function (resolve) {
    self._resolveStop = resolve;
    self._stopInternal();
  });
};

/**
 * Internal stop logic — disconnects nodes, processes audio, resolves promise.
 */
LocalVoiceRecorder.prototype._stopInternal = function () {
  var self = this;
  self._recording = false;
  var durationMs = Date.now() - self._startTime;

  if (self._autoStopTimer) {
    clearTimeout(self._autoStopTimer);
    self._autoStopTimer = null;
  }

  // Disconnect audio nodes
  if (self._workletNode) {
    try { self._sourceNode.disconnect(self._workletNode); } catch (e) { /* ignore */ }
    try { self._workletNode.disconnect(); } catch (e) { /* ignore */ }
    self._workletNode = null;
  }
  if (self._scriptNode) {
    try { self._sourceNode.disconnect(self._scriptNode); } catch (e) { /* ignore */ }
    try { self._scriptNode.disconnect(); } catch (e) { /* ignore */ }
    self._scriptNode = null;
  }
  self._sourceNode = null;

  // Stop all media tracks
  if (self._stream) {
    var tracks = self._stream.getTracks();
    for (var i = 0; i < tracks.length; i++) {
      tracks[i].stop();
    }
    self._stream = null;
  }

  // Close audio context
  if (self._audioContext) {
    try { self._audioContext.close(); } catch (e) { /* ignore */ }
    self._audioContext = null;
  }

  // Concatenate chunks
  var totalLength = 0;
  for (var j = 0; j < self._chunks.length; j++) {
    totalLength += self._chunks[j].length;
  }

  var concatenated = new Float32Array(totalLength);
  var offset = 0;
  for (var k = 0; k < self._chunks.length; k++) {
    concatenated.set(self._chunks[k], offset);
    offset += self._chunks[k].length;
  }
  self._chunks = [];

  // Resample if needed
  var resampled = self._needsResample
    ? resample(concatenated, self._nativeSampleRate, TARGET_SAMPLE_RATE)
    : concatenated;

  // Convert to Int16
  var int16 = float32ToInt16(resampled);

  if (self._resolveStop) {
    self._resolveStop({ samples: int16, durationMs: durationMs });
    self._resolveStop = null;
  }
};

/**
 * Force stop from auto-stop timer. Creates its own resolve handler
 * so _stopInternal can resolve even when stop() was never called.
 */
LocalVoiceRecorder.prototype._forceStop = function () {
  var self = this;
  if (!self._recording) return;
  // Provide a resolve handler so _stopInternal can deliver the result
  if (!self._resolveStop) {
    self._resolveStop = function () { /* discard — no external caller waiting */ };
  }
  self._stopInternal();
};

Object.defineProperty(LocalVoiceRecorder.prototype, 'isRecording', {
  get: function () { return this._recording; }
});

Object.defineProperty(LocalVoiceRecorder.prototype, 'elapsed', {
  get: function () {
    if (!this._startTime) return 0;
    return Math.floor((Date.now() - this._startTime) / 1000);
  }
});

/**
 * Abort and clean up all audio resources.
 */
LocalVoiceRecorder.prototype.destroy = function () {
  this._recording = false;
  this._resolveStop = null;

  if (this._autoStopTimer) {
    clearTimeout(this._autoStopTimer);
    this._autoStopTimer = null;
  }

  if (this._workletNode) {
    try { this._sourceNode.disconnect(this._workletNode); } catch (e) { /* ignore */ }
    try { this._workletNode.disconnect(); } catch (e) { /* ignore */ }
    this._workletNode = null;
  }
  if (this._scriptNode) {
    try { this._sourceNode.disconnect(this._scriptNode); } catch (e) { /* ignore */ }
    try { this._scriptNode.disconnect(); } catch (e) { /* ignore */ }
    this._scriptNode = null;
  }
  this._sourceNode = null;

  if (this._stream) {
    var tracks = this._stream.getTracks();
    for (var i = 0; i < tracks.length; i++) {
      tracks[i].stop();
    }
    this._stream = null;
  }

  if (this._audioContext) {
    try { this._audioContext.close(); } catch (e) { /* ignore */ }
    this._audioContext = null;
  }

  this._chunks = [];
};

// ---------------------------------------------------------------------------
// VoiceInputController — Push-to-talk + Toggle detection
// ---------------------------------------------------------------------------

/**
 * Manages voice recording mode (cloud vs local), handles push-to-talk vs
 * toggle detection for Ctrl+Shift+M, and dispatches recording lifecycle
 * callbacks.
 *
 * @constructor
 * @param {Object} options
 * @param {string} options.mode - 'cloud' or 'local'
 * @param {function} [options.onRecordingStart] - Called when recording begins
 * @param {function} [options.onRecordingStop] - Called with { samples?, text?, durationMs }
 * @param {function} [options.onTranscription] - Called with transcription text (cloud mode)
 * @param {function} [options.onError] - Called with Error object
 * @param {function} [options.onCancel] - Called when recording is cancelled (e.g. Escape key)
 */
function VoiceInputController(options) {
  this._mode = options.mode || 'cloud';
  this._onRecordingStart = options.onRecordingStart || null;
  this._onRecordingStop = options.onRecordingStop || null;
  this._onTranscription = options.onTranscription || null;
  this._onError = options.onError || null;
  this._onCancel = options.onCancel || null;

  this._recorder = null;
  this._keydownTime = null;
  this._isPushToTalk = false;
  this._pttTimer = null;
  // When set to 'push-to-talk' or 'toggle', overrides auto-detection
  this._forcedMode = null;

  this._boundKeyDown = this._onKeyDown.bind(this);
  this._boundKeyUp = this._onKeyUp.bind(this);
}

/**
 * Set the recording mode and re-create the recorder if needed.
 * @param {string} mode - 'cloud' or 'local'
 */
VoiceInputController.prototype.setMode = function (mode) {
  if (mode !== 'cloud' && mode !== 'local') return;
  if (this._recorder && this._recorder.isRecording) return;
  this._mode = mode;
  if (this._recorder) {
    this._recorder.destroy();
    this._recorder = null;
  }
};

/**
 * Create the appropriate recorder for the current mode.
 * @returns {SpeechRecognitionRecorder|LocalVoiceRecorder}
 */
VoiceInputController.prototype._createRecorder = function () {
  if (this._mode === 'cloud') {
    return new SpeechRecognitionRecorder();
  }
  return new LocalVoiceRecorder();
};

/**
 * Start recording. Can be called from button click or keyboard shortcut.
 */
VoiceInputController.prototype.startRecording = function () {
  var self = this;
  if (self._recorder && self._recorder.isRecording) return;

  self._recorder = self._createRecorder();

  self._recorder.start().then(function () {
    if (self._onRecordingStart) {
      self._onRecordingStart();
    }
  }).catch(function (err) {
    if (self._onError) {
      self._onError(err);
    }
  });
};

/**
 * Stop recording and process the result.
 */
VoiceInputController.prototype.stopRecording = function () {
  var self = this;
  if (!self._recorder || !self._recorder.isRecording) return;

  self._recorder.stop().then(function (result) {
    var durationMs = result.durationMs || 0;

    // Discard recordings shorter than MIN_RECORDING_SECONDS
    if (durationMs < MIN_RECORDING_SECONDS * 1000) {
      if (self._onError) {
        self._onError(new Error('Recording too short (minimum ' + MIN_RECORDING_SECONDS + ' seconds)'));
      }
      return;
    }

    if (self._onRecordingStop) {
      self._onRecordingStop(result);
    }

    // Cloud mode returns text directly
    if (self._mode === 'cloud' && result.text && self._onTranscription) {
      self._onTranscription(result.text);
    }
  }).catch(function (err) {
    if (self._onError) {
      self._onError(err);
    }
  });
};

/**
 * Cancel an active recording and discard all captured data.
 */
VoiceInputController.prototype.cancelRecording = function () {
  if (this._recorder) {
    this._recorder.destroy();
    this._recorder = null;
  }
  if (this._onCancel) {
    this._onCancel();
  }
};

/**
 * Toggle recording on/off (for button clicks).
 */
VoiceInputController.prototype.toggleRecording = function () {
  if (this._recorder && this._recorder.isRecording) {
    this.stopRecording();
  } else {
    this.startRecording();
  }
};

Object.defineProperty(VoiceInputController.prototype, 'isRecording', {
  get: function () {
    return !!(this._recorder && this._recorder.isRecording);
  }
});

Object.defineProperty(VoiceInputController.prototype, 'elapsed', {
  get: function () {
    if (!this._recorder) return 0;
    return this._recorder.elapsed;
  }
});

/**
 * Handle keydown for Ctrl+Shift+M — record timestamp for PTT detection.
 *
 * Detection strategy (same pattern as Wispr Flow / Discord):
 *   - On keydown: record timestamp, start a 300ms timer
 *   - If timer fires (key still held): enter push-to-talk mode, start recording
 *   - On keyup before timer: toggle mode — start or stop recording
 *
 * @param {KeyboardEvent} e
 */
VoiceInputController.prototype._onKeyDown = function (e) {
  if (e.ctrlKey && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault();
    e.stopPropagation();

    // Ignore key repeat events
    if (e.repeat) return;

    // Forced toggle mode: second press stops recording
    if (this._forcedMode === 'toggle') {
      if (this._recorder && this._recorder.isRecording) {
        this.stopRecording();
      } else {
        this._isPushToTalk = false;
        this.startRecording();
      }
      this._keydownTime = null;
      return;
    }

    // Forced push-to-talk mode: start on keydown, stop on keyup
    if (this._forcedMode === 'push-to-talk') {
      if (this._keydownTime) return;
      this._keydownTime = Date.now();
      this._isPushToTalk = true;
      this.startRecording();
      return;
    }

    // Auto-detection: original behavior
    // If already recording in toggle mode, stop on second press
    if (this._recorder && this._recorder.isRecording && !this._isPushToTalk) {
      this.stopRecording();
      this._keydownTime = null;
      return;
    }

    // Don't start a new detection cycle if one is active
    if (this._keydownTime) return;

    // Record keydown time and start PTT detection timer
    this._keydownTime = Date.now();
    var self = this;
    this._pttTimer = setTimeout(function () {
      self._pttTimer = null;
      // Key held past threshold — enter push-to-talk mode
      if (self._keydownTime && !self.isRecording) {
        self._isPushToTalk = true;
        self.startRecording();
      }
    }, PUSH_TO_TALK_THRESHOLD_MS);
  }

  // Escape cancels recording
  if (e.key === 'Escape' && this._recorder && this._recorder.isRecording) {
    e.preventDefault();
    this.cancelRecording();
    this._keydownTime = null;
    this._isPushToTalk = false;
    if (this._pttTimer) {
      clearTimeout(this._pttTimer);
      this._pttTimer = null;
    }
  }
};

/**
 * Handle keyup for Ctrl+Shift+M — determine toggle vs push-to-talk.
 * @param {KeyboardEvent} e
 */
VoiceInputController.prototype._onKeyUp = function (e) {
  if (e.key === 'm' || e.key === 'M') {
    // Forced toggle mode: keyup is a no-op (start/stop handled in keydown)
    if (this._forcedMode === 'toggle') {
      this._keydownTime = null;
      return;
    }

    // Forced push-to-talk mode: stop recording on keyup
    if (this._forcedMode === 'push-to-talk') {
      if (this._keydownTime && this._isPushToTalk && this._recorder && this._recorder.isRecording) {
        this._isPushToTalk = false;
        this.stopRecording();
      }
      this._keydownTime = null;
      return;
    }

    // Auto-detection: original behavior
    if (!this._keydownTime) return;

    var elapsed = Date.now() - this._keydownTime;
    this._keydownTime = null;

    // Cancel the PTT detection timer if it hasn't fired yet
    if (this._pttTimer) {
      clearTimeout(this._pttTimer);
      this._pttTimer = null;
    }

    if (elapsed < PUSH_TO_TALK_THRESHOLD_MS) {
      // Quick press: toggle mode — start recording
      if (!this._recorder || !this._recorder.isRecording) {
        this._isPushToTalk = false;
        this.startRecording();
      }
    } else {
      // Long press: push-to-talk — stop recording on release
      if (this._isPushToTalk && this._recorder && this._recorder.isRecording) {
        this._isPushToTalk = false;
        this.stopRecording();
      }
    }
  }
};

/**
 * Attach keyboard listeners to the document for Ctrl+Shift+M handling.
 */
VoiceInputController.prototype.attachKeyboardListeners = function () {
  document.addEventListener('keydown', this._boundKeyDown, true);
  document.addEventListener('keyup', this._boundKeyUp, true);
};

/**
 * Remove keyboard listeners.
 */
VoiceInputController.prototype.detachKeyboardListeners = function () {
  document.removeEventListener('keydown', this._boundKeyDown, true);
  document.removeEventListener('keyup', this._boundKeyUp, true);
};

/**
 * Clean up everything.
 */
VoiceInputController.prototype.destroy = function () {
  this.detachKeyboardListeners();
  if (this._pttTimer) {
    clearTimeout(this._pttTimer);
    this._pttTimer = null;
  }
  if (this._recorder) {
    this._recorder.destroy();
    this._recorder = null;
  }
  this._keydownTime = null;
  this._isPushToTalk = false;
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

var voiceHandlerExports = {
  // Constants
  MAX_RECORDING_SECONDS: MAX_RECORDING_SECONDS,
  MIN_RECORDING_SECONDS: MIN_RECORDING_SECONDS,
  PUSH_TO_TALK_THRESHOLD_MS: PUSH_TO_TALK_THRESHOLD_MS,
  TARGET_SAMPLE_RATE: TARGET_SAMPLE_RATE,

  // Utilities
  float32ToInt16: float32ToInt16,
  resample: resample,

  // Recorders
  SpeechRecognitionRecorder: SpeechRecognitionRecorder,
  LocalVoiceRecorder: LocalVoiceRecorder,

  // Controller
  VoiceInputController: VoiceInputController
};

// Browser: expose on window
if (typeof window !== 'undefined') {
  window.VoiceHandler = voiceHandlerExports;
}

// Node.js: CommonJS export for unit testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = voiceHandlerExports;
}
