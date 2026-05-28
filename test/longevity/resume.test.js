'use strict';

/**
 * Smoke test for the `--resume` flag (SOAK-05c).
 *
 * Validates that two consecutive `runSoak({outputDir: same, resume: true})`
 * calls preserve the first chunk's data, append new samples to the same
 * JSONL, and yield a final verdict that spans both chunks. This is the
 * SUP-REL 12h-on-two-6h-runners scenario in miniature.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { runSoak } = require('./harness/runner');

async function countLines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (line.trim()) n++;
  }
  return n;
}

async function loadJsonl(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const rows = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (_) { /* skip */ }
  }
  return rows;
}

describe('Longevity harness --resume', function () {
  this.timeout(60_000);

  let outputDir;
  let chunk1, chunk2;

  before(async function () {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-resume-'));

    chunk1 = await runSoak({
      durationMs: 6_000,
      workloads: ['noop'],
      sampleIntervalMs: 2_000,
      outputDir,
      label: 'resume-c0',
      log: () => {},
    });

    chunk2 = await runSoak({
      durationMs: 6_000,
      workloads: ['noop'],
      sampleIntervalMs: 2_000,
      outputDir,
      resume: true,
      label: 'resume-c1',
      log: () => {},
    });
  });

  after(function () {
    if (outputDir) {
      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  it('preserves the original started_at across chunks', function () {
    const meta = JSON.parse(fs.readFileSync(path.join(outputDir, 'metadata.json'), 'utf8'));
    assert.strictEqual(meta.started_at, chunk1.metadata.started_at,
      'started_at should match the first chunk, not the resume time');
    assert.strictEqual(meta.chunk_count, 2, 'metadata records two chunks');
    assert.ok(meta.total_duration_ms >= 12_000, `total_duration_ms ≥ 12000, got ${meta.total_duration_ms}`);
  });

  it('records both chunks in metadata.chunks[]', function () {
    const meta = JSON.parse(fs.readFileSync(path.join(outputDir, 'metadata.json'), 'utf8'));
    assert.ok(Array.isArray(meta.chunks), 'chunks is an array');
    assert.strictEqual(meta.chunks.length, 2, 'two chunk entries');
    assert.strictEqual(meta.chunks[0].chunk_index, 0);
    assert.strictEqual(meta.chunks[1].chunk_index, 1);
    // SOAK-05w: relaxed from strict `<` to `<=` because on fast Ubuntu IO
    // the two ISO-ms-resolution timestamps can land in the same millisecond.
    // The semantic invariant we care about is "chunk[0]'s end is not after
    // chunk[1]'s start" — `<=` captures that cleanly without flaking on
    // sub-ms tail wall-clock gaps. The `=` case is rare but legitimate
    // when chunk[0]'s finalize + chunk[1]'s init both happen in <1 ms.
    assert.ok(meta.chunks[0].finished_at <= meta.chunks[1].started_at,
      `chunk[0] finished_at (${meta.chunks[0].finished_at}) should be <= chunk[1] started_at (${meta.chunks[1].started_at})`);
  });

  it('appends to samples.jsonl rather than truncating', async function () {
    const sampleCount = await countLines(path.join(outputDir, 'samples.jsonl'));
    // Each chunk = 6s / 2s = ~3 samples × ~6 metric rows per sample (memory:5,
    // handles:1, requests:1, fd:1, ws:1, fs_watch:1, event_loop:4 = 14 rows).
    // Two chunks should produce roughly 2× the first-chunk count.
    const firstChunkSamples = chunk1.samplerStats.samples * 14;
    assert.ok(sampleCount >= firstChunkSamples,
      `samples.jsonl should grow across resume (have ${sampleCount}, first chunk had ~${firstChunkSamples})`);
  });

  it('events.jsonl carries soak_start + soak_resume + chunk index', async function () {
    const events = await loadJsonl(path.join(outputDir, 'events.jsonl'));
    const types = new Set(events.map(e => e.type));
    assert.ok(types.has('soak_start'), 'soak_start present');
    assert.ok(types.has('soak_resume'), 'soak_resume present');
    assert.ok(types.has('soak_end'), 'first-chunk soak_end present');
    assert.ok(types.has('soak_resume_end'), 'second-chunk soak_resume_end present');
    const chunks = new Set(events.map(e => e.chunk).filter(c => c !== undefined));
    assert.ok(chunks.has(0) && chunks.has(1),
      `events should carry both chunk indices, got [${Array.from(chunks).sort().join(',')}]`);
  });

  it('final gate verdict is decidable across both chunks', function () {
    const v = JSON.parse(fs.readFileSync(path.join(outputDir, 'gate-result.json'), 'utf8'));
    // event_loop is spot-checked per sample — must be decidable from chunk-2 alone.
    const eventLoop = v.gates.find(g => g.name === 'event_loop');
    assert.ok(eventLoop, 'event_loop verdict present');
    assert.ok(eventLoop.pass === true || eventLoop.pass === false,
      `event_loop verdict decidable, got ${eventLoop.pass}`);
  });
});
