'use strict';

// Real inference test: loads actual Parakeet V3 model via sherpa-onnx-node
// and transcribes test audio fixtures. Requires the model to be downloaded
// at ~/.ai-or-die/models/ (use: node scripts/download-model.js).

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { ModelManager } = require('../src/utils/model-manager');

const FIXTURES = path.join(__dirname, 'fixtures');
const WORKER_PATH = path.join(__dirname, '..', 'src', 'stt-worker.js');

// Helper: read a WAV file and return Float32Array samples
function readWavAsFloat32(filePath) {
  const buf = fs.readFileSync(filePath);
  // WAV header: first 44 bytes
  const dataOffset = 44;
  const int16 = new Int16Array(buf.buffer, buf.byteOffset + dataOffset, (buf.byteLength - dataOffset) / 2);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }
  return float32;
}

// Helper: spawn the stt-worker and wait for ready
function spawnWorker(modelDir) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        modelDir,
        numThreads: 2,
        nodeModulesDir: path.join(__dirname, '..', 'node_modules'),
      }
    });

    const timeout = setTimeout(() => {
      reject(new Error('Worker did not become ready within 60s'));
      worker.terminate();
    }, 60000);

    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        clearTimeout(timeout);
        resolve(worker);
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(`Worker init error: ${msg.message}`));
      }
    });

    worker.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Helper: transcribe via worker
function transcribe(worker, samples) {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const timeout = setTimeout(() => reject(new Error('Transcription timed out after 60s')), 60000);

    const handler = (msg) => {
      if (msg.id === id) {
        clearTimeout(timeout);
        worker.removeListener('message', handler);
        if (msg.error) {
          reject(new Error(msg.error));
        } else {
          resolve(msg.text);
        }
      }
    };
    worker.on('message', handler);
    worker.postMessage({ type: 'transcribe', id, samples: samples.buffer });
  });
}

async function main() {
  console.log('=== Real Inference Tests ===\n');

  // 1. Verify model is downloaded
  const mm = new ModelManager();
  const modelReady = mm.isModelReady();
  console.log(`Model ready: ${modelReady}`);
  assert(modelReady, 'Model not downloaded. Run: node scripts/download-model.js');

  const modelDir = mm.getModelPath();
  console.log(`Model path: ${modelDir}`);

  // 2. Verify all model files exist
  const requiredFiles = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
  for (const file of requiredFiles) {
    const filePath = path.join(modelDir, file);
    assert(fs.existsSync(filePath), `Missing model file: ${file}`);
    const stat = fs.statSync(filePath);
    console.log(`  ${file}: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  }

  // 3. Spawn worker and load model
  console.log('\nLoading model in worker thread...');
  const startLoad = Date.now();
  const worker = await spawnWorker(modelDir);
  const loadTime = Date.now() - startLoad;
  console.log(`Model loaded in ${(loadTime / 1000).toFixed(1)}s`);

  try {
    // 4. Transcribe hello-world.wav (440Hz tone — not real speech,
    //    but validates the pipeline works without errors)
    const helloSamples = readWavAsFloat32(path.join(FIXTURES, 'hello-world.wav'));
    console.log(`\nhello-world.wav: ${helloSamples.length} samples (${(helloSamples.length / 16000).toFixed(1)}s)`);

    const startTranscribe = Date.now();
    const helloText = await transcribe(worker, helloSamples);
    const transcribeTime = Date.now() - startTranscribe;
    console.log(`Transcription: "${helloText}"`);
    console.log(`Time: ${(transcribeTime / 1000).toFixed(1)}s`);

    // The 440Hz tone is not speech, so we expect empty or minimal text.
    // The critical test is that inference completes without crashing.
    assert(typeof helloText === 'string', 'Expected string result from transcription');
    console.log('PASS: hello-world.wav transcription completed without error');

    // 5. Transcribe silence.wav — should return empty/minimal text
    const silenceSamples = readWavAsFloat32(path.join(FIXTURES, 'silence.wav'));
    console.log(`\nsilence.wav: ${silenceSamples.length} samples (${(silenceSamples.length / 16000).toFixed(1)}s)`);

    const silenceText = await transcribe(worker, silenceSamples);
    console.log(`Transcription: "${silenceText}"`);
    assert(typeof silenceText === 'string', 'Expected string result from silence transcription');
    console.log('PASS: silence.wav transcription completed without error');

    // 6. Performance sanity check
    assert(loadTime < 60000, `Model load too slow: ${loadTime}ms`);
    assert(transcribeTime < 30000, `Transcription too slow: ${transcribeTime}ms for 5s audio`);
    console.log('PASS: performance within acceptable bounds');

    console.log('\n=== All Real Inference Tests Passed ===');
  } finally {
    await worker.terminate();
  }
}

main().catch((err) => {
  console.error('\n=== Real Inference Test FAILED ===');
  console.error(err.message);
  process.exit(1);
});
