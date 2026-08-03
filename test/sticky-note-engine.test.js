'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const StickyNoteEngine = require('../src/sticky-note-engine');

const readyModel = {
  isModelReady: async () => true,
  ensureModel: async () => {},
  getModelFile: () => '/tmp/model.gguf',
};

class FakeHost extends EventEmitter {
  constructor(options = {}) {
    super();
    this.state = 'idle';
    this.requests = [];
    this.runtimeInfo = options.runtimeInfo || { gpu: false, threads: 8 };
    this.pending = !!options.pending;
    this.failure = options.failure || null;
    this.active = false;
    this.terminateCalls = 0;
    this.pid = 4321;
  }
  async demand() {
    if (this.failure) throw this.failure;
    this.state = 'ready';
    this.emit('state', 'ready');
  }
  request(request) {
    this.requests.push(request);
    if (this.pending) return new Promise((resolve, reject) => this.requests[this.requests.length - 1].deferred = { resolve, reject });
    return this.failure ? Promise.reject(this.failure) : Promise.resolve({ text: '{"title":"T"}' });
  }
  setActive(active) { this.active = active; }
  async unload() {
    if (this.state !== 'ready') return false;
    this.state = 'idle';
    this.emit('state', 'idle');
    return true;
  }
  async shutdown() {
    for (const request of this.requests) {
      if (request.deferred) request.deferred.reject(new Error('sticky-note model host exited'));
    }
    this.state = 'idle';
    this.emit('state', 'idle');
  }
  terminate() {
    this.terminateCalls++;
    throw new Error('terminate must never be called');
  }
  getState() { return this.state; }
  getStatus() { return this.state === 'failed' ? 'unavailable' : 'ready'; }
  getRuntimeInfo() { return this.state === 'ready' ? this.runtimeInfo : null; }
  diagnostics() { return { name: 'sticky-note', state: this.state, status: this.getStatus(), pid: this.state === 'ready' ? this.pid : null }; }
}

function makeEngine(hostOptions = {}, engineOptions = {}) {
  const host = new FakeHost(hostOptions);
  const engine = new StickyNoteEngine({
    enabled: true,
    modelManager: readyModel,
    hostFactory: () => host,
    ...engineOptions,
  });
  return { engine, host };
}

describe('sticky-note engine', function () {
  it('initializes a host and runs inference through the binary-host boundary', async function () {
    const { engine, host } = makeEngine();
    await engine.initialize();
    assert.strictEqual(engine.isReady(), true);
    assert.strictEqual(await engine.infer('hello'), '{"title":"T"}');
    assert.strictEqual(host.requests[0].dtype, 'utf8');
    assert.strictEqual(host.requests[0].payload.toString(), 'hello');
  });

  it('does not construct a host until model preparation completes', async function () {
    let release;
    let hostCreated = 0;
    const manager = {
      isModelReady: async () => false,
      ensureModel: () => new Promise((resolve) => { release = resolve; }),
      getModelFile: () => '/tmp/model.gguf',
    };
    const host = new FakeHost();
    const engine = new StickyNoteEngine({
      enabled: true,
      modelManager: manager,
      hostFactory: () => {
        hostCreated++;
        return host;
      },
    });
    const inference = engine.infer('wait for download');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(hostCreated, 0);
    release();
    assert.strictEqual(await inference, '{"title":"T"}');
    assert.strictEqual(hostCreated, 1);
  });

  it('defaults to a watchdog-grade 300s inference timeout', function () {
    assert.strictEqual(makeEngine().engine._inferTimeoutMs, 300000);
  });

  it('omits auto thread selection from host data', function () {
    const auto = makeEngine().engine;
    assert.strictEqual(auto._numThreadsExplicit, false);
    assert.ok(!('numThreads' in auto._workerData()));
  });

  it('forwards an explicit thread pin', function () {
    const pinned = makeEngine({}, { numThreads: 6 }).engine;
    assert.strictEqual(pinned._workerData().numThreads, 6);
  });

  it('forwards a numeric-string thread pin', function () {
    const pinned = makeEngine({}, { numThreads: '8' }).engine;
    assert.strictEqual(pinned._workerData().numThreads, 8);
  });

  it('ignores invalid thread pins', function () {
    for (const value of [0, -1, NaN]) {
      assert.ok(!('numThreads' in makeEngine({}, { numThreads: value }).engine._workerData()));
    }
  });

  it('reports runtime backend information from the ready host', async function () {
    const { engine } = makeEngine({ runtimeInfo: { gpu: true, threads: 4 } });
    await engine.initialize();
    assert.deepStrictEqual(engine.getRuntimeInfo(), { gpu: true, threads: 4 });
  });

  it('clears runtime information after host retirement', async function () {
    const { engine, host } = makeEngine();
    await engine.initialize();
    host.state = 'restarting';
    host.emit('state', 'restarting');
    assert.strictEqual(engine.getRuntimeInfo(), null);
  });

  it('surfaces a permanent host load failure', async function () {
    const error = new Error('node-llama-cpp is not installed');
    error.code = 'MODULE_NOT_FOUND';
    const { engine } = makeEngine({ failure: error });
    await assert.rejects(engine.initialize(), /not installed/);
  });

  it('rejects inference when disabled', async function () {
    const engine = new StickyNoteEngine({ enabled: false, modelManager: readyModel });
    await assert.rejects(engine.infer('x'), /not ready/);
  });

  it('rejects a request when its host crashes', async function () {
    const { engine, host } = makeEngine({ pending: true });
    await engine.initialize();
    const inference = engine.infer('work');
    await new Promise((resolve) => setImmediate(resolve));
    host.requests[0].deferred.reject(new Error('sticky-note model host exited'));
    await assert.rejects(inference, /exited/);
  });

  it('enforces the bounded request queue', async function () {
    const { engine } = makeEngine({ pending: true });
    await engine.initialize();
    const pending = [engine.infer('a'), engine.infer('b'), engine.infer('c')];
    pending.forEach((promise) => promise.catch(() => {}));
    await assert.rejects(engine.infer('d'), /busy/);
    await engine.shutdown();
  });

  it('stays unavailable when disabled', async function () {
    const engine = new StickyNoteEngine({ enabled: false, modelManager: readyModel });
    await engine.ensureDownloaded();
    assert.strictEqual(engine.getStatus(), 'unavailable');
  });

  it('does not check, download, or spawn a host unless summaries are explicitly enabled', async function () {
    let checked = 0;
    let downloaded = 0;
    let spawned = 0;
    const engine = new StickyNoteEngine({
      enabled: false,
      modelManager: {
        isModelReady: async () => { checked++; return false; },
        ensureModel: async () => { downloaded++; },
        getModelFile: () => '/tmp/model.gguf',
      },
      hostFactory: () => { spawned++; return new FakeHost(); },
    });

    await engine.initialize();

    assert.strictEqual(checked, 0, 'disabled engine must not probe the GGUF');
    assert.strictEqual(downloaded, 0, 'disabled engine must not download the GGUF');
    assert.strictEqual(spawned, 0, 'disabled engine must not create a model host');
  });

  it('refuses to load under Bun', async function () {
    const hadBun = Object.prototype.hasOwnProperty.call(process.versions, 'bun');
    const previous = process.versions.bun;
    Object.defineProperty(process.versions, 'bun', { value: '1.3.14', configurable: true });
    try {
      const engine = new StickyNoteEngine({ enabled: true, modelManager: readyModel });
      await engine.ensureDownloaded();
      assert.strictEqual(engine.getStatus(), 'unavailable');
      assert.strictEqual(engine._lastSpawnError, 'BUN_UNSUPPORTED');
    } finally {
      if (hadBun) Object.defineProperty(process.versions, 'bun', { value: previous, configurable: true });
      else delete process.versions.bun;
    }
  });

  it('unload is effective only after the host is ready', async function () {
    const { engine } = makeEngine();
    assert.strictEqual(await engine.unload(), false);
    await engine.initialize();
    assert.strictEqual(await engine.unload(), true);
    assert.strictEqual(engine.getLifecycleState(), 'idle');
  });

  it('expansion warms and holds the host; collapse releases the hold', async function () {
    const { engine, host } = makeEngine();
    await engine.setActive(true);
    assert.strictEqual(host.active, true);
    await engine.setActive(false);
    assert.strictEqual(host.active, false);
  });

  it('shutdown retires the child without a worker-thread terminate path', async function () {
    const { engine, host } = makeEngine();
    await engine.initialize();
    await engine.shutdown();
    assert.strictEqual(engine.getLifecycleState(), 'idle');
    assert.strictEqual(host.terminateCalls, 0);
  });
});
