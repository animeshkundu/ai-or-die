'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const GgufModelManager = require('./utils/gguf-model-manager');
const ModelHost = require('./model-host');
const { isBun } = require('./utils/runtime');

const DEFAULT_INFER_TIMEOUT_MS = 300000;
const IDLE_UNLOAD_MS = 90000;

class StickyNoteEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this._enabled = !!options.enabled;
    this._numThreadsExplicit = Number.isFinite(Number(options.numThreads)) && Number(options.numThreads) > 0;
    this._numThreads = this._numThreadsExplicit ? Math.floor(Number(options.numThreads)) : null;
    this._contextSize = options.contextSize || 8192;
    this._inferTimeoutMs = options.inferTimeoutMs || DEFAULT_INFER_TIMEOUT_MS;
    this._maxQueue = options.maxQueue || 3;
    this._pendingRequests = 0;
    this._downloadProgress = null;
    this._runtimeInfo = null;
    this._initPromise = null;
    this._stopping = false;
    this._lastSpawnError = null;
    this._modelManager = options.modelManager || new GgufModelManager({
      model: options.model,
      modelsDir: options.modelsDir,
    });
    this._hostFactory = options.hostFactory || ((hostOptions) => new ModelHost(hostOptions));
    this._host = null;
    this._lifecycleState = this._enabled ? 'idle' : 'disabled';
  }

  _workerData() {
    return {
      modelPath: this._modelManager.getModelFile(),
      ...(this._numThreadsExplicit ? { numThreads: this._numThreads } : {}),
      contextSize: this._contextSize,
    };
  }

  async ensureDownloaded(onProgress) {
    if (!this._enabled || isBun()) {
      this._lifecycleState = 'disabled';
      if (isBun()) this._lastSpawnError = 'BUN_UNSUPPORTED';
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
    if (this._enabled && !isBun() && !this._stopping) await this.demand();
  }

  async demand() {
    if (this._stopping) throw new Error('sticky-note engine shutting down');
    await this.ensureDownloaded();
    if (!this._enabled || isBun()) throw new Error('sticky-note engine unavailable');
    await this._ensureHost().demand();
    this._runtimeInfo = this._host.getRuntimeInfo();
  }

  infer(prompt) {
    if (this._stopping) {
      return Promise.reject(new Error('sticky-note engine shutting down'));
    }
    if (!this._enabled || isBun()) {
      return Promise.reject(new Error(`sticky-note engine not ready (status: ${this.getStatus()})`));
    }
    if (this._pendingRequests >= this._maxQueue) {
      return Promise.reject(new Error('sticky-note engine busy'));
    }
    this._pendingRequests++;
    return this.ensureDownloaded()
      .then(() => {
        if (this._stopping) throw new Error('sticky-note engine shutting down');
        return this._ensureHost().request({
          dtype: 'utf8',
          payload: Buffer.from(String(prompt), 'utf8'),
          timeoutMs: this._inferTimeoutMs,
        });
      })
      .then((message) => message.text || '')
      .finally(() => { this._pendingRequests--; });
  }

  setActive(active) {
    if (active) {
      return this.demand().then(() => this._host.setActive(true));
    }
    if (this._host) this._host.setActive(false);
    return Promise.resolve();
  }

  unload() {
    return this._host ? this._host.unload() : Promise.resolve(false);
  }

  retireForMemoryPressure() {
    return this._host ? this._host.retireForMemoryPressure() : Promise.resolve(false);
  }

  isReady() {
    return this.getStatus() === 'ready';
  }

  getStatus() {
    return ModelHost.legacyProjection[this.getLifecycleState()];
  }

  getLifecycleState() {
    return this._host ? this._host.getState() : this._lifecycleState;
  }

  getDownloadProgress() {
    return this._downloadProgress;
  }

  getRuntimeInfo() {
    return this._host ? this._host.getRuntimeInfo() : this._runtimeInfo;
  }

  getDiagnostics() {
    return this._host
      ? this._host.diagnostics()
      : { name: 'sticky-note', state: this.getLifecycleState(), status: this.getStatus(), pid: null };
  }

  async shutdown() {
    this._stopping = true;
    if (this._host) await this._host.shutdown();
    this._runtimeInfo = null;
    this._lifecycleState = this._enabled ? 'idle' : 'disabled';
  }

  _ensureHost() {
    if (!this._host) {
      this._host = this._hostFactory({
        name: 'sticky-note',
        enabled: this._enabled,
        entryPath: path.join(__dirname, 'sticky-note-host.js'),
        hostData: this._workerData(),
        requestTimeoutMs: this._inferTimeoutMs,
        readinessTimeoutMs: 180000,
        idleMs: IDLE_UNLOAD_MS,
      });
      this._host.on('state', (state) => {
        this._lifecycleState = state;
        if (state !== 'ready') this._runtimeInfo = null;
        this.emit('lifecycle', state);
      });
    }
    return this._host;
  }
}

module.exports = StickyNoteEngine;
module.exports.DEFAULT_INFER_TIMEOUT_MS = DEFAULT_INFER_TIMEOUT_MS;
module.exports.IDLE_UNLOAD_MS = IDLE_UNLOAD_MS;
