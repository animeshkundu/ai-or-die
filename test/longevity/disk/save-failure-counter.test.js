'use strict';

/**
 * DISK-04b regression test — _saveFailureCount counter behavior.
 *
 * Owner: SUP-DISK
 * Requested-by: SUP-SOAK (gate landed as SOAK-05h:
 *   `disk.save_failure_count` watches non-zero delta across soak window)
 *
 * The counter is a drift-watcher for production save-failure regressions
 * that don't manifest as on-disk corruption — primarily:
 *   - the DISK-04 rename race (file ends up complete, but losing caller
 *     returns false), which the existing `disk.atomic_write_ok` gate
 *     wouldn't catch
 *   - ENOSPC / EBUSY / EACCES / EIO from any I/O failure path
 *   - future concurrency patterns from new save callers
 *
 * Decoupled from stderr / log-line format so the gate is robust to
 * console.error rewording.
 */

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const SessionStore = require('../../../src/utils/session-store');

describe('DISK-04b: SessionStore._saveFailureCount counter', function() {
  this.timeout(15000);

  let tempDir;

  beforeEach(async function() {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disk04b-'));
  });

  afterEach(async function() {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('initializes to 0 on a fresh SessionStore', function() {
    const store = new SessionStore({ storageDir: tempDir });
    assert.strictEqual(store._saveFailureCount, 0);
  });

  it('stays at 0 across successful saves', async function() {
    const store = new SessionStore({ storageDir: tempDir });
    store.sessionsFile = path.join(tempDir, 'sessions.json');

    for (let i = 0; i < 5; i++) {
      store.markDirty();
      const ok = await store.saveSessions(new Map([
        ['s1', { id: 's1', name: `iter-${i}`, created: new Date() }]
      ]));
      assert.strictEqual(ok, true);
    }
    assert.strictEqual(store._saveFailureCount, 0);
  });

  it('increments by exactly 1 per failed save', async function() {
    const store = new SessionStore({ storageDir: tempDir });
    store.sessionsFile = path.join(tempDir, 'sessions.json');

    // Mock fs.promises.open to reject the temp-file open with EIO.
    const fsp = require('fs').promises;
    const realOpen = fsp.open;
    let failCount = 0;
    fsp.open = async function(p, flags, mode) {
      if (String(p).endsWith('.tmp')) {
        failCount++;
        const err = new Error('mock EIO');
        err.code = 'EIO';
        throw err;
      }
      return realOpen.call(this, p, flags, mode);
    };

    try {
      for (let i = 0; i < 3; i++) {
        store.markDirty();
        const ok = await store.saveSessions(new Map([
          ['s1', { id: 's1', name: 'x', created: new Date() }]
        ]));
        assert.strictEqual(ok, false);
      }
    } finally {
      fsp.open = realOpen;
    }

    assert.strictEqual(store._saveFailureCount, 3,
      `expected 3 failures counted, got ${store._saveFailureCount}`);
  });

  it('does NOT increment on the dirty-flag fast-path (queued saves that see _dirty=false)', async function() {
    const store = new SessionStore({ storageDir: tempDir });
    store.sessionsFile = path.join(tempDir, 'sessions.json');

    // Fire 10 concurrent saves; the _inFlightSave chain serializes
    // them, and the dirty-flag fast-path means most return true
    // without doing work. NONE should increment the failure counter.
    const sessions = new Map([
      ['s1', { id: 's1', name: 'concurrent', created: new Date() }]
    ]);
    const saves = [];
    for (let i = 0; i < 10; i++) {
      store.markDirty();
      saves.push(store.saveSessions(sessions));
    }
    const results = await Promise.all(saves);
    for (const r of results) assert.strictEqual(r, true);

    assert.strictEqual(store._saveFailureCount, 0,
      'fast-path returns must not count as failures');
  });

  it('does not reset on subsequent successful save (monotonic)', async function() {
    const store = new SessionStore({ storageDir: tempDir });
    store.sessionsFile = path.join(tempDir, 'sessions.json');

    // First: cause a failure to bump the counter.
    const fsp = require('fs').promises;
    const realOpen = fsp.open;
    let rejectOnce = true;
    fsp.open = async function(p, flags, mode) {
      if (String(p).endsWith('.tmp') && rejectOnce) {
        rejectOnce = false;
        const err = new Error('mock EIO once');
        err.code = 'EIO';
        throw err;
      }
      return realOpen.call(this, p, flags, mode);
    };

    try {
      store.markDirty();
      const r1 = await store.saveSessions(new Map([['s1', { id: 's1', name: 'fail' }]]));
      assert.strictEqual(r1, false);
      assert.strictEqual(store._saveFailureCount, 1);

      // Now a successful save — counter must STAY at 1 (monotonic).
      store.markDirty();
      const r2 = await store.saveSessions(new Map([['s1', { id: 's1', name: 'after' }]]));
      assert.strictEqual(r2, true);
      assert.strictEqual(store._saveFailureCount, 1,
        'counter must not reset on success — it is monotonic');
    } finally {
      fsp.open = realOpen;
    }
  });
});
