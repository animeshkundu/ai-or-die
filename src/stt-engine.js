'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');
const ModelManager = require('./utils/model-manager.js');

const MAX_QUEUE_SIZE = 3;
const TRANSCRIPTION_TIMEOUT_MS = 60000;
const MAX_RESTART_DELAY_MS = 15000;

class SttEngine {
  constructor(options = {}) {
    this._enabled = !!options.enabled;
    this._sttEndpoint = options.sttEndpoint || null;
    this._numThreads = options.numThreads || Math.min(4, os.cpus().length);
    this._status = 'unavailable';
    this._worker = null;
    this._queue = [];
    this._currentRequest = null;
    this._requestIdCounter = 0;
    this._restartAttempts = 0;
    this._modelManager = new ModelManager({
      modelsDir: options.modelsDir
    });
  }

  async initialize() {
    if (!this._enabled && !this._sttEndpoint) {
      this._status = 'unavailable';
      return;
    }

    // External endpoint mode — no model download or worker needed
    if (this._sttEndpoint) {
      this._status = 'ready';
      return;
    }

    // Check if model is already downloaded
    const modelReady = await this._modelManager.isModelReady();

    if (!modelReady) {
      this._status = 'downloading';
      await this._modelManager.ensureModel((progress) => {
        this._downloadProgress = progress;
      });
    }

    this._status = 'loading';
    await this._spawnWorker();
  }

  async transcribe(float32Samples) {
    if (this._sttEndpoint) {
      return this._transcribeExternal(float32Samples);
    }

    if (this._status !== 'ready') {
      throw new Error(`STT engine not ready (status: ${this._status})`);
    }

    if (this._queue.length >= MAX_QUEUE_SIZE) {
      throw new Error('STT busy, try again later');
    }

    const id = ++this._requestIdCounter;

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._removeFromQueue(id);
        reject(new Error('Transcription timed out'));
      }, TRANSCRIPTION_TIMEOUT_MS);

      this._queue.push({ id, samples: float32Samples, resolve, reject, timer });
    });

    this._processQueue();
    return promise;
  }

  _processQueue() {
    if (this._currentRequest || this._queue.length === 0 || !this._worker) {
      return;
    }

    const request = this._queue[0];
    this._currentRequest = request;

    this._worker.postMessage({
      type: 'transcribe',
      id: request.id,
      samples: request.samples
    });
  }

  _onWorkerMessage(msg) {
    if (msg.type === 'ready') {
      this._status = 'ready';
      this._restartAttempts = 0;
      this._processQueue();
      return;
    }

    if (msg.type === 'error') {
      console.error('[stt-engine] Worker model load error:', msg.message);
      this._status = 'unavailable';
      return;
    }

    if (msg.type === 'result') {
      const request = this._currentRequest;
      if (!request || request.id !== msg.id) {
        return;
      }

      clearTimeout(request.timer);
      this._currentRequest = null;
      this._queue.shift();

      if (msg.error) {
        request.reject(new Error(msg.error));
      } else {
        request.resolve(msg.text);
      }

      this._processQueue();
    }
  }

  _onWorkerExit(code) {
    console.error(`[stt-engine] Worker exited with code ${code}`);

    // Reject the current in-flight request
    if (this._currentRequest) {
      clearTimeout(this._currentRequest.timer);
      this._currentRequest.reject(new Error('STT worker crashed'));
      this._currentRequest = null;
      this._queue.shift();
    }

    this._worker = null;
    this._status = 'loading';

    // Restart with exponential backoff
    const delay = Math.min(
      1000 * Math.pow(2, this._restartAttempts),
      MAX_RESTART_DELAY_MS
    );
    this._restartAttempts++;
    this._restartWorker(delay);
  }

  _restartWorker(delay) {
    setTimeout(async () => {
      try {
        await this._spawnWorker();
      } catch (err) {
        console.error('[stt-engine] Failed to restart worker:', err.message);
        this._status = 'unavailable';
      }
    }, delay);
  }

  _spawnWorker() {
    return new Promise((resolve, reject) => {
      const workerPath = path.join(__dirname, 'stt-worker.js');
      const worker = new Worker(workerPath, {
        workerData: {
          modelDir: this._modelManager.getModelPath(),
          numThreads: this._numThreads,
          nodeModulesDir: path.resolve(__dirname, '..', 'node_modules')
        }
      });

      const onReady = (msg) => {
        if (msg.type === 'ready') {
          worker.off('message', onReady);
          worker.off('error', onError);
          this._worker = worker;
          this._status = 'ready';
          this._restartAttempts = 0;

          worker.on('message', (m) => this._onWorkerMessage(m));
          worker.on('exit', (c) => this._onWorkerExit(c));

          resolve();
        } else if (msg.type === 'error') {
          worker.off('message', onReady);
          worker.off('error', onError);
          reject(new Error(msg.message));
        }
      };

      const onError = (err) => {
        worker.off('message', onReady);
        worker.off('error', onError);
        reject(err);
      };

      worker.on('message', onReady);
      worker.on('error', onError);
    });
  }

  async _transcribeExternal(float32Samples) {
    // Convert Float32Array to 16-bit PCM WAV buffer for the external endpoint
    const wavBuffer = this._float32ToWav(float32Samples, 16000);

    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', 'parakeet');

    const url = this._sttEndpoint.replace(/\/+$/, '') + '/v1/audio/transcriptions';
    const response = await fetch(url, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`External STT failed: HTTP ${response.status}`);
    }

    const result = await response.json();
    return (result.text || '').trim();
  }

  _float32ToWav(samples, sampleRate) {
    const numSamples = samples.length;
    const bytesPerSample = 2; // 16-bit PCM
    const dataSize = numSamples * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);

    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);       // chunk size
    buffer.writeUInt16LE(1, 20);        // PCM format
    buffer.writeUInt16LE(1, 22);        // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
    buffer.writeUInt16LE(bytesPerSample, 32);              // block align
    buffer.writeUInt16LE(16, 34);       // bits per sample
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Convert float32 [-1, 1] to int16
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      const val = s < 0 ? s * 32768 : s * 32767;
      buffer.writeInt16LE(Math.round(val), 44 + i * 2);
    }

    return buffer;
  }

  _removeFromQueue(id) {
    const idx = this._queue.findIndex((r) => r.id === id);
    if (idx !== -1) {
      const req = this._queue[idx];
      clearTimeout(req.timer);
      this._queue.splice(idx, 1);
      if (this._currentRequest && this._currentRequest.id === id) {
        this._currentRequest = null;
      }
    }
  }

  isReady() {
    return this._status === 'ready';
  }

  getStatus() {
    return this._status;
  }

  getDownloadProgress() {
    return this._downloadProgress || null;
  }

  async shutdown() {
    // Reject all queued requests
    for (const req of this._queue) {
      clearTimeout(req.timer);
      req.reject(new Error('STT engine shutting down'));
    }
    this._queue = [];
    this._currentRequest = null;

    if (this._worker) {
      await this._worker.terminate();
      this._worker = null;
    }

    this._status = 'unavailable';
  }
}

module.exports = SttEngine;
