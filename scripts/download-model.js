#!/usr/bin/env node
'use strict';

const ModelManager = require('../src/utils/model-manager');

const manager = new ModelManager();

console.log('Parakeet V3 INT8 model download');
console.log(`Target: ${manager.getModelPath()}`);
console.log('');

manager.ensureModel(({ file, downloaded, total, fileIndex, fileCount }) => {
  const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
  const dlMB = (downloaded / (1024 * 1024)).toFixed(1);
  const totalMB = (total / (1024 * 1024)).toFixed(1);
  process.stdout.write(
    `\r[${fileIndex + 1}/${fileCount}] ${file}: ${dlMB}/${totalMB} MB (${pct}%)`
  );
  if (downloaded >= total) {
    process.stdout.write('\n');
  }
}).then(() => {
  console.log('\nModel download complete.');
}).catch((err) => {
  console.error(`\nDownload failed: ${err.message}`);
  process.exit(1);
});
