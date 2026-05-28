'use strict';

/**
 * Soak runner — wires the server controller, workload manager, diagnostics
 * sampler, JSONL writer and gate evaluator together for one soak session.
 *
 * Usage from a test or CLI:
 *
 *   const result = await runSoak({
 *     durationMs: 60_000,
 *     workloads: ['noop'],
 *     gates: null,             // null = evaluate all gates
 *     sampleIntervalMs: 10_000,
 *     outputDir: '/abs/path/to/results/<utc>',
 *   });
 *
 * Result shape: see writeFinalArtifacts. Caller can decide to `process.exit(1)`
 * on result.evaluation.overall === false.
 */

const fs = require('fs');
const path = require('path');

const { startServer } = require('./server-controller');
const { DiagnosticsSampler } = require('./diagnostics-sampler');
const { GateEvaluator } = require('./gate-evaluator');
const { Rng } = require('./rng');
const JsonlWriter = require('./jsonl-writer');
const { getWorkload } = require('./workloads');

function utcLabel(d = new Date()) {
  // 20260527T140532Z
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function defaultResultsRoot() {
  return path.join(__dirname, '..', 'results');
}

async function runSoak(options = {}) {
  const {
    durationMs = 60_000,
    workloads: workloadNames = ['noop'],
    gates = null,
    sampleIntervalMs = Math.min(30_000, Math.max(1000, Math.floor(durationMs / 6))),
    outputDir = path.join(defaultResultsRoot(), utcLabel()),
    seed = 42,
    serverOpts = {},
    prTag = null,
    label = null,
    resume = false,
    thresholds = {},
    log = (msg) => process.stderr.write(`[soak] ${msg}\n`),
  } = options;

  // Sanity-check inputs early — much friendlier than a late KeyError.
  if (!Array.isArray(workloadNames) || workloadNames.length === 0) {
    throw new Error('runSoak: workloads must be a non-empty array');
  }
  for (const name of workloadNames) {
    getWorkload(name); // throws if unknown
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const samplesPath = path.join(outputDir, 'samples.jsonl');
  const eventsPath = path.join(outputDir, 'events.jsonl');
  const metadataPath = path.join(outputDir, 'metadata.json');
  const gateResultPath = path.join(outputDir, 'gate-result.json');

  // ── Resume mode ────────────────────────────────────────────────────────
  // SUP-REL's 12h-weekly-soak strategy: split into two consecutive 6h chunks
  // because GitHub-hosted runners cap a single job at 6h. The harness already
  // writes append-only JSONL, so resume just means: don't truncate, re-ingest
  // prior samples into the gate evaluator so the final verdict spans both
  // chunks, and stamp a new "chunk" entry into metadata.json instead of
  // overwriting it. Caller signals resume by passing { resume: true } with
  // `outputDir` pointing at the prior chunk's dir.
  let resumedFrom = null;
  let chunkIndex = 0;
  if (resume) {
    if (!fs.existsSync(metadataPath)) {
      throw new Error(`runSoak: --resume requires existing metadata at ${metadataPath}`);
    }
    try {
      resumedFrom = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch (err) {
      throw new Error(`runSoak: failed to parse prior metadata: ${err.message}`);
    }
    chunkIndex = (Array.isArray(resumedFrom.chunks) ? resumedFrom.chunks.length : 1);
    // Soft warning if workload set changed mid-resume; not fatal because the
    // operator may legitimately split a soak by workload-profile per chunk.
    const prevWorkloads = (resumedFrom.workloads || []).slice().sort().join(',');
    const newWorkloads = workloadNames.slice().sort().join(',');
    if (prevWorkloads !== newWorkloads) {
      log(`warning: workload set changed across resume (was [${prevWorkloads}], now [${newWorkloads}])`);
    }
  }

  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();

  // The "outer" metadata represents the full multi-chunk soak; the new chunk
  // is added at the bottom under metadata.chunks[].
  const baseMetadata = resumedFrom ? {
    ...resumedFrom,
    // Preserve original started_at; clear finished_at + per-run fields so the
    // "this run" markers don't leak from the last chunk's value.
    finished_at: null,
    sampler_stats: null,
    aborted: false,
    abort_error: null,
  } : {
    started_at: startedAtIso,
    duration_ms: durationMs,
    sample_interval_ms: sampleIntervalMs,
    workloads: workloadNames,
    gates,
    seed,
    label,
    pr: prTag,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    output_dir: outputDir,
    chunks: [],
  };
  if (!Array.isArray(baseMetadata.chunks)) baseMetadata.chunks = [];
  fs.writeFileSync(metadataPath, JSON.stringify(baseMetadata, null, 2));

  const samplesWriter = new JsonlWriter(samplesPath);
  const eventsWriter = new JsonlWriter(eventsPath);
  await samplesWriter.open();
  await eventsWriter.open();

  const evaluator = new GateEvaluator({ gates, thresholds });
  // Pre-load prior samples so end-of-run verdict spans every chunk that
  // wrote into the same outputDir.
  let priorSampleCount = 0;
  if (resume) {
    const beforeCount = evaluator._rows.length;
    await evaluator.ingestFile(samplesPath);
    priorSampleCount = evaluator._rows.length - beforeCount;
    log(`resumed from chunk ${chunkIndex - 1}: re-ingested ${priorSampleCount} prior samples`);
  }

  function logEvent(type, data) {
    const evt = { ts: new Date().toISOString(), type, chunk: chunkIndex, ...(data || {}) };
    eventsWriter.write(evt);
  }

  logEvent(resume ? 'soak_resume' : 'soak_start', {
    duration_ms: durationMs,
    workloads: workloadNames,
    prior_samples: priorSampleCount,
  });
  log(`${resume ? 'resuming' : 'starting'} soak chunk ${chunkIndex} (${durationMs}ms, workloads=${workloadNames.join(',')})`);

  let ctl;
  let sampler;
  const workloadInstances = [];
  let abnormalError = null;

  try {
    ctl = await startServer({ port: 0, serverOpts });
    log(`server up on ${ctl.baseUrl} (workDir=${ctl.workDir})`);
    logEvent('server_up', { port: ctl.port, workDir: ctl.workDir });

    sampler = new DiagnosticsSampler({
      baseUrl: ctl.baseUrl,
      intervalMs: sampleIntervalMs,
      sink: (row) => {
        samplesWriter.write(row);
        evaluator.ingest(row);
      },
    });
    sampler.start();

    const masterRng = new Rng(seed);
    for (const name of workloadNames) {
      const Ctor = getWorkload(name);
      const wl = new Ctor({ rng: masterRng.fork(name) });
      workloadInstances.push(wl);
      await wl.start({ baseUrl: ctl.baseUrl, wsUrl: ctl.wsUrl, workDir: ctl.workDir, server: ctl.server });
      logEvent('workload_start', { name });
    }

    await new Promise((resolve) => setTimeout(resolve, durationMs));

    log('soak duration elapsed; stopping workloads');
    for (const wl of workloadInstances) {
      try {
        await wl.stop();
        logEvent('workload_stop', { name: wl.name, ...wl.stats() });
      } catch (err) {
        logEvent('workload_stop_error', { name: wl.name, error: err.message });
      }
    }

    // Brief drain so the diagnostics sampler captures the post-quiesce
    // window (fs_watch returning to 0, active_requests returning to baseline).
    const drainMs = Math.min(5000, Math.floor(durationMs / 6));
    if (drainMs > 0) {
      logEvent('drain_start', { drain_ms: drainMs });
      await new Promise((resolve) => setTimeout(resolve, drainMs));
    }
  } catch (err) {
    abnormalError = err;
    log(`ABORT: ${err.stack || err.message}`);
    logEvent('soak_abort', { error: err.message, stack: err.stack });
  } finally {
    if (sampler) {
      try { await sampler.stop(); } catch (_) { /* ignore */ }
    }
    if (ctl) {
      try { await ctl.close(); } catch (_) { /* ignore */ }
    }
    await samplesWriter.close();
    // eventsWriter is closed AFTER the gate verdict is also written.
  }

  const evaluation = evaluator.evaluate();
  fs.writeFileSync(gateResultPath, JSON.stringify(evaluation, null, 2));

  const finishedAtIso = new Date().toISOString();
  const samplerStats = sampler ? sampler.stats() : { samples: 0, errors: 0 };

  // Append this chunk to metadata.chunks[]; preserve started_at from the
  // initial chunk so the soak's wall-clock start stays meaningful.
  baseMetadata.chunks.push({
    chunk_index: chunkIndex,
    started_at: startedAtIso,
    finished_at: finishedAtIso,
    duration_ms: durationMs,
    sample_interval_ms: sampleIntervalMs,
    workloads: workloadNames,
    sampler_stats: samplerStats,
    aborted: !!abnormalError,
    abort_error: abnormalError ? abnormalError.message : null,
    seed,
  });

  // Roll-up fields that callers / summarize.js read directly (without walking
  // chunks[]). For a single-chunk soak these match the only chunk.
  const totalSampleCount = baseMetadata.chunks.reduce(
    (acc, c) => acc + (c.sampler_stats && c.sampler_stats.samples || 0), 0);
  const totalErrorCount = baseMetadata.chunks.reduce(
    (acc, c) => acc + (c.sampler_stats && c.sampler_stats.errors || 0), 0);
  const totalDurationMs = baseMetadata.chunks.reduce(
    (acc, c) => acc + (c.duration_ms || 0), 0);

  const finalMetadata = {
    ...baseMetadata,
    finished_at: finishedAtIso,
    total_duration_ms: totalDurationMs,
    chunk_count: baseMetadata.chunks.length,
    aborted: !!abnormalError,
    abort_error: abnormalError ? abnormalError.message : null,
    sampler_stats: { samples: totalSampleCount, errors: totalErrorCount },
  };
  fs.writeFileSync(metadataPath, JSON.stringify(finalMetadata, null, 2));

  logEvent(resume ? 'soak_resume_end' : 'soak_end', {
    overall_pass: evaluation.overall,
    chunk_samples: samplerStats.samples,
    total_samples: totalSampleCount,
  });
  await eventsWriter.close();

  log(`soak chunk ${chunkIndex} complete: overall=${evaluation.overall} chunk_samples=${samplerStats.samples} total_samples=${totalSampleCount} dir=${outputDir}`);
  return {
    outputDir,
    metadata: finalMetadata,
    evaluation,
    samplerStats,
    aborted: !!abnormalError,
    chunkIndex,
  };
}

module.exports = {
  runSoak,
  utcLabel,
  defaultResultsRoot,
};
