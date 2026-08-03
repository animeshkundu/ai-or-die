#!/usr/bin/env bun

'use strict';

const assert = require('assert');
const path = require('path');
const ModelHost = require('../../src/model-host');

async function main() {
  const host = new ModelHost({
    name: 'bun-smoke',
    entryPath: path.join(__dirname, 'model-host-fixture.js'),
    readinessTimeoutMs: 10000,
  });
  try {
    await host.demand();
    const result = await host.request({ dtype: 'utf8', payload: 'bun-six-stdio' });
    assert.strictEqual(result.text, 'bun-six-stdio');
    assert.strictEqual(await host.unload(), true);
  } finally {
    await host.shutdown();
  }
  process.stdout.write('bun model-host smoke passed\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
