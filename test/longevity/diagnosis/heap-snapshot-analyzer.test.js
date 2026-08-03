'use strict';

const assert = require('assert');
const path = require('path');

const { analyzeHeapSnapshot } = require('../harness/heap-snapshot-analyzer');

describe('streaming heap snapshot dominator analyzer', function () {
  it('computes retained sizes and excludes weak edges on a known object graph', async function () {
    const fixture = path.join(__dirname, '..', '..', 'fixtures', 'heap-snapshot-small.heapsnapshot');
    const result = await analyzeHeapSnapshot(fixture, { limit: 10 });
    assert.strictEqual(result.node_count, 4);
    assert.strictEqual(result.edge_count, 3);
    assert.strictEqual(result.reachable_nodes, 3);
    assert.strictEqual(result.weak_edges_excluded, 1);

    const owner = result.top_retainers.find((node) => node.name === 'Owner');
    const child = result.top_retainers.find((node) => node.name === 'Child');
    const weakOnly = result.top_retainers.find((node) => node.name === 'WeakOnly');
    assert(owner);
    assert(child);
    assert.strictEqual(owner.self_size, 10);
    assert.strictEqual(owner.retained_size, 40);
    assert.strictEqual(child.retained_size, 30);
    assert.strictEqual(child.immediate_dominator, owner.node);
    assert.deepStrictEqual(child.retainer_chain.map((node) => node.name), ['Child', 'Owner', 'root']);
    assert.strictEqual(weakOnly, undefined, 'weak-only target must not enter the retaining graph');
  });
});
