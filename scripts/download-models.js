#!/usr/bin/env node
'use strict';

// Pre-download the local model(s) into ~/.ai-or-die/models so CI can cache them
// (and so the per-spec on-demand download never runs inside a timed test job).
//
// Usage:
//   node scripts/download-models.js            # both models
//   node scripts/download-models.js both       # both models
//   node scripts/download-models.js stt        # STT (Parakeet V3) only
//   node scripts/download-models.js sticky     # sticky-note (LFM2-2.6B) only
//   node scripts/download-models.js --stt --sticky   # flags also work
//
// STT lands in ~/.ai-or-die/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
// Sticky lands in ~/.ai-or-die/models/LFM2-2.6B-Q4_K_M

const argv = process.argv.slice(2).map((a) => a.toLowerCase());
const wantsAll = argv.length === 0 || argv.includes('both') || argv.includes('all');
const doStt = wantsAll || argv.includes('stt') || argv.includes('--stt');
const doSticky = wantsAll || argv.includes('sticky') || argv.includes('--sticky');

function onProgress(label) {
  return ({ file, downloaded, total, fileIndex, fileCount }) => {
    const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
    const dlMB = (downloaded / (1024 * 1024)).toFixed(0);
    const totalMB = (total / (1024 * 1024)).toFixed(0);
    process.stdout.write(
      `\r[${label}] [${(fileIndex || 0) + 1}/${fileCount || 1}] ${file}: ${dlMB}/${totalMB} MB (${pct}%)   `
    );
    if (downloaded >= total) process.stdout.write('\n');
  };
}

async function main() {
  if (doStt) {
    const ModelManager = require('../src/utils/model-manager');
    const m = new ModelManager();
    console.log(`STT (Parakeet V3 INT8) -> ${m.getModelPath()}`);
    await m.ensureModel(onProgress('STT'));
    console.log('STT model ready.');
  }
  if (doSticky) {
    const GgufModelManager = require('../src/utils/gguf-model-manager');
    const m = new GgufModelManager();
    console.log(`Sticky-note (LFM2-2.6B Q4_K_M) -> ${m.getModelFile()}`);
    await m.ensureModel(onProgress('sticky'));
    console.log('Sticky-note model ready.');
  }
  console.log('\nAll requested models ready.');
}

main().catch((err) => {
  console.error(`\nDownload failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
