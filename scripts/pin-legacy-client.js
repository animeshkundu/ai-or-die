#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function readLegacyClientFile(baseRef, publicFile) {
  const safe = path.posix.normalize(publicFile).replace(/^(\.\.\/)+/, '');
  if (!/^[a-zA-Z0-9._/-]+$/.test(safe)) throw new Error('Invalid public client path');
  return execFileSync('git', ['show', `${baseRef}:src/public/${safe}`], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function materializeLegacyClient(baseRef, files, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const file of files) {
    const destination = path.join(outputDir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, readLegacyClientFile(baseRef, file));
  }
}

if (require.main === module) {
  const [baseRef, outputDir, ...files] = process.argv.slice(2);
  if (!baseRef || !outputDir || files.length === 0) {
    console.error('Usage: pin-legacy-client <base-ref> <output-dir> <public-file...>');
    process.exit(78);
  }
  materializeLegacyClient(baseRef, files, outputDir);
}

module.exports = { readLegacyClientFile, materializeLegacyClient };
