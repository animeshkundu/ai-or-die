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

  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  const metadata = {
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
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  const samplesWriter = new JsonlWriter(samplesPath);
  const eventsWriter = new JsonlWriter(eventsPath);
  await samplesWriter.open();
  await eventsWriter.open();

  const evaluator = new GateEvaluator({ gates });

  function logEvent(type, data) {
    const evt = { ts: new Date().toISOString(), type, ...(data || {}) };
    eventsWriter.write(evt);
  }

  logEvent('soak_start', { duration_ms: durationMs, workloads: workloadNames });
  log(`starting soak (${durationMs}ms, workloads=${workloadNames.join(',')})`);

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

  const finalMetadata = {
    ...metadata,
    finished_at: finishedAtIso,
    aborted: !!abnormalError,
    abort_error: abnormalError ? abnormalError.message : null,
    sampler_stats: samplerStats,
  };
  fs.writeFileSync(metadataPath, JSON.stringify(finalMetadata, null, 2));

  logEvent('soak_end', {
    overall_pass: evaluation.overall,
    samples: samplerStats.samples,
  });
  await eventsWriter.close();

  log(`soak complete: overall=${evaluation.overall} samples=${samplerStats.samples} dir=${outputDir}`);
  return {
    outputDir,
    metadata: finalMetadata,
    evaluation,
    samplerStats,
    aborted: !!abnormalError,
  };
}

module.exports = {
  runSoak,
  utcLabel,
  defaultResultsRoot,
};
