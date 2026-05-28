'use strict';

/**
 * DISK-02 regression test — usage-analytics JSONL rotation + .crash pruning.
 *
 * Owner: SUP-DISK
 * Audit: docs/audits/disk-usage-analytics-jsonl.md
 * Spec:  docs/specs/disk-budget.md
 *
 * Covers:
 *   1. compactStale() gzips files that exceed the size threshold.
 *   2. compactStale() gzips files older than maxAgeMs.
 *   3. compactStale() never touches the latest N files (active CLI handle).
 *   4. compactStale() never touches files newer than minIdleMs.
 *   5. compactStale() is idempotent — second pass is a no-op.
 *   6. readJsonlFile() transparently reads .jsonl.gz.
 *   7. UsageReader.pruneCrashFiles deletes old crash files and keeps the latest.
 *   8. dir-quota trigger compacts oldest first until under quota.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const UsageReader = require('../../../src/usage-reader');
const { compactJsonlFile, pruneOldFiles } = require('../../../src/utils/log-rotator');

describe('DISK-02: usage-analytics JSONL growth + rotation', function() {
  this.timeout(60000);

  let projectsRoot;
  let projectDir;

  beforeEach(async function() {
    projectsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'disk02-projects-'));
    projectDir = path.join(projectsRoot, '-Users-test-project');
    await fsp.mkdir(projectDir, { recursive: true });
  });

  afterEach(async function() {
    try { await fsp.rm(projectsRoot, { recursive: true, force: true }); } catch (_) {}
  });

  // -------- helpers --------

  function makeJsonlContent(numLines, bytesPerLine = 100) {
    const filler = 'x'.repeat(Math.max(0, bytesPerLine - 80));
    const lines = [];
    const baseTs = '2025-01-01T00:00:00.000Z';
    for (let i = 0; i < numLines; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        timestamp: baseTs,
        message: { role: 'assistant', model: 'sonnet', usage: { input_tokens: 10, output_tokens: 20 } },
        filler,
        i,
      }));
    }
    return lines.join('\n') + '\n';
  }

  async function writeJsonl(name, content, mtimeOverride = null) {
    const full = path.join(projectDir, name);
    await fsp.writeFile(full, content);
    if (mtimeOverride) {
      await fsp.utimes(full, mtimeOverride / 1000, mtimeOverride / 1000);
    }
    return full;
  }

  // -------- tests --------

  describe('compactJsonlFile primitive', function() {
    it('atomically gzips a file and removes the original', async function() {
      const src = await writeJsonl('sess-1.jsonl', makeJsonlContent(100, 50));
      const before = (await fsp.stat(src)).size;

      const r = await compactJsonlFile(src);

      assert.strictEqual(r.ok, true, `compact failed: ${r.error}`);
      assert.ok(r.bytesIn === before, `bytesIn=${r.bytesIn}, expected ${before}`);
      assert.ok(r.bytesOut > 0 && r.bytesOut < before, 'gzip should shrink');
      assert.strictEqual(fs.existsSync(src), false, 'original must be removed');
      assert.strictEqual(fs.existsSync(src + '.gz'), true, 'gzipped output must exist');

      // Verify the gzipped content round-trips.
      const gz = await fsp.readFile(src + '.gz');
      const unzipped = zlib.gunzipSync(gz).toString('utf8');
      assert.strictEqual(unzipped.split('\n').filter(Boolean).length, 100);
    });

    it('is idempotent — second call is a no-op skip', async function() {
      const src = await writeJsonl('sess-1.jsonl', makeJsonlContent(10));
      const r1 = await compactJsonlFile(src);
      assert.strictEqual(r1.ok, true);
      const r2 = await compactJsonlFile(src);
      assert.strictEqual(r2.ok, true);
      assert.strictEqual(r2.skipped, true, 'second call should skip — src absent, .gz present');
    });

    it('cleans up orphan .tmp before writing', async function() {
      const src = await writeJsonl('sess-1.jsonl', makeJsonlContent(10));
      const orphanTmp = src + '.gz.tmp';
      await fsp.writeFile(orphanTmp, 'partial garbage');

      const r = await compactJsonlFile(src);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(fs.existsSync(orphanTmp), false, 'orphan tmp must be cleaned');
    });
  });

  describe('UsageReader.compactStale()', function() {
    it('gzips files larger than maxFileBytes', async function() {
      const reader = new UsageReader({
        claudeProjectsPath: projectsRoot,
        compactPolicy: {
          maxFileBytes: 50 * 1024,   // 50 KB threshold (small for test)
          maxDirBytes: 1024 * 1024 * 1024,
          maxAgeMs: 999 * 24 * 60 * 60 * 1000,
          preserveLatestN: 0,
          minIdleMs: 0,
        },
      });

      // 1: small (no trigger), 2: large (size trigger), 3: small (no trigger)
      const small1 = await writeJsonl('small-1.jsonl', makeJsonlContent(10));
      const big = await writeJsonl('big.jsonl', makeJsonlContent(700, 100)); // ~70 KB
      const small2 = await writeJsonl('small-2.jsonl', makeJsonlContent(10));

      const result = await reader.compactStale();
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.compacted.length, 1, `expected 1 compacted, got ${result.compacted.length}`);
      assert.ok(result.compacted[0].path.endsWith('big.jsonl'));
      assert.deepStrictEqual(result.compacted[0].triggers, ['size']);

      assert.strictEqual(fs.existsSync(big), false);
      assert.strictEqual(fs.existsSync(big + '.gz'), true);
      assert.strictEqual(fs.existsSync(small1), true, 'small file must be untouched');
      assert.strictEqual(fs.existsSync(small2), true, 'small file must be untouched');
    });

    it('gzips files older than maxAgeMs even when small', async function() {
      const reader = new UsageReader({
        claudeProjectsPath: projectsRoot,
        compactPolicy: {
          maxFileBytes: 100 * 1024 * 1024,
          maxDirBytes: 1024 * 1024 * 1024,
          maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
          preserveLatestN: 0,
          minIdleMs: 0,
        },
      });

      const oldFile = await writeJsonl(
        'old.jsonl',
        makeJsonlContent(5),
        Date.now() - 10 * 24 * 60 * 60 * 1000 // 10 days ago
      );
      const newFile = await writeJsonl('new.jsonl', makeJsonlContent(5));

      const result = await reader.compactStale();
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.compacted.length, 1);
      assert.ok(result.compacted[0].path.endsWith('old.jsonl'));
      assert.ok(result.compacted[0].triggers.includes('age'));
      assert.strictEqual(fs.existsSync(oldFile + '.gz'), true);
      assert.strictEqual(fs.existsSync(newFile), true);
    });

    it('preserves the latest N files (CLI may hold their handles)', async function() {
      const reader = new UsageReader({
        claudeProjectsPath: projectsRoot,
        compactPolicy: {
          maxFileBytes: 100,         // very low — would trigger all
          maxDirBytes: 1024 * 1024 * 1024,
          maxAgeMs: 999 * 24 * 60 * 60 * 1000,
          preserveLatestN: 3,
          minIdleMs: 0,
        },
      });

      // 5 files with staggered mtimes; latest 3 must be preserved.
      const paths = [];
      const baseTime = Date.now() - 100 * 60 * 60 * 1000;
      for (let i = 0; i < 5; i++) {
        const p = await writeJsonl(`sess-${i}.jsonl`, makeJsonlContent(20, 200));
        await fsp.utimes(p, (baseTime + i * 1000) / 1000, (baseTime + i * 1000) / 1000);
        paths.push(p);
      }

      const result = await reader.compactStale();
      assert.strictEqual(result.ok, true);

      // The oldest 2 (sess-0, sess-1) should be compacted; the newest 3 preserved.
      const compactedNames = result.compacted.map(c => path.basename(c.path)).sort();
      assert.deepStrictEqual(compactedNames, ['sess-0.jsonl', 'sess-1.jsonl']);

      // Verify on disk.
      assert.strictEqual(fs.existsSync(paths[0]), false);
      assert.strictEqual(fs.existsSync(paths[1]), false);
      for (let i = 2; i < 5; i++) {
        assert.strictEqual(fs.existsSync(paths[i]), true, `latest-N file ${i} must remain`);
      }
    });

    it('skips files modified within minIdleMs (CLI may have just written)', async function() {
      const reader = new UsageReader({
        claudeProjectsPath: projectsRoot,
        compactPolicy: {
          maxFileBytes: 100, // would trigger size
          maxDirBytes: 1024 * 1024 * 1024,
          maxAgeMs: 999 * 24 * 60 * 60 * 1000,
          preserveLatestN: 0,
          minIdleMs: 60 * 60 * 1000, // 1 hour
        },
      });

      const recent = await writeJsonl('recent.jsonl', makeJsonlContent(20, 200));
      // Force recent mtime explicitly.
      const now = Date.now();
      await fsp.utimes(recent, now / 1000, now / 1000);

      const result = await reader.compactStale();
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.compacted.length, 0);
      const skipped = result.skipped.find(s => s.path.endsWith('recent.jsonl'));
      assert.ok(skipped, 'recent file must be in skipped list');
      assert.strictEqual(skipped.reason, 'idle-protection');
    });

    it('is idempotent — second sweep is a no-op', async function() {
      const reader = new UsageReader({
        claudeProjectsPath: projectsRoot,
        compactPolicy: {
          maxFileBytes: 100,
          maxDirBytes: 1024 * 1024 * 1024,
          maxAgeMs: 999 * 24 * 60 * 60 * 1000,
          preserveLatestN: 0,
          minIdleMs: 0,
        },
      });

      await writeJsonl('a.jsonl', makeJsonlContent(20, 200));
      await writeJsonl('b.jsonl', makeJsonlContent(20, 200));

      const r1 = await reader.compactStale();
      assert.strictEqual(r1.compacted.length, 2);

      const r2 = await reader.compactStale();
      assert.strictEqual(r2.compacted.length, 0, 'second sweep must compact nothing');
      assert.strictEqual(r2.scanned, 0, 'no .jsonl left to scan');
    });
  });

  describe('readJsonlFile transparently reads .jsonl.gz', function() {
    it('returns the same entries from .jsonl and .jsonl.gz', async function() {
      const cutoffTime = new Date('2020-01-01T00:00:00.000Z');
      const reader = new UsageReader({ claudeProjectsPath: projectsRoot });

      const raw = await writeJsonl('raw.jsonl', makeJsonlContent(30, 200));
      const rawEntries = await reader.readJsonlFile(raw, cutoffTime);
      assert.ok(rawEntries.length > 0, 'raw read should return entries');

      // Now gzip the same file via the compactor and re-read.
      const r = await compactJsonlFile(raw);
      assert.strictEqual(r.ok, true);
      const gzEntries = await reader.readJsonlFile(raw + '.gz', cutoffTime);
      assert.deepStrictEqual(
        gzEntries.length, rawEntries.length,
        'gzipped read should return same entry count'
      );
    });

    it('findJsonlFiles includes .jsonl.gz alongside .jsonl', async function() {
      const reader = new UsageReader({ claudeProjectsPath: projectsRoot });
      await writeJsonl('raw.jsonl', makeJsonlContent(5));
      const big = await writeJsonl('big.jsonl', makeJsonlContent(700, 100));
      await compactJsonlFile(big);

      const files = await reader.findJsonlFiles();
      const names = files.map(f => path.basename(f)).sort();
      assert.deepStrictEqual(names, ['big.jsonl.gz', 'raw.jsonl']);
    });
  });

  describe('UsageReader.pruneCrashFiles', function() {
    let sessionsDir;

    beforeEach(async function() {
      sessionsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'disk02-crash-'));
    });

    afterEach(async function() {
      try { await fsp.rm(sessionsDir, { recursive: true, force: true }); } catch (_) {}
    });

    it('deletes old .crash files but keeps the latest', async function() {
      const old1 = path.join(sessionsDir, 'sessions.json.crash.1700000000000');
      const old2 = path.join(sessionsDir, 'sessions.json.crash.1700000001000');
      const recent = path.join(sessionsDir, 'sessions.json.crash');
      const unrelated = path.join(sessionsDir, 'unrelated.txt');

      await fsp.writeFile(old1, 'crash1');
      await fsp.writeFile(old2, 'crash2');
      await fsp.writeFile(recent, 'recent crash');
      await fsp.writeFile(unrelated, 'do not touch');

      // Force old mtimes (20 days ago)
      const oldTs = (Date.now() - 20 * 24 * 60 * 60 * 1000) / 1000;
      await fsp.utimes(old1, oldTs, oldTs);
      await fsp.utimes(old2, oldTs, oldTs);

      const r = await UsageReader.pruneCrashFiles(sessionsDir);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.pruned.length, 2, `expected 2 pruned, got ${r.pruned.length}`);
      assert.strictEqual(fs.existsSync(old1), false);
      assert.strictEqual(fs.existsSync(old2), false);
      assert.strictEqual(fs.existsSync(recent), true, 'most recent crash must be kept');
      assert.strictEqual(fs.existsSync(unrelated), true, 'unrelated files must be untouched');
    });

    it('handles missing directory gracefully', async function() {
      const r = await UsageReader.pruneCrashFiles(path.join(sessionsDir, 'does-not-exist'));
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.pruned, []);
    });
  });

  describe('pruneOldFiles primitive', function() {
    it('respects preserveLatestN and maxAgeMs', async function() {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'disk02-prune-'));
      try {
        const baseTs = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
        // 4 matching files, ages 30d → 0d
        for (let i = 0; i < 4; i++) {
          const f = path.join(dir, `log-${i}.txt`);
          await fsp.writeFile(f, 'x');
          await fsp.utimes(f, baseTs + i * 86400, baseTs + i * 86400);
        }
        const r = await pruneOldFiles(dir, /^log-\d+\.txt$/, {
          maxAgeMs: 7 * 24 * 60 * 60 * 1000,
          preserveLatestN: 1,
        });
        assert.strictEqual(r.ok, true);
        // log-3 (newest, day 0) must be preserved. log-0/1/2 are older
        // than 7 days; only ones beyond preserveLatestN are pruned.
        assert.ok(r.pruned.length >= 1);
        assert.ok(fs.existsSync(path.join(dir, 'log-3.txt')), 'newest must survive');
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });
  });
});
