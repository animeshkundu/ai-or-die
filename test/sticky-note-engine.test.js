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
});
