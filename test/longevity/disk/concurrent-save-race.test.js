'use strict';

/**
 * DISK-01 follow-up regression test — concurrent saveSessions() rename race.
 *
 * Owner: SUP-DISK
 * Audit: docs/audits/disk-atomic-write.md (follow-up section)
 * Reporter: SUP-SOAK via `session-stringify` workload at 6 saves/min × 50 sessions
 *
 * Pre-fix symptom: two callers of `saveSessions` both writeFile to
 * `${sessionsFile}.tmp`, then both `rename` it. The first call wins;
 * the second's `rename` ENOENTs because the winner's rename removed
 * the shared tmp:
 *
 *   Failed to save sessions: ENOENT: no such file or directory,
 *     rename '<storage>/sessions.json.tmp' -> '<storage>/sessions.json'
 *
 * Fix: serialize saveSessions() calls via an instance-level promise
 * chain (`_inFlightSave`). Each call awaits the prior call's settle
 * before entering its own write critical section.
 *
 * This test fires N concurrent saves and asserts that ALL of them
 * return true (no ENOENT) and the final file is well-formed.
 */

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const SessionStore = require('../../../src/utils/session-store');

describe('DISK-01 follow-up: concurrent saveSessions race', function() {
  this.timeout(30000);

  let tempDir;

  beforeEach(async function() {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disk01b-'));
  });

  afterEach(async function() {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('serializes concurrent saves — no rename ENOENT, all callers return true', async function() {
    const store = new SessionStore({ storageDir: tempDir });
    store.sessionsFile = path.join(tempDir, 'sessions.json');

    // 50 concurrent save calls. On main HEAD (pre-fix) this produces
    // a flurry of ENOENT rename errors as the saves race on
    // `sessions.json.tmp`. Post-fix, the promise chain serializes them.
    const N = 50;
    const sessions = new Map([
      ['s1', { id: 's1', name: 'Concurrent', created: new Date() }]
    ]);

    const saves = [];
    for (let i = 0; i < N; i++) {
      store.markDirty();
      saves.push(store.saveSessions(sessions));
    }
    const results = await Promise.all(saves);

    // The dirty-flag fast-path means that after the first save flushes,
    // subsequent calls in the queue see _dirty=false and return true
    // without doing work. That's correct behavior — the file IS up to
    // date. What we are asserting: NO call rejects, NO call returns
    // false (which would indicate ENOENT or other I/O error).
    for (let i = 0; i < N; i++) {
      assert.strictEqual(
        results[i], true,
        `save #${i} returned ${results[i]} — concurrent race (likely ENOENT) regressed`
      );
    }

    // Final file must be well-formed.
    const raw = await fs.readFile(store.sessionsFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.sessions.length, 1);
    assert.strictEqual(parsed.sessions[0].name, 'Concurrent');

    // No orphan .tmp left behind.
    const tmpExists = await fs.access(store.sessionsFile + '.tmp')
      .then(() => true).catch(() => false);
    assert.strictEqual(tmpExists, false, 'no .tmp orphan should remain');
  });

  it('preserves last-write-wins semantics when state mutates between concurrent saves', async function() {
    const store = new SessionStore({ storageDir: tempDir });
    store.sessionsFile = path.join(tempDir, 'sessions.json');

    // Each save uses a DIFFERENT sessions map. Without serialization
    // these would race; with serialization, the final on-disk state
    // matches whichever save was queued last (LIFO is not guaranteed,
    // but any one of the queued snapshots must win cleanly).
    const N = 20;
    const saves = [];
    const queuedNames = [];
    for (let i = 0; i < N; i++) {
      const name = `mut-${i}`;
      queuedNames.push(name);
      const m = new Map([['s1', { id: 's1', name, created: new Date() }]]);
      store.markDirty();
      saves.push(store.saveSessions(m));
    }
    const results = await Promise.all(saves);

    for (let i = 0; i < N; i++) {
      assert.strictEqual(results[i], true, `save #${i} failed`);
    }

    const raw = await fs.readFile(store.sessionsFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.sessions.length, 1);
    // The persisted name must be ONE of the queued names — not a torn
    // or default value. Which one wins depends on whether the
    // dirty-flag fast-path absorbed later saves; that's fine.
    assert.ok(
      queuedNames.includes(parsed.sessions[0].name),
      `persisted name ${parsed.sessions[0].name} must be one of the queued saves`
    );
  });

  it('survives a slow prior save without blocking new callers indefinitely', async function() {
    const store = new SessionStore({ storageDir: tempDir });
    store.sessionsFile = path.join(tempDir, 'sessions.json');

    // Make the first save artificially slow by injecting a 200 ms
    // delay into `fs.open` for the .tmp file. The second concurrent
    // save must serialize behind it (not run while the first is
    // mid-write), then complete.
    const fsp = require('fs').promises;
    const realOpen = fsp.open;
    let delayedOnce = false;
    fsp.open = async function(p, flags, mode) {
      if (String(p).endsWith('.tmp') && !delayedOnce) {
        delayedOnce = true;
        await new Promise(r => setTimeout(r, 200));
      }
      return realOpen.call(this, p, flags, mode);
    };

    try {
      store.markDirty();
      const slow = store.saveSessions(new Map([['s1', { id: 's1', name: 'slow' }]]));
      // Queue a fast save immediately behind it.
      store.markDirty();
      const fast = store.saveSessions(new Map([['s1', { id: 's1', name: 'fast' }]]));

      const [r1, r2] = await Promise.all([slow, fast]);
      assert.strictEqual(r1, true);
      assert.strictEqual(r2, true);
    } finally {
      fsp.open = realOpen;
    }

    const parsed = JSON.parse(await fs.readFile(store.sessionsFile, 'utf8'));
    assert.strictEqual(parsed.sessions.length, 1);
  });

  it('does not leak a stuck lock if the prior save rejects unexpectedly', async function() {
    const store = new SessionStore({ storageDir: tempDir });
    store.sessionsFile = path.join(tempDir, 'sessions.json');

    // Make the first save reject hard via a synthetic error in fs.open.
    const fsp = require('fs').promises;
    const realOpen = fsp.open;
    let rejectOnce = true;
    fsp.open = async function(p, flags, mode) {
      if (String(p).endsWith('.tmp') && rejectOnce) {
        rejectOnce = false;
        const err = new Error('mock IO fail');
        err.code = 'EIO';
        throw err;
      }
      return realOpen.call(this, p, flags, mode);
    };

    try {
      store.markDirty();
      const r1 = await store.saveSessions(new Map([['s1', { id: 's1', name: 'fail' }]]));
      assert.strictEqual(r1, false, 'first save should fail with mocked EIO');

      // Subsequent call must NOT be stuck behind the rejected promise.
      store.markDirty();
      const r2 = await store.saveSessions(new Map([['s1', { id: 's1', name: 'after-fail' }]]));
      assert.strictEqual(r2, true, 'second save should succeed after first rejected');
    } finally {
      fsp.open = realOpen;
    }

    const parsed = JSON.parse(await fs.readFile(store.sessionsFile, 'utf8'));
    assert.strictEqual(parsed.sessions[0].name, 'after-fail');
  });
});
