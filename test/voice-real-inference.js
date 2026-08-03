'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ModelManager = require('../src/utils/model-manager');
const SttEngine = require('../src/stt-engine');

const fixtures = path.join(__dirname, 'fixtures');

function readWavAsFloat32(filePath) {
  const buffer = fs.readFileSync(filePath);
  const int16 = new Int16Array(
    buffer.buffer,
    buffer.byteOffset + 44,
    (buffer.byteLength - 44) / 2
  );
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
  return float32;
}

async function main() {
  console.log('=== Real STT Model-Host Inference ===\n');
  const manager = new ModelManager();
  assert(await manager.isModelReady(), 'Model not downloaded. Run: node scripts/download-model.js');
  const engine = new SttEngine({ enabled: true, modelManager: manager, numThreads: 2 });
  try {
    const loadStarted = Date.now();
    await engine.demand();
    const loadTime = Date.now() - loadStarted;
    console.log(`Host ready in ${(loadTime / 1000).toFixed(1)}s (pid ${engine.getDiagnostics().pid})`);

    const hello = readWavAsFloat32(path.join(fixtures, 'hello-world.wav'));
    const inferStarted = Date.now();
    const helloText = await engine.transcribe(hello);
    const inferTime = Date.now() - inferStarted;
    assert.strictEqual(typeof helloText, 'string');
    console.log(`hello-world.wav: "${helloText}" in ${(inferTime / 1000).toFixed(1)}s`);

    const silence = readWavAsFloat32(path.join(fixtures, 'silence.wav'));
    assert.strictEqual(typeof await engine.transcribe(silence), 'string');
    assert.ok(loadTime < 25000, `Model cold start exceeded 25s: ${loadTime}ms`);
    assert.ok(inferTime < 30000, `Transcription too slow: ${inferTime}ms`);
    console.log('\n=== Real STT Model-Host Inference Passed ===');
  } finally {
    await engine.shutdown();
  }
}

main().catch((error) => {
  console.error('\n=== Real STT Model-Host Inference FAILED ===');
  console.error(error.message);
  process.exit(1);
});
