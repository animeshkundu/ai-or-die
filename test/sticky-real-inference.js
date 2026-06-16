'use strict';

// Real inference smoke for the sticky-note engine: loads the actual LFM2-2.6B
// GGUF via node-llama-cpp in the real sticky-note worker, runs one grammar-
// constrained summary, and shuts the worker down cooperatively (the same
// {type:'shutdown'} path the Ctrl+C fix relies on). Requires the model on disk
// (~/.ai-or-die/models/LFM2-2.6B-Q4_K_M, via: node scripts/download-models.js sticky).
//
// This is the real-model counterpart to the deterministic, model-free
// e2e/tests/22-sticky-notes.spec.js. It is label-gated in CI (run-sticky) and
// is the consumer that exercises the cached sticky model.

const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');
const GgufModelManager = require('../src/utils/gguf-model-manager');

const WORKER_PATH = path.join(__dirname, '..', 'src', 'sticky-note-worker.js');

function spawnWorker(modelPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { modelPath, numThreads: 2, contextSize: 4096 },
    });
    const timeout = setTimeout(() => {
      reject(new Error('Worker did not become ready within 120s'));
      worker.terminate();
    }, 120000);
    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        clearTimeout(timeout);
        resolve(worker);
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(`Worker init error: ${msg.message}`));
      }
    });
    worker.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function infer(worker, prompt) {
  return new Promise((resolve, reject) => {
    const id = 1;
    const timeout = setTimeout(() => reject(new Error('Inference timed out after 90s')), 90000);
    const handler = (msg) => {
      if (msg.type !== 'result' || msg.id !== id) return;
      clearTimeout(timeout);
      worker.removeListener('message', handler);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.text);
    };
    worker.on('message', handler);
    worker.postMessage({ type: 'infer', id, prompt });
  });
}

// Cooperative shutdown — the worker disposes its native model and exits on its
// own (the Ctrl+C SIGABRT fix). Fail if it does not exit cleanly.
function shutdown(worker) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker did not exit within 15s of shutdown')), 15000);
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Worker exited with non-zero code ${code}`));
    });
    worker.postMessage({ type: 'shutdown' });
  });
}

async function main() {
  console.log('=== Sticky-note Real Inference Smoke ===\n');

  const mm = new GgufModelManager();
  const ready = await mm.isModelReady();
  console.log(`Model ready: ${ready}`);
  assert(ready === true, 'Sticky-note model not downloaded. Run: node scripts/download-models.js sticky');

  const modelPath = mm.getModelFile();
  console.log(`Model: ${modelPath}`);

  console.log('\nLoading LFM2-2.6B in worker thread...');
  const t0 = Date.now();
  const worker = await spawnWorker(modelPath);
  console.log(`Loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  let exited = false;
  try {
    const prompt =
      'Transcript:\nuser: add model caching to CI so the e2e jobs stop timing out\n' +
      'assistant: wrote scripts/download-models.js and a cache-models composite action; ' +
      'wired the STT cache into the browser jobs; remaining: sticky e2e coverage.\n\n' +
      'Summarise the session as a status note.';

    const t1 = Date.now();
    const text = await infer(worker, prompt);
    console.log(`\nInference (${((Date.now() - t1) / 1000).toFixed(1)}s) -> ${text}`);

    assert(typeof text === 'string' && text.trim().length > 0, 'expected a non-empty summary string');
    // The worker constrains output to NOTE_SCHEMA via a grammar, so it must be JSON.
    let note;
    assert.doesNotThrow(() => { note = JSON.parse(text); }, 'summary must be valid JSON (grammar-constrained)');
    assert(note && typeof note === 'object', 'summary must parse to an object');
    console.log('PASS: real grammar-constrained summary produced');

    await shutdown(worker);
    exited = true;
    console.log('PASS: worker shut down cooperatively (no abort)');

    console.log('\n=== Sticky-note Real Inference Smoke Passed ===');
  } finally {
    if (!exited) {
      try { await worker.terminate(); } catch (_) { /* ignore */ }
    }
  }
}

main().catch((err) => {
  console.error('\n=== Sticky-note Real Inference Smoke FAILED ===');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
