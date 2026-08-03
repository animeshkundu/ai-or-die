#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { runMemoryDiagnosis } = require('./memory-diagnosis');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const index = arg.indexOf('=');
    const key = index === -1 ? arg.slice(2) : arg.slice(2, index);
    out[key] = index === -1 ? true : arg.slice(index + 1);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runMemoryDiagnosis({
    arm: args.arm,
    operations: args.operations,
    repeats: args.repeats,
    ratePerSecond: args.rate,
    warmupMs: args['warmup-ms'],
    drainMs: args['drain-ms'],
    controlMs: args['control-ms'],
    payloadBytes: args['payload-bytes'],
  });
  const out = path.resolve(args.out || path.join(
    __dirname,
    '..',
    'results',
    `memory-diagnosis-${result.summary.arm}-${Date.now()}.json`,
  ));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify({ output: out, summary: result.summary }, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
