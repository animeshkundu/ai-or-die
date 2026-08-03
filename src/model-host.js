'use strict';

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { encodeFrame, writeFrame } = require('./model-host-protocol');
const containment = require('./model-host-containment');

// Bun cannot deliver bytes written to the extra stdio pipe (fd 4) to the child.
// Its IPC channel works, so under Bun the payload rides the control message.
// Node keeps the zero-copy pipe. Parent and child are the same runtime (the
// child is spawned with process.execPath), so the parent's check decides both.
const USE_IPC_PAYLOAD = !!(process.versions && process.versions.bun);

const STATES = Object.freeze([
  'disabled',
  'downloading',
  'idle',
  'loading',
  'ready',
  'unloading',
  'restarting',
  'failed',
]);
const EVENTS = Object.freeze([
  'enable',
  'download',
  'downloaded',
  'demand',
  'ready',
  'request',
  'success',
  'failure',
  'unload',
  'retry',
  'shutdown',
]);
const TRANSITIONS = Object.freeze({
  disabled: Object.freeze({
    enable: 'idle', download: 'disabled', downloaded: 'disabled', demand: 'disabled',
    ready: 'disabled', request: 'disabled', success: 'disabled', failure: 'disabled',
    unload: 'disabled', retry: 'disabled', shutdown: 'disabled',
  }),
  downloading: Object.freeze({
    enable: 'downloading', download: 'downloading', downloaded: 'idle', demand: 'downloading',
    ready: 'downloading', request: 'downloading', success: 'downloading', failure: 'failed',
    unload: 'downloading', retry: 'downloading', shutdown: 'idle',
  }),
  idle: Object.freeze({
    enable: 'idle', download: 'downloading', downloaded: 'idle', demand: 'loading',
    ready: 'ready', request: 'idle', success: 'idle', failure: 'failed',
    unload: 'idle', retry: 'idle', shutdown: 'idle',
  }),
  loading: Object.freeze({
    enable: 'loading', download: 'loading', downloaded: 'loading', demand: 'loading',
    ready: 'ready', request: 'loading', success: 'loading', failure: 'restarting',
    unload: 'loading', retry: 'loading', shutdown: 'idle',
  }),
  ready: Object.freeze({
    enable: 'ready', download: 'ready', downloaded: 'ready', demand: 'ready',
    ready: 'ready', request: 'ready', success: 'ready', failure: 'restarting',
    unload: 'unloading', retry: 'ready', shutdown: 'idle',
  }),
  unloading: Object.freeze({
    enable: 'unloading', download: 'unloading', downloaded: 'unloading', demand: 'unloading',
    ready: 'unloading', request: 'unloading', success: 'unloading', failure: 'unloading',
    unload: 'unloading', retry: 'unloading', shutdown: 'unloading',
  }),
  restarting: Object.freeze({
    enable: 'restarting', download: 'restarting', downloaded: 'restarting', demand: 'restarting',
    ready: 'ready', request: 'restarting', success: 'restarting', failure: 'restarting',
    unload: 'restarting', retry: 'restarting', shutdown: 'idle',
  }),
  failed: Object.freeze({
    enable: 'failed', download: 'failed', downloaded: 'failed', demand: 'failed',
    ready: 'failed', request: 'failed', success: 'failed', failure: 'failed',
    unload: 'failed', retry: 'idle', shutdown: 'idle',
  }),
});
const LEGACY_STATUS = Object.freeze({
  disabled: 'unavailable',
  downloading: 'downloading',
  idle: 'ready',
  loading: 'loading',
  ready: 'ready',
  unloading: 'ready',
  restarting: 'ready',
  failed: 'unavailable',
});
const HOST_ENV_KEYS = Object.freeze([
  'PATH',
  'Path',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'CUDA_VISIBLE_DEVICES',
  'CUDA_PATH',
  'HIP_PATH',
  'VULKAN_SDK',
  'NODE_EXTRA_CA_CERTS',
]);

function hostEnvironment(name, data) {
  const env = {};
  for (const key of HOST_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:CUDA_PATH_V|GGML_|LLAMA_)/.test(key) && value !== undefined) env[key] = value;
  }
  env.AI_OR_DIE_MODEL_HOST = name;
  env.AI_OR_DIE_MODEL_HOST_DATA = Buffer.from(JSON.stringify(data)).toString('base64');
  return env;
}

class ModelHost extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name || 'model';
    this.entryPath = options.entryPath;
    this.hostData = options.hostData || {};
    this.enabled = options.enabled !== false;
    this.readinessTimeoutMs = options.readinessTimeoutMs || 120000;
    this.requestTimeoutMs = options.requestTimeoutMs || 60000;
    this.idleMs = options.idleMs || 0;
    this.maxCrashes = options.maxCrashes || 5;
    this.crashWindowMs = options.crashWindowMs || 60000;
    this.cooloffMs = options.cooloffMs || 30 * 60 * 1000;
    this.manualRetryIntervalMs = options.manualRetryIntervalMs || 60000;
    this._createChild = options.createChild || ((spawnOptions) => spawn(
      process.execPath,
      [
        this.entryPath,
        '--ai-or-die-model-host',
        `--core-pid=${process.pid}`,
        `--host=${this.name}`,
      ],
      spawnOptions
    ));
    this._state = this.enabled ? 'idle' : 'disabled';
    this._generation = null;
    this._generationCounter = 0;
    this._demandPromise = null;
    this._sequence = 0;
    this._queue = Promise.resolve();
    this._crashTimes = [];
    this._consecutiveFailures = 0;
    this._restartTimer = null;
    this._restartPromise = null;
    this._cooloffTimer = null;
    this._idleTimer = null;
    this._activeHold = false;
    this._warmUntil = 0;
    this._warmCeiling = 0;
    this._warmTimer = null;
    this._stopping = false;
    this._permanentFailure = null;
    this._lastFailure = null;
    this._lastManualRetryAt = 0;
    this._runtimeInfo = null;
  }

  static get states() { return STATES; }
  static get events() { return EVENTS; }
  static get transitions() { return TRANSITIONS; }
  static get legacyProjection() { return LEGACY_STATUS; }
  static nextState(state, event) {
    if (!TRANSITIONS[state] || !Object.prototype.hasOwnProperty.call(TRANSITIONS[state], event)) {
      throw new Error(`Invalid model-host transition: ${state} x ${event}`);
    }
    return TRANSITIONS[state][event];
  }
  static restartDelayFor(attempt) {
    return Math.min(1000 * (2 ** Math.max(0, attempt)), 15000);
  }

  getState() { return this._state; }
  getStatus() { return LEGACY_STATUS[this._state]; }
  isReady() { return this.getStatus() === 'ready'; }
  getRuntimeInfo() { return this._runtimeInfo; }

  setState(state) {
    if (!STATES.includes(state)) throw new Error(`Invalid model-host state: ${state}`);
    if (state === this._state) return;
    this._state = state;
    this.emit('state', state);
  }

  async demand() {
    if (this._stopping) throw new Error(`${this.name} model host is shutting down`);
    if (!this.enabled) throw new Error(`${this.name} model host is disabled`);
    if (this._permanentFailure) throw this._permanentFailure;
    if (this._state === 'failed') {
      throw this._lastFailure || new Error(`${this.name} model host exhausted its crash budget`);
    }
    if (this._state === 'ready') {
      this._armIdle();
      return;
    }
    if (this._demandPromise) return this._demandPromise;
    if (this._restartPromise) return this._restartPromise;
    if (this._generation && !this._generation.runtime.exitObserved) {
      if (this._state === 'unloading' || this._generation.runtime.retirementStarted) {
        return this._generation.exitPromise.then(() => this.demand());
      }
      return this._generation.readyPromise;
    }
    this._demandPromise = this._spawnGeneration();
    try {
      await this._demandPromise;
    } finally {
      this._demandPromise = null;
    }
  }

  request({ dtype, payload, metadata = {}, timeoutMs }) {
    const run = async () => {
      await this.demand();
      const generation = this._generation;
      if (!this._isCurrent(generation) || this._state !== 'ready') {
        throw new Error(`${this.name} model host is not ready`);
      }
      this._disarmIdle();
      const seq = ++this._sequence;
      const body = Buffer.isBuffer(payload) ? payload : Buffer.from(
        payload.buffer || payload,
        payload.byteOffset || 0,
        payload.byteLength || undefined
      );
      const frame = encodeFrame({ nonce: generation.nonce, seq, dtype, payload: body });
      const request = {};
      request.promise = new Promise((resolve, reject) => {
        request.resolve = resolve;
        request.reject = reject;
        request.timer = setTimeout(() => {
          generation.runtime.requests.delete(seq);
          generation.runtime.tombstones.set(seq, Date.now() + 30000);
          reject(new Error(`${this.name} request timed out`));
          this._finalize(generation, 'request-timeout', new Error('request timeout'));
        }, timeoutMs || this.requestTimeoutMs);
        if (request.timer.unref) request.timer.unref();
      });
      generation.runtime.requests.set(seq, request);
      try {
        // Bun does not deliver data written to the extra stdio pipe (fd 4) to
        // the child, while its IPC channel works fine — verified with a minimal
        // probe on bun 1.4.0-canary: identical parent/child code delivers under
        // Node and times out under Bun. Carry the payload inside the control
        // message there instead. Base64 costs ~33% over the wire and one copy,
        // acceptable because the payload is hard-capped (MAX_PAYLOAD_BYTES) and
        // exactly one request is in flight at a time. Node keeps the zero-copy
        // pipe path.
        const viaIpc = USE_IPC_PAYLOAD;
        generation.child.send({
          ...metadata,
          type: 'request',
          nonce: generation.nonce,
          seq,
          dtype,
          length: body.length,
          ...(viaIpc ? { payloadBase64: body.toString('base64') } : {}),
        }, (error) => {
          if (error) this._finalize(generation, 'control-error', error);
        });
        if (!viaIpc) await writeFrame(generation.payload, frame);
      } catch (error) {
        generation.runtime.requests.delete(seq);
        clearTimeout(request.timer);
        request.reject(error);
        this._finalize(generation, 'pipe-error', error);
      }
      try {
        return await request.promise;
      } finally {
        this._armIdle();
      }
    };
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }

  setActive(active) {
    this._activeHold = !!active;
    if (this._activeHold) this._disarmIdle();
    else this._armIdle();
  }

  warm(holdMs = 30000) {
    this.setActive(true);
    const bounded = Math.max(1000, Math.min(holdMs, 120000));
    const now = Date.now();
    if (!this._warmCeiling || now >= this._warmCeiling) {
      this._warmCeiling = now + 120000;
    }
    this._warmUntil = Math.min(
      this._warmCeiling,
      Math.max(this._warmUntil, now + bounded)
    );
    if (this._warmTimer) clearTimeout(this._warmTimer);
    const delay = Math.max(0, this._warmUntil - now);
    this._warmTimer = setTimeout(() => {
      this._warmTimer = null;
      const remaining = this._warmUntil - Date.now();
      if (remaining > 0) {
        this._warmTimer = setTimeout(() => {
          this._warmTimer = null;
          this._warmUntil = 0;
          this._warmCeiling = 0;
          this.setActive(false);
        }, remaining);
        if (this._warmTimer.unref) this._warmTimer.unref();
        return;
      }
      this._warmUntil = 0;
      this._warmCeiling = 0;
      this.setActive(false);
    }, delay);
    if (this._warmTimer.unref) this._warmTimer.unref();
    return this.demand();
  }

  retry() {
    if (this._permanentFailure) return Promise.reject(this._permanentFailure);
    if (this._state !== 'failed') return this.demand();
    const now = Date.now();
    if (this._lastManualRetryAt && now - this._lastManualRetryAt < this.manualRetryIntervalMs) {
      return Promise.reject(new Error(`${this.name} model-host retry is rate limited`));
    }
    this._lastManualRetryAt = now;
    this._clearCooloff();
    this._crashTimes = [];
    this._consecutiveFailures = 0;
    this.setState('idle');
    return this.demand();
  }

  unload() {
    if (this._state !== 'ready') return Promise.resolve(false);
    const generation = this._generation;
    if (!generation) return Promise.resolve(false);
    generation.runtime.intentional = 'unload';
    this.setState('unloading');
    this._disarmIdle();
    this._sendShutdown(generation);
    return generation.exitPromise.then(() => true);
  }

  retireForMemoryPressure() {
    const generation = this._generation;
    if (this._state !== 'ready' || !generation || this._activeHold ||
        generation.runtime.requests.size > 0) {
      return Promise.resolve(false);
    }
    return this.unload();
  }

  async shutdown() {
    this._stopping = true;
    this._disarmIdle();
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._restartPromise = null;
    this._clearCooloff();
    if (this._warmTimer) {
      clearTimeout(this._warmTimer);
      this._warmTimer = null;
      this._warmUntil = 0;
      this._warmCeiling = 0;
    }
    const generation = this._generation;
    if (generation && !generation.runtime.exitObserved) {
      generation.runtime.intentional = 'shutdown';
      this._sendShutdown(generation);
      await Promise.race([
        generation.exitPromise,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (!generation.runtime.exitObserved) {
        try { generation.child.kill('SIGKILL'); } catch (_) {}
        await generation.exitPromise.catch(() => {});
      }
    }
    this.setState(this.enabled ? 'idle' : 'disabled');
  }

  diagnostics() {
    const generation = this._generation;
    return {
      name: this.name,
      state: this._state,
      status: this.getStatus(),
      pid: generation && !generation.runtime.exitObserved ? generation.child.pid : null,
      generation: generation ? generation.id : null,
      crashCount: this._crashTimes.length,
      consecutiveFailures: this._consecutiveFailures,
      permanentFailure: this._permanentFailure ? this._permanentFailure.message : null,
    };
  }

  _spawnGeneration() {
    if (this._state !== 'restarting') this.setState('loading');
    const nonce = crypto.randomBytes(4).readUInt32BE(0) || 1;
    const child = this._createChild({
      stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe', 'pipe'],
      env: hostEnvironment(this.name, this.hostData),
      windowsHide: true,
    });
    const runtime = {
      events: new Set(),
      requests: new Map(),
      tombstones: new Map(),
      intentional: null,
      retirementStarted: false,
      exitObserved: false,
      permanent: false,
      readinessTimer: null,
      killTimer: null,
      resolveReady: null,
      rejectReady: null,
      resolveExit: null,
    };
    const readyPromise = new Promise((resolve, reject) => {
      runtime.resolveReady = resolve;
      runtime.rejectReady = reject;
    });
    const exitPromise = new Promise((resolve) => { runtime.resolveExit = resolve; });
    const generation = Object.freeze({
      id: ++this._generationCounter,
      nonce,
      child,
      payload: child.stdio && child.stdio[4],
      liveness: child.stdio && child.stdio[5],
      runtime,
      readyPromise,
      exitPromise,
    });
    this._generation = generation;
    this._sequence = 0;

    child.on('message', (message) => this._onMessage(generation, message));
    child.on('error', (error) => this._finalize(generation, 'error', error));
    child.once('disconnect', () => this._finalize(generation, 'disconnect'));
    child.once('exit', (code, signal) => this._finalize(generation, 'exit', { code, signal }));
    child.once('close', (code, signal) => this._finalize(generation, 'close', { code, signal }));
    if (generation.payload) {
      generation.payload.on('error', (error) => this._finalize(generation, 'pipe-error', error));
      generation.payload.once('close', () => this._finalize(generation, 'pipe-eof'));
    }
    if (generation.liveness) {
      generation.liveness.on('error', (error) => this._finalize(generation, 'liveness-error', error));
      generation.liveness.once('close', () => this._finalize(generation, 'liveness-eof'));
    }

    const attached = containment.attachHost(child);
    runtime.job = attached.job;
    if (!attached.ok) {
      this._finalize(generation, 'containment-error', attached.error);
      return readyPromise;
    }
    if (!generation.payload || !generation.liveness || typeof child.send !== 'function') {
      const error = new Error('Model host requires IPC, payload, and liveness pipes');
      runtime.permanent = true;
      this._permanentFailure = error;
      this._finalize(generation, 'protocol-error', error);
      return readyPromise;
    }

    runtime.readinessTimer = setTimeout(() => {
      this._finalize(generation, 'readiness-timeout', new Error(`${this.name} readiness timed out`));
    }, this.readinessTimeoutMs);
    if (runtime.readinessTimer.unref) runtime.readinessTimer.unref();
    try {
      generation.liveness.write(Buffer.from([1]), (error) => {
        if (error) this._finalize(generation, 'liveness-error', error);
      });
    } catch (error) {
      this._finalize(generation, 'liveness-error', error);
    }
    return readyPromise;
  }

  _onMessage(generation, message) {
    if (!this._isCurrent(generation) || !message) return;
    const runtime = generation.runtime;
    if (runtime.exitObserved) return;
    if (runtime.retirementStarted) {
      if (message.type === 'result') {
        const tombstoneExpiry = runtime.tombstones.get(message.seq);
        if (tombstoneExpiry && tombstoneExpiry >= Date.now()) {
          runtime.tombstones.delete(message.seq);
        }
      }
      return;
    }
    if (message.type === 'liveness_armed') {
      try {
        generation.child.send({ type: 'load' }, (error) => {
          if (error) this._finalize(generation, 'control-error', error);
        });
      } catch (error) {
        this._finalize(generation, 'error', error);
      }
      return;
    }
    if (message.type === 'ready') {
      clearTimeout(runtime.readinessTimer);
      runtime.readinessTimer = null;
      this._consecutiveFailures = 0;
      this._runtimeInfo = { ...message };
      delete this._runtimeInfo.type;
      this.setState('ready');
      runtime.resolveReady();
      this._armIdle();
      return;
    }
    if (message.type === 'error') {
      const error = new Error(message.message || `${this.name} host failed`);
      error.code = message.code;
      if (message.code === 'MODULE_NOT_FOUND') {
        runtime.permanent = true;
        this._permanentFailure = error;
      }
      this._finalize(generation, 'host-error', error);
      return;
    }
    if (message.type === 'protocol_error') {
      this._finalize(generation, 'protocol-error', new Error(message.message));
      return;
    }
    if (message.type === 'result') {
      if (message.nonce !== generation.nonce) {
        this._finalize(generation, 'protocol-error', new Error('Result generation nonce mismatch'));
        return;
      }
      const request = runtime.requests.get(message.seq);
      if (!request) {
        const tombstoneExpiry = runtime.tombstones.get(message.seq);
        if (tombstoneExpiry && tombstoneExpiry >= Date.now()) {
          runtime.tombstones.delete(message.seq);
          return;
        }
        this._finalize(generation, 'protocol-error', new Error('Unknown model-host result id'));
        return;
      }
      runtime.requests.delete(message.seq);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message);
    }
  }

  _finalize(generation, event, detail) {
    if (!generation || generation.runtime.events.has(event)) return;
    const runtime = generation.runtime;
    runtime.events.add(event);
    if (event === 'exit' || event === 'close') {
      if (runtime.exitObserved) return;
      runtime.exitObserved = true;
      clearTimeout(runtime.readinessTimer);
      clearTimeout(runtime.killTimer);
      containment.closeHostJob(runtime.job);
      for (const request of runtime.requests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`${this.name} model host exited`));
      }
      runtime.requests.clear();
      runtime.tombstones.clear();
      if (this._isCurrent(generation)) {
        this._generation = null;
        this._runtimeInfo = null;
      }
      runtime.resolveExit(detail);
      if (runtime.intentional || this._stopping) {
        runtime.rejectReady(new Error(`${this.name} model host is shutting down`));
        if (this._isCurrent(generation) || !this._generation) {
          this.setState(this.enabled ? 'idle' : 'disabled');
        }
        return;
      }
      this._recordCrash();
      const error = runtime.failure || new Error(`${this.name} model host exited`);
      this._lastFailure = error;
      runtime.rejectReady(error);
      if (runtime.permanent || this._permanentFailure || this._crashTimes.length >= this.maxCrashes) {
        this.setState('failed');
        if (!runtime.permanent && !this._permanentFailure) this._scheduleCooloff(generation.id);
        return;
      }
      this.setState('restarting');
      const delay = ModelHost.restartDelayFor(this._consecutiveFailures - 1);
      this._restartPromise = new Promise((resolve, reject) => {
        this._restartTimer = setTimeout(() => {
          this._restartTimer = null;
          if (this._stopping || this._generation || this._state !== 'restarting') {
            this._restartPromise = null;
            reject(new Error(`${this.name} model-host restart was cancelled`));
            return;
          }
          this._spawnGeneration().then(resolve, reject).finally(() => {
            this._restartPromise = null;
          });
        }, delay);
      });
      this._restartPromise.catch(() => {});
      if (this._restartTimer.unref) this._restartTimer.unref();
      return;
    }

    if (runtime.retirementStarted || runtime.exitObserved || !this._isCurrent(generation)) return;
    runtime.retirementStarted = true;
    if (runtime.intentional) {
      runtime.rejectReady(new Error(`${this.name} model host is shutting down`));
      for (const request of runtime.requests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`${this.name} model host is shutting down`));
      }
      runtime.requests.clear();
      if (!runtime.killTimer) this._scheduleKill(generation, 5000);
      return;
    }
    runtime.failure = detail instanceof Error ? detail : new Error(`${this.name} model host ${event}`);
    this._lastFailure = runtime.failure;
    runtime.rejectReady(runtime.failure);
    for (const request of runtime.requests.values()) {
      clearTimeout(request.timer);
      request.reject(runtime.failure);
    }
    runtime.requests.clear();
    if (!runtime.intentional) this.setState(runtime.permanent ? 'failed' : 'restarting');
    try { generation.child.kill('SIGTERM'); } catch (_) {}
    this._scheduleKill(generation, 2000);
  }

  _sendShutdown(generation) {
    try { generation.child.send({ type: 'shutdown' }); } catch (_) {
      this._finalize(generation, 'disconnect');
      return;
    }
    if (!generation.runtime.killTimer) this._scheduleKill(generation, 5000);
  }

  _scheduleKill(generation, delayMs) {
    generation.runtime.killTimer = setTimeout(() => {
      if (!generation.runtime.exitObserved) {
        try { generation.child.kill('SIGKILL'); } catch (_) {}
      }
    }, delayMs);
    if (generation.runtime.killTimer.unref) generation.runtime.killTimer.unref();
  }

  _recordCrash() {
    const now = Date.now();
    this._crashTimes = this._crashTimes.filter((at) => now - at < this.crashWindowMs);
    this._crashTimes.push(now);
    this._consecutiveFailures++;
  }

  _scheduleCooloff(generationId) {
    this._clearCooloff();
    this._cooloffTimer = setTimeout(() => {
      this._cooloffTimer = null;
      if (this._stopping || this._permanentFailure || this._generation ||
          this._state !== 'failed' || this._generationCounter !== generationId) return;
      this._crashTimes = [];
      this._consecutiveFailures = 0;
      this.setState('idle');
    }, this.cooloffMs);
    if (this._cooloffTimer.unref) this._cooloffTimer.unref();
  }

  _clearCooloff() {
    if (this._cooloffTimer) {
      clearTimeout(this._cooloffTimer);
      this._cooloffTimer = null;
    }
  }

  _isCurrent(generation) {
    return this._generation === generation;
  }

  _armIdle() {
    this._disarmIdle();
    if (!this.idleMs || this._activeHold || this._state !== 'ready') return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (!this._activeHold && this._state === 'ready') this.unload();
    }, this.idleMs);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  _disarmIdle() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }
}

module.exports = ModelHost;
