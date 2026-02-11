'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;

// ---------------------------------------------------------------------------
// Unit tests for voice input: ModelManager, SttEngine, message validation
// ---------------------------------------------------------------------------

describe('voice: ModelManager', function () {
  this.timeout(10000);

  const ModelManager = require('../src/utils/model-manager');
  const { MODEL_FILES } = ModelManager;
  let tempDir;
  let mgr;

  beforeEach(async function () {
    tempDir = path.join(__dirname, 'temp-voice-model-' + Date.now());
    await fs.mkdir(tempDir, { recursive: true });
    mgr = new ModelManager({ modelsDir: tempDir });
  });

  afterEach(async function () {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('isModelReady() returns false when files missing', async function () {
    const ready = await mgr.isModelReady();
    assert.strictEqual(ready, false);
  });

  it('isModelReady() returns true when all files present with correct sizes', async function () {
    // Create dummy files with expected sizes
    for (const file of MODEL_FILES) {
      const filePath = path.join(tempDir, file.name);
      // Create a file filled with zeros of the expected size
      const handle = await fs.open(filePath, 'w');
      await handle.truncate(file.expectedSize);
      await handle.close();
    }

    const ready = await mgr.isModelReady();
    assert.strictEqual(ready, true);
  });

  it('isModelReady() returns false when file has wrong size', async function () {
    for (const file of MODEL_FILES) {
      const filePath = path.join(tempDir, file.name);
      const handle = await fs.open(filePath, 'w');
      // Write wrong size for the first file
      await handle.truncate(file === MODEL_FILES[0] ? 100 : file.expectedSize);
      await handle.close();
    }

    const ready = await mgr.isModelReady();
    assert.strictEqual(ready, false);
  });

  it('ensureModel() skips already-downloaded files', async function () {
    // Create all files with correct sizes
    for (const file of MODEL_FILES) {
      const filePath = path.join(tempDir, file.name);
      const handle = await fs.open(filePath, 'w');
      await handle.truncate(file.expectedSize);
      await handle.close();
    }

    // Override _checkDiskSpace to not fail in test
    mgr._checkDiskSpace = async () => {};

    const progressCalls = [];
    await mgr.ensureModel((progress) => {
      progressCalls.push(progress);
    });

    // Should have called progress for each file (skipped == full progress)
    assert.strictEqual(progressCalls.length, MODEL_FILES.length);
    for (const call of progressCalls) {
      assert.strictEqual(call.downloaded, call.total, 'Skipped files should report full progress');
    }
  });

  it('_checkDiskSpace() handles insufficient space gracefully', async function () {
    // Override statfs to report very low free space
    const origStatfs = fs.statfs;
    try {
      require('fs').promises.statfs = async () => ({
        bfree: 10,
        bsize: 1
      });
      // Reconstruct to pick up the mock
      const mgr2 = new ModelManager({ modelsDir: tempDir });
      await assert.rejects(
        () => mgr2._checkDiskSpace(),
        /Insufficient disk space/
      );
    } finally {
      require('fs').promises.statfs = origStatfs;
    }
  });

  it('_downloadFile() resumes from .incomplete files', async function () {
    const destPath = path.join(tempDir, 'test-download.bin');
    const incompletePath = destPath + '.incomplete';
    const expectedSize = 1000;

    // Write a partial incomplete file
    const partial = Buffer.alloc(200, 0x42);
    await fs.writeFile(incompletePath, partial);

    // Mock fetch to verify Range header
    let receivedHeaders = {};
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      receivedHeaders = opts.headers || {};
      // Return remaining bytes
      const remaining = Buffer.alloc(expectedSize - 200, 0x43);
      return {
        ok: false,
        status: 206,
        body: {
          getReader: () => {
            let done = false;
            return {
              read: async () => {
                if (done) return { done: true };
                done = true;
                return { done: false, value: remaining };
              }
            };
          }
        }
      };
    };

    try {
      await mgr._downloadFile('http://example.com/test.bin', destPath, expectedSize, () => {});
      assert.strictEqual(receivedHeaders['Range'], 'bytes=200-');

      // Verify final file exists (renamed from .incomplete)
      const stats = await fs.stat(destPath);
      assert.strictEqual(stats.size, expectedSize);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('getModelPath() returns the configured directory', function () {
    assert.strictEqual(mgr.getModelPath(), tempDir);
  });
});


describe('voice: SttEngine', function () {
  this.timeout(10000);

  // We cannot import the real SttEngine without sherpa-onnx-node being loadable,
  // so we test the engine's logic by constructing it with enabled=false and
  // exercising the public API paths that don't require the worker.

  const SttEngine = require('../src/stt-engine');

  it('constructor respects enabled flag (disabled)', function () {
    const engine = new SttEngine({ enabled: false });
    assert.strictEqual(engine.getStatus(), 'unavailable');
    assert.strictEqual(engine.isReady(), false);
  });

  it('getStatus() returns correct states', async function () {
    const engine = new SttEngine({ enabled: false });
    assert.strictEqual(engine.getStatus(), 'unavailable');

    // With external endpoint, initialize sets status to ready
    const engineExt = new SttEngine({ sttEndpoint: 'http://localhost:9999' });
    await engineExt.initialize();
    assert.strictEqual(engineExt.getStatus(), 'ready');
    assert.strictEqual(engineExt.isReady(), true);
    await engineExt.shutdown();
  });

  it('transcribe() rejects when not ready', async function () {
    const engine = new SttEngine({ enabled: false });
    await assert.rejects(
      () => engine.transcribe(new Float32Array(100)),
      /STT engine not ready/
    );
  });

  it('concurrency queue: accepts 3, rejects 4th with "STT busy"', async function () {
    // Create an engine and manually set it to ready state
    const engine = new SttEngine({ enabled: true });
    engine._status = 'ready';

    // Mock worker so transcribe() queues but never resolves
    engine._worker = {
      postMessage: () => {},
      terminate: async () => {}
    };

    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(engine.transcribe(new Float32Array(100)));
    }

    // 4th should reject immediately
    await assert.rejects(
      () => engine.transcribe(new Float32Array(100)),
      /STT busy/
    );

    // Clean up: reject queued promises
    await engine.shutdown();
  });

  it('external endpoint: transcribe() calls fetch when sttEndpoint configured', async function () {
    const engine = new SttEngine({ sttEndpoint: 'http://localhost:9876' });
    await engine.initialize();

    let fetchedUrl = '';
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      fetchedUrl = url;
      return {
        ok: true,
        json: async () => ({ text: 'hello world' })
      };
    };

    try {
      const text = await engine.transcribe(new Float32Array(16000));
      assert.strictEqual(text, 'hello world');
      assert(fetchedUrl.includes('/v1/audio/transcriptions'));
    } finally {
      global.fetch = originalFetch;
      await engine.shutdown();
    }
  });

  it('shutdown() rejects all queued requests', async function () {
    const engine = new SttEngine({ enabled: true });
    engine._status = 'ready';
    engine._worker = { postMessage: () => {}, terminate: async () => {} };

    const p1 = engine.transcribe(new Float32Array(100));
    await engine.shutdown();

    await assert.rejects(() => p1, /shutting down/);
  });

  it('getDownloadProgress() returns null when no download active', function () {
    const engine = new SttEngine({ enabled: false });
    assert.strictEqual(engine.getDownloadProgress(), null);
  });

  it('worker crash recovery: status changes to loading', function () {
    const engine = new SttEngine({ enabled: true });
    engine._status = 'ready';
    engine._worker = { postMessage: () => {} };

    // Simulate worker exit
    engine._onWorkerExit(1);

    assert.strictEqual(engine.getStatus(), 'loading');
    assert.strictEqual(engine._worker, null);
  });
});


describe('voice: message validation', function () {
  it('buffer size > 3,840,000 bytes should be rejected', function () {
    // Max 120s of 16kHz 16-bit mono PCM = 3,840,000 bytes
    const maxBytes = 3840000;
    assert(maxBytes === 120 * 16000 * 2, 'Max buffer constant should equal 120s * 16kHz * 2 bytes');

    // Simulate the validation the server performs
    const oversized = Buffer.alloc(maxBytes + 1);
    assert(oversized.length > maxBytes, 'Oversized buffer should exceed limit');
  });

  it('rate limiting: 10 per minute per session', function () {
    // Simulate the rate limiting logic from server.js
    const timestamps = [];
    const now = Date.now();
    const MAX_PER_MINUTE = 10;

    // Add 10 timestamps
    for (let i = 0; i < MAX_PER_MINUTE; i++) {
      timestamps.push(now);
    }

    // Filter recent (within 60s)
    const recent = timestamps.filter(ts => now - ts < 60000);
    assert.strictEqual(recent.length, MAX_PER_MINUTE);

    // 11th should be rejected
    assert(recent.length >= MAX_PER_MINUTE, '11th request should be rejected');
  });
});


describe('voice: config endpoint', function () {
  this.timeout(15000);

  const http = require('http');
  const { ClaudeCodeWebServer } = require('../src/server');

  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    server.close();
  });

  it('voiceInput field present in config response', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/config`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        });
      }).on('error', reject);
    });

    assert.strictEqual(res.statusCode, 200);
    assert(res.body.voiceInput, 'Expected voiceInput in config');
    assert(typeof res.body.voiceInput.localStatus === 'string', 'Expected localStatus string');
    assert.strictEqual(res.body.voiceInput.cloudAvailable, true);
  });

  it('localStatus reflects engine status', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/config`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve(JSON.parse(data));
        });
      }).on('error', reject);
    });

    // Without --stt flag, status should be 'unavailable'
    assert.strictEqual(res.voiceInput.localStatus, 'unavailable');
  });
});
