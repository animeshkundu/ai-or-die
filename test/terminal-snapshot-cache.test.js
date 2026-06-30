'use strict';

// Unit tests for the per-tab terminal snapshot cache.
// Runs in Node (mocha) using the module's CommonJS export. IndexedDB is absent
// in Node, so the cache runs MEMORY-ONLY here — which is exactly the private
// mode / IDB-unavailable fallback path we want to assert never throws.

const assert = require('assert');
const TerminalSnapshotCache = require('../src/public/terminal-snapshot-cache');

function makeTerminal() {
  const calls = [];
  return {
    cols: 80,
    calls,
    clear() { calls.push(['clear']); },
    write(d) { calls.push(['write', d]); },
  };
}

// A serialize addon stub: returns a deterministic, scrollback-tagged snapshot.
function makeSerializer() {
  return { serialize(opts) { return 'SNAP<' + (opts && opts.scrollback) + '>'; } };
}

describe('TerminalSnapshotCache', function () {
  let savedIndexedDB;
  before(function () {
    // Force memory-only: ensure no IndexedDB is visible to the module.
    savedIndexedDB = global.indexedDB;
    delete global.indexedDB;
  });
  after(function () {
    if (savedIndexedDB !== undefined) global.indexedDB = savedIndexedDB;
  });

  async function freshCache(maxLines = 500) {
    const terminal = makeTerminal();
    const cache = new TerminalSnapshotCache({ terminal, serializeAddon: makeSerializer(), maxLines });
    await cache.init();
    return { cache, terminal };
  }

  it('runs memory-only when IndexedDB is unavailable (no throw)', async function () {
    const { cache } = await freshCache();
    assert.strictEqual(cache._persistDisabled, true);
  });

  it('capture() then paintCached() reproduces the snapshot faithfully', async function () {
    const { cache, terminal } = await freshCache(500);
    cache.capture('s1');
    assert.strictEqual(cache.has('s1'), true);

    const painted = cache.paintCached('s1');
    assert.strictEqual(painted, true);
    // clear() must precede write(), and the written text is the serialized snapshot.
    assert.deepStrictEqual(terminal.calls[0], ['clear']);
    assert.deepStrictEqual(terminal.calls[1], ['write', 'SNAP<500>']);
  });

  it('passes maxLines through to serialize().scrollback', async function () {
    const { cache } = await freshCache(200);
    cache.capture('s1');
    assert.strictEqual(cache._mem.get('s1').text, 'SNAP<200>');
  });

  it('paintCached() returns false for an unknown session (caller falls back to server)', async function () {
    const { cache } = await freshCache();
    assert.strictEqual(cache.paintCached('missing'), false);
  });

  it('maxLines = 0 disables capture and paint entirely', async function () {
    const { cache, terminal } = await freshCache(500);
    cache.capture('s1');
    cache.setMaxLines(0);
    cache.capture('s2');
    assert.strictEqual(cache.has('s2'), false, 'capture must no-op when disabled');
    terminal.calls.length = 0;
    assert.strictEqual(cache.paintCached('s1'), false, 'paint must no-op when disabled');
    assert.strictEqual(terminal.calls.length, 0, 'must not touch the terminal when disabled');
  });

  it('serialize() throwing is swallowed and stores nothing', async function () {
    const terminal = makeTerminal();
    const cache = new TerminalSnapshotCache({
      terminal,
      serializeAddon: { serialize() { throw new Error('boom'); } },
      maxLines: 500,
    });
    await cache.init();
    assert.doesNotThrow(() => cache.capture('x'));
    assert.strictEqual(cache.has('x'), false);
  });

  it('an empty serialized snapshot is not stored', async function () {
    const terminal = makeTerminal();
    const cache = new TerminalSnapshotCache({
      terminal,
      serializeAddon: { serialize() { return ''; } },
      maxLines: 500,
    });
    await cache.init();
    cache.capture('x');
    assert.strictEqual(cache.has('x'), false);
  });

  it('evict() removes a session snapshot', async function () {
    const { cache } = await freshCache();
    cache.capture('s1');
    assert.strictEqual(cache.has('s1'), true);
    cache.evict('s1');
    assert.strictEqual(cache.has('s1'), false);
  });

  it('pruneOrphans() keeps live sessions and drops the rest', async function () {
    const { cache } = await freshCache();
    cache.capture('live');
    cache.capture('dead');
    cache.pruneOrphans(['live']);
    assert.strictEqual(cache.has('live'), true);
    assert.strictEqual(cache.has('dead'), false);
  });

  it('_evictLruOverBudget() drops the oldest entries first until under budget', async function () {
    const { cache } = await freshCache();
    const THREE_MB = 3 * 1024 * 1024;
    // 3 x 3MB = 9MB total > 6MB budget → the single oldest (a) is evicted to reach 6MB.
    cache._mem.set('a', { text: 'a', cols: 80, updatedAt: 1, bytes: THREE_MB });
    cache._mem.set('b', { text: 'b', cols: 80, updatedAt: 2, bytes: THREE_MB });
    cache._mem.set('c', { text: 'c', cols: 80, updatedAt: 3, bytes: THREE_MB });
    cache._evictLruOverBudget();
    assert.strictEqual(cache.has('a'), false, 'oldest evicted');
    assert.strictEqual(cache.has('b'), true);
    assert.strictEqual(cache.has('c'), true);
  });

  it('capture() enforces the memory budget even in memory-only mode (no unbounded growth)', async function () {
    const { cache } = await freshCache();
    assert.strictEqual(cache._persistDisabled, true, 'precondition: persistence is off');
    let evictCalls = 0;
    cache._evictLruOverBudget = () => { evictCalls++; };
    cache.capture('s1');
    // The persist path's eviction is skipped when disabled, so capture() itself
    // must bound _mem — otherwise private mode / IDB-blocked leaks unbounded.
    assert.ok(evictCalls >= 1, 'capture must enforce the in-memory budget');
  });

  it('capture(undefined) / paintCached(undefined) are safe no-ops', async function () {
    const { cache } = await freshCache();
    assert.doesNotThrow(() => cache.capture(undefined));
    assert.strictEqual(cache.paintCached(undefined), false);
  });
});
