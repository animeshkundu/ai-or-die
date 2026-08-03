'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');

const { VSCodeTunnelManager } = require('../../../src/vscode-tunnel');
const {
  assertPersistenceRun,
  summarizePersistenceRuns,
  summarizeRuns,
} = require('../harness/memory-diagnosis');
const { descendants } = require('../harness/process-tree-sampler');

describe('memory diagnosis harness', function () {
  it('subtracts the zero-workload control and reports median/min/max bytes per operation', function () {
    const runs = [
      {
        before_ms: 0,
        after_ms: 1000,
        workload_started_ms: 100,
        workload_finished_ms: 600,
        before: { server: { process: { memory: { heapUsed: 1000 } } } },
        after: { server: { process: { memory: { heapUsed: 2100 } } } },
        control_before: { server: { process: { memory: { heapUsed: 1000 } } } },
        control_after: { server: { process: { memory: { heapUsed: 1100 } } } },
      },
      {
        before_ms: 0,
        after_ms: 1000,
        workload_started_ms: 100,
        workload_finished_ms: 600,
        before: { server: { process: { memory: { heapUsed: 1000 } } } },
        after: { server: { process: { memory: { heapUsed: 2200 } } } },
        control_before: { server: { process: { memory: { heapUsed: 1000 } } } },
        control_after: { server: { process: { memory: { heapUsed: 1100 } } } },
      },
      {
        before_ms: 0,
        after_ms: 1000,
        workload_started_ms: 100,
        workload_finished_ms: 600,
        before: { server: { process: { memory: { heapUsed: 1000 } } } },
        after: { server: { process: { memory: { heapUsed: 2300 } } } },
        control_before: { server: { process: { memory: { heapUsed: 1000 } } } },
        control_after: { server: { process: { memory: { heapUsed: 1100 } } } },
      },
    ];
    const summary = summarizeRuns('sessions', runs, 10, 10);
    assert.deepStrictEqual(summary.post_gc_heap_delta_bytes, {
      median: 1100,
      min: 1000,
      max: 1200,
    });
    assert.deepStrictEqual(summary.bytes_per_operation, {
      median: 110,
      min: 100,
      max: 120,
    });
    assert.deepStrictEqual(summary.control_delta_bytes, {
      median: 100,
      min: 100,
      max: 100,
    });
    assert.strictEqual(summary.effective_rate_per_second, 20);
  });

  it('selects only the root process and its recursive descendants', function () {
    const rows = [
      { pid: 1, ppid: 0 },
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 20, ppid: 1 },
    ];
    assert.deepStrictEqual(descendants(rows, 10).map((row) => row.pid), [10, 11, 12]);
  });

  it('compares persistence-enabled and persistence-disabled post-GC runs', function () {
    const makeRun = (afterHeap, controlAfterHeap) => ({
      before_ms: 0,
      after_ms: 1000,
      workload_started_ms: 100,
      workload_finished_ms: 600,
      before: { server: { process: { memory: { heapUsed: 1000 } } } },
      after: { server: { process: { memory: { heapUsed: afterHeap } } } },
      control_before: { server: { process: { memory: { heapUsed: 1000 } } } },
      control_after: { server: { process: { memory: { heapUsed: controlAfterHeap } } } },
    });
    const runs = [
      { enabled: makeRun(2300, 1100), disabled: makeRun(1900, 1100) },
      { enabled: makeRun(2400, 1100), disabled: makeRun(1900, 1100) },
      { enabled: makeRun(2500, 1100), disabled: makeRun(1900, 1100) },
    ];
    const summary = summarizePersistenceRuns(runs, 10, 20);
    assert.deepStrictEqual(summary.persistence_amplification_bytes, {
      median: 500,
      min: 400,
      max: 600,
    });
    assert.deepStrictEqual(summary.persistence_amplification_bytes_per_operation, {
      median: 50,
      min: 40,
      max: 60,
    });
  });

  it('requires exactly one autosave tick in each persistence process', function () {
    const run = {
      after: {
        server: {
          sessions: { total: 30 },
          persistence: { auto_save_ticks: 1, save_calls: 31 },
        },
      },
    };
    assert.doesNotThrow(() => assertPersistenceRun(run, 30, false));
    run.after.server.persistence.auto_save_ticks = 2;
    assert.throws(
      () => assertPersistenceRun(run, 30, false),
      /expected exactly one autosave tick/,
    );
    run.after.server.persistence.auto_save_ticks = 1;
    run.after.server.sessions.total = 29;
    assert.throws(
      () => assertPersistenceRun(run, 30, false),
      /retained 29\/30 sessions/,
    );
    run.after.server.sessions.total = 30;
    run.after.server.persistence.save_calls = 30;
    assert.throws(
      () => assertPersistenceRun(run, 30, false),
      /expected 31 save calls/,
    );
  });

  it('leaves the VS Code stdout ownership counter disabled by default', async function () {
    const previousDiagnosticFlag = process.env.AOD_DIAG_ENABLED;
    delete process.env.AOD_DIAG_ENABLED;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const manager = new VSCodeTunnelManager({ spawn: () => child });
    try {
      await manager._initPromise;
      manager._command = 'fake-code';
      const sessionId = 'default-off-diagnostic-counter';
      const tunnel = {
        localPort: 19191,
        connectionToken: 'token',
        sessionId,
        workingDir: process.cwd(),
        stopping: false,
      };
      manager.tunnels.set(sessionId, tunnel);
      const started = manager._spawnServer(sessionId);
      child.stdout.emit('data', Buffer.from('Web UI available at http://localhost:19191\n'));
      await started;
      assert.strictEqual(tunnel._diagnosticServerStdoutChars, undefined);
    } finally {
      if (previousDiagnosticFlag === undefined) delete process.env.AOD_DIAG_ENABLED;
      else process.env.AOD_DIAG_ENABLED = previousDiagnosticFlag;
    }
  });
});
