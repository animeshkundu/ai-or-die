'use strict';

/**
 * Longevity-harness smoke test (SOAK-01 gate).
 *
 * Runs a 10-second soak with the noop workload at a 2-second sample
 * interval and asserts the artifacts that downstream tooling (SUP-REL,
 * per-PR re-runs) depends on:
 *   - samples.jsonl is non-empty and parseable
 *   - metadata.json carries finished_at + sampler_stats
 *   - gate-result.json verdict is decidable for at least one gate
 *
 * This is the cheap gate the campaign runs on every commit; it catches
 * scaffolding regressions before a SUP-* supervisor pings SUP-SOAK with a
 * broken --gates= request.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { runSoak } = require('./harness/runner');

describe('Longevity harness smoke', function () {
  this.timeout(60_000);

  let outputDir;

  before(async function () {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-smoke-'));
    await runSoak({
      durationMs: 8_000,
      workloads: ['noop'],
      sampleIntervalMs: 2_000,
      outputDir,
      label: 'smoke',
      log: () => {},
    });
  });

  after(function () {
    if (outputDir) {
      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  it('writes metadata.json with finished_at and sampler_stats', function () {
    const meta = JSON.parse(fs.readFileSync(path.join(outputDir, 'metadata.json'), 'utf8'));
    assert.ok(meta.started_at, 'started_at present');
    assert.ok(meta.finished_at, 'finished_at present');
    assert.ok(meta.sampler_stats, 'sampler_stats present');
    assert.ok(meta.sampler_stats.samples >= 2, `expected ≥2 samples, got ${meta.sampler_stats.samples}`);
  });

  it('writes samples.jsonl with the documented {ts, gate, metric, value, threshold, pass} schema', async function () {
    const samplesPath = path.join(outputDir, 'samples.jsonl');
    assert.ok(fs.existsSync(samplesPath), 'samples.jsonl exists');
    const rl = readline.createInterface({ input: fs.createReadStream(samplesPath), crlfDelay: Infinity });
    let count = 0;
    const seenGates = new Set();
    for await (const line of rl) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      assert.strictEqual(typeof row.ts, 'string', 'ts is a string');
      assert.strictEqual(typeof row.gate, 'string', 'gate is a string');
      assert.strictEqual(typeof row.metric, 'string', 'metric is a string');
      assert.ok('value' in row, 'value present');
      assert.ok('threshold' in row, 'threshold present');
      assert.ok('pass' in row, 'pass present');
      seenGates.add(row.gate);
      count++;
    }
    assert.ok(count > 0, 'at least one sample row');
    // Default registry: memory, handles, requests, fd, ws, fs_watch, event_loop
    for (const expected of ['memory', 'handles', 'requests', 'ws', 'fs_watch', 'event_loop']) {
      assert.ok(seenGates.has(expected), `expected gate ${expected} in sample stream`);
    }
  });

  it('writes gate-result.json with at least one decidable gate', function () {
    const v = JSON.parse(fs.readFileSync(path.join(outputDir, 'gate-result.json'), 'utf8'));
    assert.ok(Array.isArray(v.gates), 'gates is an array');
    assert.ok(v.gate_count >= 1, 'at least one gate evaluated');
    // event_loop is always spot-checkable from a single sample.
    const eventLoop = v.gates.find(g => g.name === 'event_loop');
    assert.ok(eventLoop, 'event_loop gate present');
    assert.ok(eventLoop.pass === true || eventLoop.pass === false,
      `event_loop verdict should be decidable, got ${eventLoop.pass}`);
  });

  it('writes events.jsonl with soak_start and soak_end markers', async function () {
    const eventsPath = path.join(outputDir, 'events.jsonl');
    assert.ok(fs.existsSync(eventsPath), 'events.jsonl exists');
    const rl = readline.createInterface({ input: fs.createReadStream(eventsPath), crlfDelay: Infinity });
    const types = new Set();
    for await (const line of rl) {
      if (!line.trim()) continue;
      types.add(JSON.parse(line).type);
    }
    assert.ok(types.has('soak_start'), 'soak_start emitted');
    assert.ok(types.has('soak_end'), 'soak_end emitted');
    assert.ok(types.has('workload_start'), 'workload_start emitted');
    assert.ok(types.has('workload_stop'), 'workload_stop emitted');
  });
});
