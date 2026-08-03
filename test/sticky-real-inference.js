'use strict';

const assert = require('assert');
const GgufModelManager = require('../src/utils/gguf-model-manager');
const StickyNoteEngine = require('../src/sticky-note-engine');

async function main() {
  console.log('=== Sticky-note Model-Host Inference ===\n');
  const manager = new GgufModelManager();
  assert(await manager.isModelReady(),
    'Sticky-note model not downloaded. Run: node scripts/download-models.js sticky');
  const engine = new StickyNoteEngine({
    enabled: true,
    modelManager: manager,
    contextSize: 4096,
  });
  try {
    const loadStarted = Date.now();
    await engine.demand();
    console.log(`Host ready in ${((Date.now() - loadStarted) / 1000).toFixed(1)}s ` +
      `(pid ${engine.getDiagnostics().pid})`);
    const prompt =
      'Transcript:\nuser: add model caching so browser jobs stop timing out\n' +
      'assistant: wired model caching; remaining: process isolation coverage.\n\n' +
      'Summarise the session as a status note.';
    const inferStarted = Date.now();
    const text = await engine.infer(prompt);
    console.log(`Inference (${((Date.now() - inferStarted) / 1000).toFixed(1)}s) -> ${text}`);
    assert.ok(text.trim(), 'expected a non-empty summary');
    assert.doesNotThrow(() => JSON.parse(text), 'summary must be grammar-constrained JSON');
    console.log('\n=== Sticky-note Model-Host Inference Passed ===');
  } finally {
    await engine.shutdown();
  }
}

main().catch((error) => {
  console.error('\n=== Sticky-note Model-Host Inference FAILED ===');
  console.error(error.message);
  process.exit(1);
});
