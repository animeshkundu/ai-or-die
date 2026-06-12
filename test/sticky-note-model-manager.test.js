'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const GgufModelManager = require('../src/utils/gguf-model-manager');

describe('gguf model manager', function () {
  let dir;
  const MODEL = { id: 'test-model', file: 'test.gguf', url: 'http://example/test.gguf', expectedSize: 32, sha256: null };

  beforeEach(async function () {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aod-gguf-'));
  });
  afterEach(async function () {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('resolves the model file path under the models dir', function () {
    const m = new GgufModelManager({ model: MODEL, modelsDir: dir });
    assert.strictEqual(m.getModelFile(), path.join(dir, 'test.gguf'));
  });

  it('reports not-ready when the file is missing', async function () {
    const m = new GgufModelManager({ model: MODEL, modelsDir: dir });
    assert.strictEqual(await m.isModelReady(), false);
  });

  it('reports ready when a correctly-sized file exists', async function () {
    const m = new GgufModelManager({ model: MODEL, modelsDir: dir });
    await fsp.writeFile(m.getModelFile(), Buffer.alloc(32));
    assert.strictEqual(await m.isModelReady(), true);
  });

  it('reports not-ready when the size is wrong', async function () {
    const m = new GgufModelManager({ model: MODEL, modelsDir: dir });
    await fsp.writeFile(m.getModelFile(), Buffer.alloc(16)); // wrong size
    assert.strictEqual(await m.isModelReady(), false);
  });

  it('ensureModel short-circuits (progress 100%) when already present', async function () {
    const m = new GgufModelManager({ model: MODEL, modelsDir: dir });
    await fsp.writeFile(m.getModelFile(), Buffer.alloc(32));
    let last = null;
    await m.ensureModel((p) => {
      last = p;
    });
    assert.ok(last && last.percent === 100 && last.file === 'test.gguf');
  });

  it('default model points at the ungated ggml-org Gemma 3 1B Q4_K_M', function () {
    assert.strictEqual(GgufModelManager.DEFAULT_MODEL.expectedSize, 806058240);
    assert.ok(GgufModelManager.DEFAULT_MODEL.url.includes('ggml-org/gemma-3-1b-it-GGUF'));
    assert.ok(GgufModelManager.DEFAULT_MODEL.file.endsWith('.gguf'));
  });
});
