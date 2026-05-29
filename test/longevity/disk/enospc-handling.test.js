'use strict';

/**
 * DISK-03 regression test — ENOSPC handling + size cap + diagnostics.
 *
 * Owner: SUP-DISK
 * Audit: docs/audits/disk-enospc.md
 * Spec:  docs/specs/disk-budget.md §4
 *
 * Covers:
 *   1. SessionStore surfaces the ENOSPC error code via _lastSaveError.
 *   2. ENOSPC during save does NOT corrupt the prior sessions.json
 *      (DISK-01 temp+rename carries through the failure case).
 *   3. _sampleDiskUsage respects the wall-clock budget on a large corpus.
 *   4. _sampleDiskUsage returns sane fields; _buildDiagnosticsDiskBlock
 *      reports quota_used_pct correctly.
 *   5. Quota-pressure detection: when usage >= 90%, the breaker opens
 *      and a `disk_full` WS broadcast fires exactly once per transition.
 *   6. Hysteresis: breaker only closes when usage drops to < 80%.
 *   7. Linux-only: real tmpfs/loopback ENOSPC. Skipped on macOS/Windows
 *      in CI; manual repro documented in docs/specs/disk-budget.md §6.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

const SessionStore = require('../../../src/utils/session-store');

describe('DISK-03: ENOSPC + ~/.ai-or-die/ size cap', function() {
  this.timeout(30000);

  let tempDir;

  beforeEach(async function() {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'disk03-'));
  });

  afterEach(async function() {
    try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch (_) {}
  });

  describe('SessionStore ENOSPC surfacing', function() {
    it('records the ENOSPC code on _lastSaveError', async function() {
      const store = new SessionStore({ storageDir: tempDir });
      store.sessionsFile = path.join(tempDir, 'sessions.json');

      // Mock fs.promises.open to reject ENOSPC on the temp file open.
      const realOpen = fsp.open;
      fsp.open = async function(p, flags, mode) {
        if (String(p).endsWith('.tmp')) {
          const err = new Error('mock ENOSPC');
          err.code = 'ENOSPC';
          throw err;
        }
        return realOpen.call(this, p, flags, mode);
      };

      try {
        store.markDirty();
        const ok = await store.saveSessions(new Map([
          ['s1', { id: 's1', name: 'A', created: new Date() }]
        ]));
        assert.strictEqual(ok, false);
        assert.ok(store._lastSaveError, '_lastSaveError must be set');
        assert.strictEqual(store._lastSaveError.code, 'ENOSPC');
      } finally {
        fsp.open = realOpen;
      }
    });

    it('clears _lastSaveError after a successful save', async function() {
      const store = new SessionStore({ storageDir: tempDir });
      store.sessionsFile = path.join(tempDir, 'sessions.json');
      // Force an error state first.
      store._lastSaveError = new Error('stale');
      store._lastSaveError.code = 'EIO';

      store.markDirty();
      const ok = await store.saveSessions(new Map([
        ['s1', { id: 's1', name: 'OK', created: new Date() }]
      ]));
      assert.strictEqual(ok, true);
      assert.strictEqual(store._lastSaveError, null);
    });

    it('does NOT corrupt prior sessions.json on ENOSPC mid-write', async function() {
      const store = new SessionStore({ storageDir: tempDir });
      store.sessionsFile = path.join(tempDir, 'sessions.json');

      // First, do a successful save.
      store.markDirty();
      await store.saveSessions(new Map([
        ['original', { id: 'original', name: 'Good State', created: new Date() }]
      ]));
      const originalBytes = await fsp.readFile(store.sessionsFile, 'utf8');
      const originalParsed = JSON.parse(originalBytes);
      assert.strictEqual(originalParsed.sessions[0].name, 'Good State');

      // Now mock ENOSPC on the next save.
      const realOpen = fsp.open;
      fsp.open = async function(p, flags, mode) {
        if (String(p).endsWith('.tmp')) {
          const err = new Error('mock ENOSPC');
          err.code = 'ENOSPC';
          throw err;
        }
        return realOpen.call(this, p, flags, mode);
      };

      try {
        store.markDirty();
        const ok = await store.saveSessions(new Map([
          ['attempted', { id: 'attempted', name: 'Would Corrupt', created: new Date() }]
        ]));
        assert.strictEqual(ok, false);
      } finally {
        fsp.open = realOpen;
      }

      // The original sessions.json must be intact — not overwritten,
      // not torn, not empty.
      const afterBytes = await fsp.readFile(store.sessionsFile, 'utf8');
      assert.strictEqual(afterBytes, originalBytes,
        'failed save must not modify the prior sessions.json');
      const afterParsed = JSON.parse(afterBytes);
      assert.strictEqual(afterParsed.sessions[0].name, 'Good State',
        'prior session state must be preserved');
    });
  });

  describe('_sampleDiskUsage + _buildDiagnosticsDiskBlock', function() {
    // Lightweight stub of the relevant server slice. Easier to test
    // without bringing up the full WebSocket / Express stack.
    function makeServerStub(sessionsDir, projectsDir, quotaMb = 1024) {
      const { ClaudeCodeWebServer } = require('../../../src/server');
      const proto = ClaudeCodeWebServer.prototype;
      const stub = {
        _diskQuotaMb: quotaMb,
        _diskFull: false,
        _diskFullSince: null,
        _diskUsageCache: null,
        _diskUsageCacheAt: 0,
        sessionStore: { storageDir: sessionsDir },
        usageReader: { claudeProjectsPath: projectsDir },
        webSocketConnections: new Map(),
        _broadcastDiskFullCalls: [],
        _broadcastDiskFull(detail) {
          this._broadcastDiskFullCalls.push(detail);
        },
        _enterDiskFull: proto._enterDiskFull,
        _maybeExitDiskFull: proto._maybeExitDiskFull,
        _diskUsagePercentOfQuota: proto._diskUsagePercentOfQuota,
        _sampleDiskUsage: proto._sampleDiskUsage,
        _dirSizeWithBudget: proto._dirSizeWithBudget,
        _buildDiagnosticsDiskBlock: proto._buildDiagnosticsDiskBlock,
      };
      return stub;
    }

    it('reports ai_or_die_dir_bytes and claude_projects_bytes', async function() {
      const sessionsDir = path.join(tempDir, 'sessions');
      const projectsDir = path.join(tempDir, 'projects');
      await fsp.mkdir(sessionsDir);
      await fsp.mkdir(projectsDir);
      await fsp.writeFile(path.join(sessionsDir, 'sessions.json'), 'x'.repeat(5000));
      await fsp.mkdir(path.join(projectsDir, 'p1'));
      await fsp.writeFile(path.join(projectsDir, 'p1', 'log.jsonl'), 'y'.repeat(7000));

      const stub = makeServerStub(sessionsDir, projectsDir);
      const sample = await stub._sampleDiskUsage(500);

      assert.strictEqual(sample.ai_or_die_dir_bytes, 5000);
      assert.strictEqual(sample.ai_or_die_dir_files, 1);
      assert.strictEqual(sample.claude_projects_bytes, 7000);
      assert.strictEqual(sample.claude_projects_files, 1);
      assert.ok(sample.sampled_at, 'must include sampled_at');

      const block = stub._buildDiagnosticsDiskBlock();
      assert.strictEqual(block.quota_total_mb, 1024);
      assert.ok(typeof block.quota_used_pct === 'number');
      assert.strictEqual(block.circuit_breaker_open, false);
    });

    it('caches results for 60 s (second call within window is identical)', async function() {
      const sessionsDir = path.join(tempDir, 'sessions');
      await fsp.mkdir(sessionsDir);
      await fsp.writeFile(path.join(sessionsDir, 'sessions.json'), 'x'.repeat(100));

      const stub = makeServerStub(sessionsDir, sessionsDir);
      const s1 = await stub._sampleDiskUsage(500);
      // Append more bytes; cached call should NOT pick them up.
      await fsp.appendFile(path.join(sessionsDir, 'sessions.json'), 'y'.repeat(5000));
      const s2 = await stub._sampleDiskUsage(500);
      assert.strictEqual(s1, s2, 'cached sample identity should match');
    });

    it('respects the wall-clock budget on a large corpus', async function() {
      const sessionsDir = path.join(tempDir, 'sessions');
      await fsp.mkdir(sessionsDir);
      // Build a synthetic 500-file dir.
      for (let i = 0; i < 500; i++) {
        await fsp.writeFile(path.join(sessionsDir, `f${i}.txt`), 'x'.repeat(200));
      }

      const stub = makeServerStub(sessionsDir, sessionsDir);
      const start = Date.now();
      const sample = await stub._sampleDiskUsage(50); // 50 ms budget
      const elapsed = Date.now() - start;

      // Budget is per-directory; for two directories it's up to 100 ms;
      // plus a small overhead for await scheduling. Assert < 500 ms hard ceiling.
      assert.ok(elapsed < 500, `sample took ${elapsed} ms, expected < 500 ms`);
      // If the budget was hit, the sample reports stale=true.
      // Either way, ai_or_die_dir_bytes must be defined (possibly partial).
      assert.ok(typeof sample.ai_or_die_dir_bytes === 'number',
        'sample must report bytes field even on timeout');
    });
  });

  describe('Circuit-breaker state transitions', function() {
    function makeServerStub(sessionsDir, projectsDir, quotaMb) {
      const { ClaudeCodeWebServer } = require('../../../src/server');
      const proto = ClaudeCodeWebServer.prototype;
      const calls = [];
      return {
        _diskQuotaMb: quotaMb,
        _diskFull: false,
        _diskFullSince: null,
        _diskUsageCache: null,
        _diskUsageCacheAt: 0,
        sessionStore: { storageDir: sessionsDir },
        usageReader: { claudeProjectsPath: projectsDir },
        webSocketConnections: new Map(),
        _broadcastDiskFullCalls: calls,
        _broadcastDiskFull(detail) { calls.push(detail); },
        _enterDiskFull: proto._enterDiskFull,
        _maybeExitDiskFull: proto._maybeExitDiskFull,
        _diskUsagePercentOfQuota: proto._diskUsagePercentOfQuota,
        _sampleDiskUsage: proto._sampleDiskUsage,
        _dirSizeWithBudget: proto._dirSizeWithBudget,
      };
    }

    it('opens at >= 90% of quota and fires the broadcast exactly once', async function() {
      const sessionsDir = path.join(tempDir, 'sessions');
      await fsp.mkdir(sessionsDir);
      // Quota = 1 MB so we can fill it predictably. Write 950 KB → 92.7%.
      await fsp.writeFile(path.join(sessionsDir, 'big.bin'), Buffer.alloc(950 * 1024));

      const stub = makeServerStub(sessionsDir, sessionsDir, 1);
      await stub._sampleDiskUsage(500);

      assert.strictEqual(stub._diskFull, true);
      assert.strictEqual(stub._broadcastDiskFullCalls.length, 1);
      assert.strictEqual(stub._broadcastDiskFullCalls[0].source, 'quota');

      // Second sample at the same fullness must NOT re-broadcast.
      stub._diskUsageCacheAt = 0; // bust cache
      await stub._sampleDiskUsage(500);
      assert.strictEqual(stub._broadcastDiskFullCalls.length, 1,
        'no re-broadcast while in the same state');
    });

    it('closes when usage drops below 80% (hysteresis)', async function() {
      const sessionsDir = path.join(tempDir, 'sessions');
      await fsp.mkdir(sessionsDir);
      // Quota = 1 MB. Start at 92% to open.
      const bigFile = path.join(sessionsDir, 'big.bin');
      await fsp.writeFile(bigFile, Buffer.alloc(950 * 1024));

      const stub = makeServerStub(sessionsDir, sessionsDir, 1);
      await stub._sampleDiskUsage(500);
      assert.strictEqual(stub._diskFull, true);

      // Drop to 81% — still above hysteresis floor, breaker stays open.
      await fsp.writeFile(bigFile, Buffer.alloc(820 * 1024));
      stub._diskUsageCacheAt = 0;
      await stub._sampleDiskUsage(500);
      assert.strictEqual(stub._diskFull, true, 'must stay open above 80%');

      // Drop to 70% — below hysteresis floor, breaker closes.
      await fsp.writeFile(bigFile, Buffer.alloc(700 * 1024));
      stub._diskUsageCacheAt = 0;
      await stub._sampleDiskUsage(500);
      assert.strictEqual(stub._diskFull, false, 'must close below 80%');
    });
  });

  describe('Linux real-ENOSPC repro (tmpfs)', function() {
    // Skip on non-Linux. Manual repro documented in docs/specs/disk-budget.md §6.
    before(function() {
      if (process.platform !== 'linux') {
        this.skip();
      }
      // Even on Linux, we cannot mount tmpfs in CI without privileges.
      // The harness here is a placeholder for a future tooling job that
      // owns the loopback; for now we just skip.
      this.skip();
    });

    it('emits disk_full on real ENOSPC, prior file preserved', async function() {
      // TODO: implement when loopback harness exists.
      assert.ok(true);
    });
  });
});
