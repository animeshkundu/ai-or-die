'use strict';

const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const ModelManager = require('./utils/model-manager');
const ModelHost = require('./model-host');

const COLD_START_TIMEOUT_MS = 25000;
const TRANSCRIPTION_TIMEOUT_MS = 60000;
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

class SttEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this._enabled = !!options.enabled;
    this._sttEndpoint = options.sttEndpoint || null;
    this._numThreads = options.numThreads || Math.min(4, os.cpus().length);
    this._downloadProgress = null;
    this._initPromise = null;
    this._stopping = false;
    this._modelManager = options.modelManager || new ModelManager({ modelsDir: options.modelsDir });
    this._hostFactory = options.hostFactory || ((hostOptions) => new ModelHost(hostOptions));
    this._host = null;
    this._pendingRequests = 0;
    this._lifecycleState = (!this._enabled && !this._sttEndpoint) ? 'disabled' : 'idle';
  }

  async ensureDownloaded(onProgress) {
    if (!this._enabled && !this._sttEndpoint) {
      this._lifecycleState = 'disabled';
      return;
    }
    if (this._sttEndpoint) {
      this._lifecycleState = 'ready';
      return;
    }
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      if (!(await this._modelManager.isModelReady())) {
        this._lifecycleState = 'downloading';
        await this._modelManager.ensureModel((progress) => {
          this._downloadProgress = progress;
          if (onProgress) onProgress(progress);
        });
      }
      if (!this._stopping) this._lifecycleState = 'idle';
    })();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async initialize(onProgress) {
    await this.ensureDownloaded(onProgress);
    if (this._enabled && !this._sttEndpoint && !this._stopping) await this.demand();
  }

  async demand() {
    if (this._stopping) throw new Error('STT engine shutting down');
    if (this._sttEndpoint) {
      this._lifecycleState = 'ready';
      return;
    }
    await this.ensureDownloaded();
    if (!this._enabled) throw new Error('STT is disabled');
    const host = this._ensureHost();
    try {
      await host.demand();
    } catch (error) {
      if (error && /readiness timed out/.test(error.message)) {
        throw new Error('STT model cold start timed out', { cause: error });
      }
      throw error;
    }
  }

  warm() {
    if (this._sttEndpoint || !this._enabled) return Promise.resolve();
    return this.ensureDownloaded().then(() => this._ensureHost().warm(30000));
  }

  transcribe(float32Samples) {
    if (this._sttEndpoint) return this._transcribeExternal(float32Samples);
    if (this._stopping) return Promise.reject(new Error('STT engine shutting down'));
    if (!this._enabled) return Promise.reject(new Error('STT engine not ready (status: unavailable)'));
    if (this._pendingRequests >= 3) return Promise.reject(new Error('STT busy, try again later'));
    const samples = float32Samples instanceof Float32Array
      ? float32Samples
      : new Float32Array(float32Samples);
    this._pendingRequests++;
    return this.demand()
      .then(() => {
        if (this._stopping) throw new Error('STT engine shutting down');
        return this._ensureHost().request({
          dtype: 'float32',
          payload: samples,
          timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
        });
      })
      .then((message) => message.text || '')
      .finally(() => { this._pendingRequests--; });
  }

  transcribePcm16(input) {
    const pcm16 = this._toInt16Array(input);
    if (this._sttEndpoint) {
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;
      return this._transcribeExternal(float32);
    }
    if (this._stopping) return Promise.reject(new Error('STT engine shutting down'));
    if (!this._enabled) return Promise.reject(new Error('STT engine not ready (status: unavailable)'));
    if (this._pendingRequests >= 3) return Promise.reject(new Error('STT busy, try again later'));
    this._pendingRequests++;
    return this.demand()
      .then(() => {
        if (this._stopping) throw new Error('STT engine shutting down');
        return this._ensureHost().request({
          dtype: 'pcm16',
          payload: pcm16,
          timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
        });
      })
      .then((message) => message.text || '')
      .finally(() => { this._pendingRequests--; });
  }

  unload() {
    if (this._sttEndpoint || !this._host) return Promise.resolve(false);
    return this._host.unload();
  }

  retireForMemoryPressure() {
    if (this._sttEndpoint || !this._host) return Promise.resolve(false);
    return this._host.retireForMemoryPressure();
  }

  isReady() {
    return this.getStatus() === 'ready';
  }

  getStatus() {
    if (this._sttEndpoint) return 'ready';
    return ModelHost.legacyProjection[this.getLifecycleState()];
  }

  getLifecycleState() {
    return this._host ? this._host.getState() : this._lifecycleState;
  }

  getDownloadProgress() {
    return this._downloadProgress;
  }

  getDiagnostics() {
    return this._host
      ? this._host.diagnostics()
      : {
          name: 'stt',
          state: this.getLifecycleState(),
          status: this.getStatus(),
          pid: null,
          external: !!this._sttEndpoint,
        };
  }

  async shutdown() {
    this._stopping = true;
    if (this._host) await this._host.shutdown();
    this._lifecycleState = this._enabled ? 'idle' : 'disabled';
  }

  _ensureHost() {
    if (!this._host) {
      this._host = this._hostFactory({
        name: 'stt',
        enabled: this._enabled,
        entryPath: path.join(__dirname, 'stt-host.js'),
        hostData: {
          modelDir: this._modelManager.getModelPath(),
          numThreads: this._numThreads,
          nodeModulesDir: path.resolve(__dirname, '..', 'node_modules'),
        },
        requestTimeoutMs: TRANSCRIPTION_TIMEOUT_MS,
        readinessTimeoutMs: COLD_START_TIMEOUT_MS,
        idleMs: IDLE_UNLOAD_MS,
      });
      this._host.on('state', (state) => {
        this._lifecycleState = state;
        this.emit('lifecycle', state);
      });
    }
    return this._host;
  }

  _toInt16Array(input) {
    let bytes;
    if (input instanceof Int16Array || ArrayBuffer.isView(input)) {
      bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else if (input instanceof ArrayBuffer) {
      bytes = new Uint8Array(input);
    } else {
      throw new Error('transcribePcm16 expects an Int16Array, ArrayBuffer, or typed-array view');
    }
    const evenLength = bytes.byteLength - (bytes.byteLength % 2);
    const copy = new Uint8Array(evenLength);
    copy.set(bytes.subarray(0, evenLength));
    return new Int16Array(copy.buffer);
  }

  async _transcribeExternal(float32Samples) {
    const wavBuffer = this._float32ToWav(float32Samples, 16000);
    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', 'parakeet');
    const url = this._sttEndpoint.replace(/\/+$/, '') + '/v1/audio/transcriptions';
    const response = await fetch(url, { method: 'POST', body: formData });
    if (!response.ok) throw new Error(`External STT failed: HTTP ${response.status}`);
    const result = await response.json();
    return (result.text || '').trim();
  }

  _float32ToWav(samples, sampleRate) {
    const dataSize = samples.length * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      buffer.writeInt16LE(Math.round(sample < 0 ? sample * 32768 : sample * 32767), 44 + i * 2);
    }
    return buffer;
  }
}

module.exports = SttEngine;
module.exports.COLD_START_TIMEOUT_MS = COLD_START_TIMEOUT_MS;
module.exports.IDLE_UNLOAD_MS = IDLE_UNLOAD_MS;
