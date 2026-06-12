'use strict';

// Local-LLM engine for sticky-note summaries. Mirrors src/stt-engine.js:
// lazy model download + worker-thread inference, a serialised request queue,
// graceful degradation when node-llama-cpp (or the model) is missing.
//
// The worker factory is injectable so the state machine + queue can be
// unit-tested without node-llama-cpp installed.

const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');
const GgufModelManager = require('./utils/gguf-model-manager');

const MAX_QUEUE_SIZE = 3;
const DEFAULT_INFER_TIMEOUT_MS = 60000;
const MAX_RESTART_DELAY_MS = 15000;
const MAX_RESTART_ATTEMPTS = 5;

class StickyNoteEngine {
  constructor(options = {}) {
    this._enabled = !!options.enabled;
    this._numThreads = options.numThreads || Math.max(1, Math.min(4, os.cpus().length - 2));
    this._contextSize = options.contextSize || 8192;
    this._inferTimeoutMs = options.inferTimeoutMs || DEFAULT_INFER_TIMEOUT_MS;
    this._maxQueue = options.maxQueue || MAX_QUEUE_SIZE;

    this._status = 'unavailable';
    this._worker = null;
    this._queue = [];
    this._currentRequest = null;
    this._requestIdCounter = 0;
    this._restartAttempts = 0;
    this._lastSpawnError = null;
    this._stopping = false;
    this._initPromise = null;
    this._downloadProgress = null;

    this._modelManager =
      options.modelManager ||
      new GgufModelManager({ model: options.model, modelsDir: options.modelsDir });

    // Injectable for tests; default spawns the real worker thread.
    this._createWorker =
      options.createWorker ||
      (() =>
        new Worker(path.join(__dirname, 'sticky-note-worker.js'), {
          workerData: {
            modelPath: this._modelManager.getModelFile(),
            numThreads: this._numThreads,
            contextSize: this._contextSize,
          },
        }));
  }

  async initialize(onProgress) {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInitialize(onProgress);
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _doInitialize(onProgress) {
    if (!this._enabled) {
      this._status = 'unavailable';
      return;
    }
    if (!(await this._modelManager.isModelReady())) {
      this._status = 'downloading';
      await this._modelManager.ensureModel((progress) => {
        this._downloadProgress = progress;
        if (onProgress) onProgress(progress);
      });
    }
    this._status = 'loading';
    await this._spawnWorker();
  }

  isReady() {
    return this._status === 'ready';
  }

  getStatus() {
    return this._status;
  }

  getDownloadProgress() {
    return this._downloadProgress;
  }

  /**
   * Run one inference. Resolves with the model's raw output string.
   * @param {string} prompt
   * @returns {Promise<string>}
   */
  infer(prompt) {
    if (this._status !== 'ready') {
      return Promise.reject(new Error(`sticky-note engine not ready (status: ${this._status})`));
    }
    if (this._queue.length >= this._maxQueue) {
      return Promise.reject(new Error('sticky-note engine busy'));
    }
    const id = ++this._requestIdCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._removeFromQueue(id, new Error('inference timed out'));
      }, this._inferTimeoutMs);
      this._queue.push({ id, prompt, resolve, reject, timer });
      this._processQueue();
    });
  }

  _processQueue() {
    if (this._currentRequest || this._queue.length === 0 || !this._worker) return;
    const request = this._queue[0];
    this._currentRequest = request;
    this._worker.postMessage({ type: 'infer', id: request.id, prompt: request.prompt });
  }

  _onWorkerMessage(msg) {
    if (!msg) return;
    if (msg.type === 'ready') {
      this._status = 'ready';
      this._restartAttempts = 0;
      this._processQueue();
      return;
    }
    if (msg.type === 'error') {
      if (msg.code === 'MODULE_NOT_FOUND' || (msg.message && msg.message.includes('node-llama-cpp'))) {
        this._lastSpawnError = 'MODULE_NOT_FOUND';
      }
      this._status = 'unavailable';
      return;
    }
    if (msg.type === 'result') {
      const request = this._currentRequest;
      if (!request || request.id !== msg.id) return;
      clearTimeout(request.timer);
      this._currentRequest = null;
      this._queue.shift();
      if (msg.error) request.reject(new Error(msg.error));
      else request.resolve(msg.text);
      this._processQueue();
    }
  }

  _onWorkerExit(code) {
    for (const req of this._queue) {
      clearTimeout(req.timer);
      req.reject(new Error('sticky-note worker crashed'));
    }
    this._queue = [];
    this._currentRequest = null;
    this._worker = null;

    if (this._stopping) {
      this._status = 'unavailable';
      return;
    }
    if (this._lastSpawnError === 'MODULE_NOT_FOUND') {
      this._status = 'unavailable';
      return;
    }
    if (this._restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this._status = 'unavailable';
      return;
    }
    this._status = 'loading';
    const delay = Math.min(1000 * Math.pow(2, this._restartAttempts), MAX_RESTART_DELAY_MS);
    this._restartAttempts++;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._stopping) {
        this._status = 'unavailable';
        return;
      }
      this._spawnWorker().catch(() => {
        this._status = 'unavailable';
      });
    }, delay);
  }

  _spawnWorker() {
    return new Promise((resolve, reject) => {
      const worker = this._createWorker();

      const onReady = (msg) => {
        if (!msg) return;
        if (msg.type === 'ready') {
          worker.off('message', onReady);
          worker.off('error', onError);
          worker.off('exit', onBootExit);
          this._worker = worker;
          this._status = 'ready';
          this._restartAttempts = 0;
          this._lastSpawnError = null;
          worker.on('message', (m) => this._onWorkerMessage(m));
          worker.on('exit', (c) => this._onWorkerExit(c));
          this._processQueue();
          resolve();
        } else if (msg.type === 'error') {
          worker.off('message', onReady);
          worker.off('error', onError);
          worker.off('exit', onBootExit);
          if (msg.code === 'MODULE_NOT_FOUND') this._lastSpawnError = 'MODULE_NOT_FOUND';
          this._status = 'unavailable';
          reject(new Error(msg.message || 'worker error'));
        }
      };
      const onError = (err) => {
        worker.off('message', onReady);
        worker.off('error', onError);
        worker.off('exit', onBootExit);
        if (err && (err.code === 'MODULE_NOT_FOUND' || (err.message && err.message.includes('node-llama-cpp')))) {
          this._lastSpawnError = 'MODULE_NOT_FOUND';
        }
        this._status = 'unavailable';
        reject(err);
      };
      // If the worker dies before emitting ready/error, neither listener above
      // fires — without this the init Promise would hang forever.
      const onBootExit = (code) => {
        worker.off('message', onReady);
        worker.off('error', onError);
        worker.off('exit', onBootExit);
        this._status = 'unavailable';
        reject(new Error(`sticky-note worker exited during init (code ${code})`));
      };

      worker.on('message', onReady);
      worker.on('error', onError);
      worker.on('exit', onBootExit);
    });
  }

  _removeFromQueue(id, err) {
    const idx = this._queue.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const req = this._queue[idx];
    clearTimeout(req.timer);
    this._queue.splice(idx, 1);
    req.reject(err || new Error('cancelled'));
    if (this._currentRequest && this._currentRequest.id === id) {
      this._currentRequest = null;
      this._processQueue();
    }
  }

  async shutdown() {
    this._stopping = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    for (const req of this._queue) {
      clearTimeout(req.timer);
      req.reject(new Error('sticky-note engine shutting down'));
    }
    this._queue = [];
    this._currentRequest = null;
    if (this._worker) {
      const w = this._worker;
      this._worker = null;
      try {
        // Ask the worker to dispose the native model/context cleanly, then
        // terminate only if it didn't exit on its own. A bare terminate() with
        // the model loaded can abort the process during native cleanup.
        let exited = false;
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              resolve();
            }
          };
          w.once('exit', () => {
            exited = true;
            finish();
          });
          try {
            w.postMessage({ type: 'shutdown' });
          } catch {
            finish();
          }
          const t = setTimeout(finish, 3000);
          if (t.unref) t.unref();
        });
        if (!exited) await w.terminate();
      } catch {
        /* ignore */
      }
    }
    this._status = 'unavailable';
  }
}

module.exports = StickyNoteEngine;
