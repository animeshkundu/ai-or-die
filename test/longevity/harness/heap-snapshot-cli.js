#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { analyzeHeapSnapshot } = require('./heap-snapshot-analyzer');

async function main(argv = process.argv) {
  const input = argv[2];
  if (!input) throw new Error('usage: heap-snapshot-cli.js <snapshot> [derived-output.json]');
  const output = path.resolve(argv[3] || `${input}.derived.json`);
  const result = await analyzeHeapSnapshot(path.resolve(input));
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
