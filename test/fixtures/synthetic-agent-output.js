#!/usr/bin/env node

'use strict';

const chunkBytes = Number(process.env.AOD_SYNTHETIC_OUTPUT_CHUNK_BYTES) || 64 * 1024;
const chunkCount = Number(process.env.AOD_SYNTHETIC_OUTPUT_CHUNKS) || 32;
const chunk = 'x'.repeat(chunkBytes - 1) + '\n';
let emitted = 0;

function writeNext() {
  if (emitted >= chunkCount) {
    setTimeout(() => process.exit(0), 25);
    return;
  }
  emitted++;
  if (process.stdout.write(chunk)) setImmediate(writeNext);
  else process.stdout.once('drain', writeNext);
}

writeNext();
