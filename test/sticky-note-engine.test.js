'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const StickyNoteEngine = require('../src/sticky-note-engine');

function tick() {
  return new Promise((r) => setImmediate(r));
}

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.posted = [];
    this.terminated = false;
  }
  postMessage(m) {
    this.posted.push(m);
    // Mirror the real worker: a graceful shutdown request -> exit.
    if (m && m.type === 'shutdown') {
      setImmediate(() => this.emit('exit', 0));
    }
  }
  async terminate() {
    this.terminated = true;
    this.emit('exit', 0);
  }
  ready() {
    this.emit('message', { type: 'ready' });
  }
  reply(id, text) {
    this.emit('message', { type: 'result', id, text });
  }
  fail(code, message) {
    this.emit('message', { type: 'error', code, message });
  }
  crash(code = 1) {
    this.emit('exit', code);
  }
}

const readyMM = {
  isModelReady: async () => true,
  ensureModel: async () => {},
  getModelFile: () => '/tmp/model.gguf',
};

function makeEngine(opts = {}) {
  const fake = new FakeWorker();
  const engine = new StickyNoteEngine(
    Object.assign(
      {
        enabled: true,
        modelManager: opts.modelManager || readyMM,
        createWorker: () => fake,
        inferTimeoutMs: opts.inferTimeoutMs || 60000,
      },
      opts.engine || {}
    )
  );
  return { engine, fake };
}

describe('sticky-note engine', function () {
  it('initializes to ready and runs an inference', async function () {
    const { engine, fake } = makeEngine();
    const initP = engine.initialize();
    await tick(); // let model check resolve + worker spawn + listeners attach
    fake.ready();
    await initP;
    assert.strictEqual(engine.isReady(), true);

    const inferP = engine.infer('hello');
    await tick();
    assert.strictEqual(fake.posted.length, 1);
    assert.strictEqual(fake.posted[0].type, 'infer');
    fake.reply(fake.posted[0].id, '{"title":"T"}');
    assert.strictEqual(await inferP, '{"title":"T"}');

    await engine.shutdown();
  });

  it('defaults to a watchdog-grade 300s inference timeout (fits slow CPU inference)', function () {
    const engine = new StickyNoteEngine({ enabled: true, modelManager: readyMM });
    assert.strictEqual(engine._inferTimeoutMs, 300000);
  });

  it('treats numThreads as auto unless explicitly pinned (omits it from workerData)', function () {
    // Auto: no numThreads given -> worker decides based on the GPU backend.
    const auto = new StickyNoteEngine({ enabled: true, modelManager: readyMM });
    assert.strictEqual(auto._numThreadsExplicit, false);
    assert.strictEqual(auto._numThreads, null);
    assert.ok(!('numThreads' in auto._workerData()), 'auto must omit numThreads so the worker auto-picks');

    // Explicit pin (--sticky-notes-threads): forwarded verbatim.
    const pinned = new StickyNoteEngine({ enabled: true, modelManager: readyMM, numThreads: 6 });
    assert.strictEqual(pinned._numThreadsExplicit, true);
    assert.strictEqual(pinned._numThreads, 6);
    assert.strictEqual(pinned._workerData().numThreads, 6);

    // Bogus pins (0 / negative / NaN) fall back to auto.
    for (const bad of [0, -1, NaN]) {
      const e = new StickyNoteEngine({ enabled: true, modelManager: readyMM, numThreads: bad });
      assert.strictEqual(e._numThreadsExplicit, false, `numThreads=${bad} must be treated as auto`);
      assert.ok(!('numThreads' in e._workerData()));
    }
  });

  it('records the worker-reported runtime info ({gpu, threads}) on ready', async function () {
    const { engine, fake } = makeEngine();
    const initP = engine.initialize();
    await tick();
    fake.emit('message', { type: 'ready', gpu: false, threads: 8 });
    await initP;
    assert.deepStrictEqual(engine.getRuntimeInfo(), { gpu: false, threads: 8 });
    await engine.shutdown();
  });

  it('clears stale runtime info when the worker dies', async function () {
    const { engine, fake } = makeEngine();
    const initP = engine.initialize();
    await tick();
    fake.emit('message', { type: 'ready', gpu: false, threads: 8 });
    await initP;
    assert.ok(engine.getRuntimeInfo(), 'runtime info present while ready');
    engine._stopping = true; // prevent the scheduled respawn from lingering
    fake.crash(1);
    await tick();
    assert.strictEqual(engine.getRuntimeInfo(), null, 'must not report dead-worker backend/threads');
  });

  it('forwards a numeric-string thread pin as an explicit override', function () {
    const e = new StickyNoteEngine({ enabled: true, modelManager: readyMM, numThreads: '8' });
    assert.strictEqual(e._numThreadsExplicit, true);
    assert.strictEqual(e._numThreads, 8);
    assert.strictEqual(e._workerData().numThreads, 8);
  });

  it('degrades to unavailable when node-llama-cpp is missing', async function () {
    const { engine, fake } = makeEngine();
    const initP = engine.initialize();
    await tick();
    fake.fail('MODULE_NOT_FOUND', 'node-llama-cpp is not installed');
    await assert.rejects(initP);
    assert.strictEqual(engine.getStatus(), 'unavailable');
    assert.strictEqual(engine._lastSpawnError, 'MODULE_NOT_FOUND');
  });

  it('rejects infer when not ready', async function () {
    const engine = new StickyNoteEngine({ enabled: true, modelManager: readyMM, createWorker: () => new FakeWorker() });
    await assert.rejects(engine.infer('x'), /not ready/);
  });

  it('rejects queued requests when the worker crashes', async function () {
    const { engine, fake } = makeEngine();
    const initP = engine.initialize();
    await tick();
    fake.ready();
    await initP;

    const inferP = engine.infer('work');
    await tick();
    const rejected = assert.rejects(inferP, /crashed/);
    fake.crash(1);
    await rejected;
    assert.strictEqual(engine.getStatus(), 'loading'); // schedules a restart
    engine._stopping = true; // prevent the scheduled respawn from lingering
  });

  it('rejects an inference that times out', async function () {
    const { engine, fake } = makeEngine({ inferTimeoutMs: 30 });
    const initP = engine.initialize();
    await tick();
    fake.ready();
    await initP;
    await assert.rejects(engine.infer('slow'), /timed out/);
    await engine.shutdown();
  });

  it('rejects when the queue is full', async function () {
    const { engine, fake } = makeEngine();
    const initP = engine.initialize();
    await tick();
    fake.ready();
    await initP;

    const p1 = engine.infer('a').catch(() => {});
    const p2 = engine.infer('b').catch(() => {});
    const p3 = engine.infer('c').catch(() => {});
    await assert.rejects(engine.infer('d'), /busy/);
    void p1;
    void p2;
    void p3;
    await engine.shutdown();
  });

  it('stays unavailable when disabled', async function () {
    const engine = new StickyNoteEngine({ enabled: false, modelManager: readyMM });
    await engine.initialize();
    assert.strictEqual(engine.getStatus(), 'unavailable');
    assert.strictEqual(engine.isReady(), false);
  });

  it('refuses to spawn under Bun (node-llama-cpp crashes Bun) without loading the worker', async function () {
    const hadBun = Object.prototype.hasOwnProperty.call(process.versions, 'bun');
    const prevBun = process.versions.bun;
    Object.defineProperty(process.versions, 'bun', { value: '1.3.14', configurable: true, enumerable: true, writable: true });
    try {
      let spawned = 0;
      const engine = new StickyNoteEngine({
        enabled: true,
        modelManager: readyMM,
        createWorker: () => { spawned++; return new FakeWorker(); },
      });
      await engine.initialize();
      assert.strictEqual(spawned, 0, 'no worker spawned under Bun');
      assert.strictEqual(engine.getStatus(), 'unavailable');
      assert.strictEqual(engine.isReady(), false);
      assert.strictEqual(engine._lastSpawnError, 'BUN_UNSUPPORTED');
    } finally {
      if (hadBun) {
        Object.defineProperty(process.versions, 'bun', { value: prevBun, configurable: true, enumerable: true, writable: true });
      } else {
        delete process.versions.bun;
      }
    }
  });

  it('shuts the worker down gracefully (dispose before terminate)', async function () {
    const { engine, fake } = makeEngine();
    const initP = engine.initialize();
    await tick();
    fake.ready();
    await initP;
    await engine.shutdown();
    assert.ok(fake.posted.some((m) => m.type === 'shutdown'), 'sent graceful shutdown to worker');
    assert.strictEqual(engine.getStatus(), 'unavailable');
  });

  // Regression: Ctrl+C aborted the process (SIGABRT / exit 134) because the
  // ggml-based worker was force-killed via worker.terminate() / process.exit()
  // while its native model was live. shutdown() must stop the worker
  // COOPERATIVELY (graceful message -> worker disposes + exits) and never call
  // terminate(), which throws an uncaught Napi error during native teardown.
  it('shutdown() stops the worker cooperatively and never calls terminate()', async function () {
    const { engine, fake } = makeEngine();
    const initP = engine.initialize();
    await tick();
    fake.ready();
    await initP;
    assert.strictEqual(engine.isReady(), true);
    await engine.shutdown();
    assert.ok(fake.posted.some((m) => m && m.type === 'shutdown'), 'sent graceful shutdown message');
    assert.strictEqual(fake.terminated, false, 'must NOT call worker.terminate() (aborts the native worker)');
    assert.strictEqual(engine.getStatus(), 'unavailable');
  });

  // Regression: a worker that finishes loading AFTER shutdown began must not be
  // adopted as the active worker (resurrecting a torn-down engine); it must be
  // told to shut down instead.
  it('shutdown() does not adopt a worker that becomes ready afterwards', async function () {
    const { engine, fake } = makeEngine();
    const initP = engine.initialize();
    await tick(); // worker created + loading; not yet ready (tracked as pending)
    const sd = engine.shutdown(); // shutdown begins before 'ready'
    fake.ready(); // worker reports ready AFTER shutdown started
    await sd;
    await initP.catch(() => {});
    assert.strictEqual(engine._worker, null, 'must not adopt a worker that readied post-shutdown');
    assert.strictEqual(engine.getStatus(), 'unavailable');
    assert.ok(fake.posted.some((m) => m && m.type === 'shutdown'), 'asked the late-ready worker to shut down');
  });
});
