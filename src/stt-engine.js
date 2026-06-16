'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');
const ModelManager = require('./utils/model-manager.js');

const MAX_QUEUE_SIZE = 3;
const TRANSCRIPTION_TIMEOUT_MS = 60000;
const MAX_RESTART_DELAY_MS = 15000;
const MAX_RESTART_ATTEMPTS = 5;

class SttEngine {
  constructor(options = {}) {
    this._enabled = !!options.enabled;
    this._sttEndpoint = options.sttEndpoint || null;
    this._numThreads = options.numThreads || Math.min(4, os.cpus().length);
    this._status = 'unavailable';
    this._worker = null;
    this._spawningWorker = null;
    this._queue = [];
    this._currentRequest = null;
    this._requestIdCounter = 0;
    this._restartAttempts = 0;
    this._lastSpawnError = null;
    this._stopping = false;
    this._initPromise = null;
    this._modelManager = new ModelManager({
      modelsDir: options.modelsDir
    });
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
        if (onProgress) onProgress(progress);
      });
    }

    this._status = 'loading';
    // If shutdown began while we were checking/downloading the model, do NOT
    // spawn a worker we'd immediately have to kill mid-native-load (which aborts
    // the process). shutdown() awaits this in-flight init, so bailing here lets
    // it complete cleanly with no worker.
    if (this._stopping) return;
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

  /**
   * Transcribe raw 16-bit PCM. The int16->float32 conversion is deferred to the
   * worker thread (see stt-worker.js) so the server event loop never runs the
   * per-sample loop. Accepts an Int16Array, an ArrayBuffer, or any ArrayBuffer
   * view (e.g. a Node Buffer) of raw little-endian 16-bit samples.
   *
   * @param {Int16Array|ArrayBuffer|ArrayBufferView} int16
   * @returns {Promise<string>}
   */
  transcribePcm16(int16) {
    const int16arr = this._toInt16Array(int16);

    if (this._sttEndpoint) {
      // External endpoint has no worker — convert here and reuse the float32 path.
      const float32 = new Float32Array(int16arr.length);
      for (let i = 0; i < int16arr.length; i++) {
        float32[i] = int16arr[i] / 32768.0;
      }
      return this._transcribeExternal(float32);
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

      this._queue.push({ id, pcm16: int16arr, resolve, reject, timer });
    });

    this._processQueue();
    return promise;
  }

  // Copy an int16 input into a fresh, offset-0, even-length Int16Array. Always
  // copies (even an Int16Array input) so the queued buffer is solely owned and
  // can be safely TRANSFERRED to the worker. A Node Buffer slice can have an odd
  // byteOffset (a direct `new Int16Array(buf.buffer, off)` would throw); an odd
  // byteLength is floored to whole 16-bit samples — callers already reject odd
  // lengths, this is defense-in-depth so the method never throws RangeError.
  _toInt16Array(int16) {
    let bytes;
    if (int16 instanceof Int16Array || ArrayBuffer.isView(int16)) {
      bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    } else if (int16 instanceof ArrayBuffer) {
      bytes = new Uint8Array(int16);
    } else {
      throw new Error('transcribePcm16 expects an Int16Array, ArrayBuffer, or typed-array view');
    }
    const evenLen = bytes.byteLength - (bytes.byteLength % 2);
    const copy = new Uint8Array(evenLen);
    copy.set(bytes.subarray(0, evenLen));
    return new Int16Array(copy.buffer);
  }

  _processQueue() {
    if (this._currentRequest || this._queue.length === 0 || !this._worker) {
      return;
    }

    const request = this._queue[0];
    this._currentRequest = request;

    // pcm16 path: TRANSFER the (solely-owned, freshly-copied by _toInt16Array)
    // buffer to the worker — avoids a multi-MB structured-clone copy on the event
    // loop. Safe because each request is posted exactly once (on worker crash the
    // queue is rejected + cleared, so a posted/detached buffer is never requeued).
    if (request.pcm16 !== undefined) {
      this._worker.postMessage({
        type: 'transcribe',
        id: request.id,
        pcm16: request.pcm16
      }, [request.pcm16.buffer]);
    } else {
      this._worker.postMessage({
        type: 'transcribe',
        id: request.id,
        samples: request.samples
      });
    }
  }

  _onWorkerMessage(msg) {
    if (msg.type === 'ready') {
      this._status = 'ready';
      this._restartAttempts = 0;
      this._processQueue();
      return;
    }

    if (msg.type === 'error') {
      console.error('[stt-engine] Worker error:', msg.message);
      if (msg.message && msg.message.includes('sherpa-onnx-node')) {
        this._lastSpawnError = 'MODULE_NOT_FOUND';
      }
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

    // Reject all queued requests (includes the current in-flight request)
    for (const req of this._queue) {
      clearTimeout(req.timer);
      req.reject(new Error('STT worker crashed'));
    }
    this._queue = [];
    this._currentRequest = null;

    this._worker = null;

    // PROC-02 gap 1: if shutdown() ran, do NOT schedule a respawn.
    // Without this guard, `await engine.shutdown()` would call
    // `worker.terminate()`, which fires _onWorkerExit synchronously and
    // re-schedules a worker via _restartWorker → setTimeout. The respawn
    // races the process exit and either keeps the engine "loading" forever
    // (in a long-lived parent) or leaks a half-loaded Worker into the next
    // process restart. The flag is set by shutdown() before terminate().
    // See docs/audits/proc-child-processes.md gap 1.
    if (this._stopping) {
      this._status = 'unavailable';
      return;
    }

    // Don't retry if the dependency is fundamentally missing
    if (this._lastSpawnError === 'MODULE_NOT_FOUND') {
      console.error('[stt-engine] sherpa-onnx-node not installed — STT unavailable. Install with: npm install sherpa-onnx-node');
      this._status = 'unavailable';
      return;
    }

    // Give up after too many consecutive failures
    if (this._restartAttempts >= MAX_RESTART_ATTEMPTS) {
      console.error(`[stt-engine] Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached, giving up`);
      this._status = 'unavailable';
      return;
    }

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
      // Don't respawn if shutdown started after this restart was scheduled.
      if (this._stopping) {
        this._status = 'unavailable';
        return;
      }
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
      // Track the worker from creation (not just after 'ready') so shutdown() can
      // stop it cooperatively even while it is still loading the recognizer.
      this._spawningWorker = worker;
      const clearPending = () => { if (this._spawningWorker === worker) this._spawningWorker = null; };
      const detach = () => {
        worker.off('message', onReady);
        worker.off('error', onError);
        worker.off('exit', onBootExit);
      };

      const onReady = (msg) => {
        if (msg.type === 'ready') {
          detach();
          clearPending();
          // If shutdown started while this worker was still loading, do NOT
          // promote it to the active worker — that would resurrect a torn-down
          // engine. Ask it to exit and resolve init as cancelled.
          if (this._stopping) {
            this._status = 'unavailable';
            try { worker.postMessage({ type: 'shutdown' }); } catch { /* ignore */ }
            resolve();
            return;
          }
          this._worker = worker;
          this._status = 'ready';
          this._restartAttempts = 0;
          this._lastSpawnError = null;

          worker.on('message', (m) => this._onWorkerMessage(m));
          worker.on('exit', (c) => this._onWorkerExit(c));

          // Drain any queued requests from the backoff window
          this._processQueue();
          resolve();
        } else if (msg.type === 'error') {
          detach();
          clearPending();
          reject(new Error(msg.message));
        }
      };

      const onError = (err) => {
        detach();
        clearPending();
        // Tag dependency errors so _onWorkerExit can skip futile retries
        if (err.code === 'MODULE_NOT_FOUND' || (err.message && err.message.includes('sherpa-onnx-node'))) {
          this._lastSpawnError = 'MODULE_NOT_FOUND';
        }
        reject(err);
      };

      // If the worker dies before emitting ready/error, neither listener above
      // fires — without this the init Promise would hang forever (and shutdown
      // would burn its full bounded wait on it).
      const onBootExit = (code) => {
        detach();
        clearPending();
        this._status = 'unavailable';
        reject(new Error(`STT worker exited during init (code ${code})`));
      };

      worker.on('message', onReady);
      worker.on('error', onError);
      worker.on('exit', onBootExit);
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
      let wasCurrent = false;
      if (this._currentRequest && this._currentRequest.id === id) {
        this._currentRequest = null;
        wasCurrent = true;
      }
      // Process next item if the removed request was current
      if (wasCurrent) {
        this._processQueue();
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
    // PROC-02 gap 1: signal _onWorkerExit to skip the respawn path BEFORE
    // calling worker.terminate(), which fires the exit listener synchronously.
    // See docs/audits/proc-child-processes.md gap 1.
    this._stopping = true;

    // Shared time budget for the init-wait + cooperative-exit waits below, so the
    // whole engine teardown (run concurrently with the sticky-note engine by
    // handleShutdown) finishes inside handleShutdown's 15s force-exit budget,
    // leaving room for close(). Realistic teardown is sub-second; this only caps
    // pathological hangs.
    const deadline = Date.now() + 10000;
    const remaining = () => Math.max(0, deadline - Date.now());

    // If the worker is still initialising (model download/load in progress),
    // wait — bounded — for that to settle so we can tear it down cooperatively.
    // _doInitialize bails before spawning if _stopping is set, so this resolves
    // promptly with no worker when shutdown races an early startup; otherwise it
    // resolves once the recognizer is loaded and trackable in this._worker.
    // Killing a worker mid-native-load aborts the process (SIGABRT / exit 134).
    if (this._initPromise) {
      await Promise.race([
        Promise.resolve(this._initPromise).catch(() => {}),
        new Promise((resolve) => {
          const t = setTimeout(resolve, remaining());
          if (t.unref) t.unref();
        }),
      ]);
    }

    // Reject all queued requests
    for (const req of this._queue) {
      clearTimeout(req.timer);
      req.reject(new Error('STT engine shutting down'));
    }
    this._queue = [];
    this._currentRequest = null;

    // Cooperatively stop the worker — the live one, or one still booting (tracked
    // from creation in _spawnWorker). Ask it to exit on its own. We deliberately
    // do NOT call worker.terminate(): force-killing a thread inside native
    // sherpa-onnx code (mid-load or mid-transcribe) throws an uncaught Napi error
    // during worker-env teardown and ggml's set_terminate aborts the whole
    // process (SIGABRT / exit 134) — the bug this fixes. The wait is bounded
    // (shared deadline) so handleShutdown can still save sessions + close(); a
    // worker that never exits is reaped by handleShutdown's 15s force-exit
    // backstop.
    const w = this._worker || this._spawningWorker;
    this._worker = null;
    this._spawningWorker = null;
    if (w) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        w.once('exit', finish);
        try {
          w.postMessage({ type: 'shutdown' });
        } catch {
          finish();
        }
        const t = setTimeout(finish, Math.max(1000, remaining()));
        if (t.unref) t.unref();
      });
    }

    this._status = 'unavailable';
  }
}

module.exports = SttEngine;
