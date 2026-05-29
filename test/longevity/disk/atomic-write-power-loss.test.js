'use strict';

/**
 * DISK-01 regression test — sessions.json atomic-write durability.
 *
 * Owner: SUP-DISK
 * Audit: docs/audits/disk-atomic-write.md
 *
 * Three guarantees this test enforces:
 *
 *   1. fsync-call ordering. The temp file fd MUST be fsync'd BEFORE
 *      `rename`. On POSIX the storage-directory fd MUST be fsync'd
 *      AFTER `rename`. On Windows the directory fsync is skipped
 *      (NTFS journal + MoveFileExW provide the equivalent guarantee
 *      and Node EPERMs on dir fsync).
 *
 *   2. Stale `${target}.tmp` orphan cleanup. A previous SIGKILL'd run
 *      leaves a `.tmp` file in the storage dir; the next successful
 *      save must clean it up.
 *
 *   3. Torn-write safety under SIGKILL. After a random number of
 *      iterations, the child process is killed mid-save. The parent
 *      asserts that `sessions.json` is either absent or fully
 *      parseable — never partial / empty / garbled. (This is
 *      guaranteed by `rename(2)` alone; the test catches future
 *      regressions to the ordering, not to fsync per se. The fsync
 *      ordering is verified by #1.)
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SessionStore = require('../../../src/utils/session-store');

describe('DISK-01: SessionStore atomic-write durability', function() {
  this.timeout(30000);

  let tempDir;

  beforeEach(async function() {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'disk01-'));
  });

  afterEach(async function() {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch (_) { /* best effort */ }
  });

  describe('fsync ordering (guarantee #1)', function() {
    it('fsyncs temp-file fd BEFORE rename', async function() {
      const store = new SessionStore({ storageDir: tempDir });
      const sessionsFile = path.join(tempDir, 'sessions.json');
      store.sessionsFile = sessionsFile;

      // Instrument fs.promises.open so each FileHandle records its
      // .sync() calls in an event log along with its target path.
      const events = [];
      const realOpen = fsp.open;
      fsp.open = async function(p, flags, mode) {
        const handle = await realOpen.call(this, p, flags, mode);
        const realSync = handle.sync.bind(handle);
        const realClose = handle.close.bind(handle);
        handle.sync = async function() {
          events.push({ op: 'sync', path: String(p) });
          return realSync();
        };
        handle.close = async function() {
          events.push({ op: 'close', path: String(p) });
          return realClose();
        };
        return handle;
      };

      // Wrap rename to record its place in the timeline.
      const realRename = fsp.rename;
      fsp.rename = async function(from, to) {
        events.push({ op: 'rename', from: String(from), to: String(to) });
        return realRename.call(this, from, to);
      };

      try {
        const sessions = new Map([
          ['s1', { id: 's1', name: 'Test', created: new Date() }]
        ]);
        store.markDirty();
        const ok = await store.saveSessions(sessions);
        assert.strictEqual(ok, true);
      } finally {
        fsp.open = realOpen;
        fsp.rename = realRename;
      }

      // Find indices of: tmp sync, rename, dir sync.
      const tmpFile = sessionsFile + '.tmp';
      const tmpSyncIdx = events.findIndex(
        e => e.op === 'sync' && e.path === tmpFile
      );
      const renameIdx = events.findIndex(
        e => e.op === 'rename' && e.from === tmpFile
      );

      assert.notStrictEqual(
        tmpSyncIdx, -1,
        `expected fsync on temp file (${tmpFile}); events=${JSON.stringify(events)}`
      );
      assert.notStrictEqual(
        renameIdx, -1,
        'expected rename of temp -> target'
      );
      assert.ok(
        tmpSyncIdx < renameIdx,
        `temp fsync must precede rename. tmpSyncIdx=${tmpSyncIdx} renameIdx=${renameIdx}`
      );

      if (process.platform !== 'win32') {
        const dirSyncIdx = events.findIndex(
          (e, i) => i > renameIdx && e.op === 'sync' && e.path === tempDir
        );
        assert.notStrictEqual(
          dirSyncIdx, -1,
          `expected fsync on storage dir (${tempDir}) AFTER rename on POSIX`
        );
        assert.ok(
          dirSyncIdx > renameIdx,
          'directory fsync must come after rename'
        );
      }
    });
  });

  describe('stale .tmp orphan cleanup (guarantee #2)', function() {
    it('cleans up a stale .tmp from a prior aborted run', async function() {
      const store = new SessionStore({ storageDir: tempDir });
      const sessionsFile = path.join(tempDir, 'sessions.json');
      store.sessionsFile = sessionsFile;

      // Simulate a SIGKILL'd prior run by hand-placing an orphan .tmp.
      const orphan = sessionsFile + '.tmp';
      await fsp.writeFile(orphan, '{"partial":', { mode: 0o600 });
      const orphanExistsBefore = fs.existsSync(orphan);
      assert.strictEqual(orphanExistsBefore, true);

      // Trigger a fresh save — the implementation must unlink the
      // orphan opportunistically (either before writing the new temp
      // or as a side effect of overwriting it cleanly).
      store.markDirty();
      const ok = await store.saveSessions(new Map([
        ['s1', { id: 's1', name: 'After Orphan', created: new Date() }]
      ]));
      assert.strictEqual(ok, true);

      // After the save: sessions.json must exist + parse cleanly, AND
      // no .tmp orphan should remain.
      const target = fs.readFileSync(sessionsFile, 'utf8');
      const parsed = JSON.parse(target);
      assert.strictEqual(parsed.sessions.length, 1);
      assert.strictEqual(
        fs.existsSync(orphan), false,
        'stale .tmp orphan must be cleaned up after a successful save'
      );
    });
  });

  describe('SIGKILL torn-write safety (guarantee #3)', function() {
    it('survives 20 random-timing SIGKILLs without corrupt target', async function() {
      // Inline a small writer script that loops saveSessions until killed.
      const writerScript = `
        'use strict';
        const path = require('path');
        const SessionStore = require(${JSON.stringify(
          path.resolve(__dirname, '../../../src/utils/session-store')
        )});

        async function main() {
          const dir = process.argv[2];
          const store = new SessionStore({ storageDir: dir });
          store.sessionsFile = path.join(dir, 'sessions.json');

          let i = 0;
          // Pre-build a non-trivial session map (~50 KB serialized)
          const sessions = new Map();
          for (let k = 0; k < 20; k++) {
            sessions.set('s' + k, {
              id: 's' + k,
              name: 'Session ' + k,
              created: new Date(),
              workingDir: '/tmp/x',
              outputBuffer: Array.from({ length: 100 }, (_, j) => 'line ' + j)
            });
          }

          while (true) {
            store.markDirty();
            await store.saveSessions(sessions);
            i++;
            if (i % 50 === 0) {
              // Mutate so each save is non-trivial.
              sessions.set('s0', { ...sessions.get('s0'), name: 'mut ' + i });
            }
          }
        }
        main().catch(e => { console.error(e); process.exit(2); });
      `;

      const writerPath = path.join(tempDir, '_writer.js');
      fs.writeFileSync(writerPath, writerScript);

      const sessionsFile = path.join(tempDir, 'sessions.json');

      for (let cycle = 0; cycle < 20; cycle++) {
        // Clean dir for this cycle.
        for (const f of fs.readdirSync(tempDir)) {
          if (f === '_writer.js') continue;
          try { fs.unlinkSync(path.join(tempDir, f)); } catch (_) {}
        }

        // Spawn writer.
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [writerPath, tempDir], {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        // SIGKILL after a random delay 10–200 ms.
        const delay = 10 + Math.floor(Math.random() * 190);
        await new Promise(r => setTimeout(r, delay));
        try { child.kill('SIGKILL'); } catch (_) {}
        // Wait for exit.
        await new Promise(r => child.once('exit', r));

        // Assert the target file is either absent or fully parseable.
        if (fs.existsSync(sessionsFile)) {
          const raw = fs.readFileSync(sessionsFile, 'utf8');
          assert.ok(raw.length > 0, `cycle ${cycle}: target exists but is empty`);
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (parseErr) {
            assert.fail(
              `cycle ${cycle}: target file is corrupt JSON after SIGKILL: ${parseErr.message}\n--- raw ---\n${raw.slice(0, 200)}\n--- end ---`
            );
          }
          assert.strictEqual(typeof parsed, 'object');
          assert.ok(Array.isArray(parsed.sessions), `cycle ${cycle}: missing sessions[]`);
          assert.ok(parsed.version, `cycle ${cycle}: missing version`);
        }
      }
    });
  });

  describe('Windows compatibility', function() {
    it('skips directory fsync on win32 (NTFS journal + MoveFileExW)', function() {
      // Static documentation test — the fix must NOT call fsync on a
      // directory fd on Windows (Node returns EPERM). Verified by
      // reading the implementation.
      const src = fs.readFileSync(
        path.resolve(__dirname, '../../../src/utils/session-store.js'),
        'utf8'
      );
      assert.ok(
        /process\.platform\s*!==\s*['"]win32['"]/.test(src) ||
        /process\.platform\s*===\s*['"]win32['"]/.test(src),
        'session-store must branch on process.platform for the directory fsync'
      );
    });
  });
});
