'use strict';

const assert = require('assert');
const ModelHost = require('../src/model-host');

describe('model-host legacy status projection', function () {
  it('preserves the legacy status enum for every lifecycle state', function () {
    const allowed = new Set(['unavailable', 'downloading', 'loading', 'ready']);
    for (const state of ModelHost.states) {
      assert.ok(allowed.has(ModelHost.legacyProjection[state]), `${state} has a legacy projection`);
    }
    assert.strictEqual(ModelHost.legacyProjection.idle, 'ready');
    assert.strictEqual(ModelHost.legacyProjection.unloading, 'ready');
    assert.strictEqual(ModelHost.legacyProjection.restarting, 'ready');
  });
});
