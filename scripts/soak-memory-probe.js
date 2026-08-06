#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const v8 = require('v8');
const { performance } = require('perf_hooks');

const ARMS = new Set(['persist-on', 'persist-off', 'serialization', 'deletion']);
const DEFAULT_OUTPUT_ROOT = path.join(
  __dirname,
  '..',
  'test',
  'longevity',
  'results',
  'session-memory'
);

function usage() {
  return [
    'Usage: node --expose-gc scripts/soak-memory-probe.js [options]',
    '',
    '  --arm <persist-on|persist-off|serialization|deletion>',
    '  --duration-seconds <n>  Active creation duration (default: 480)',
    '  --session-rate <n>      Sessions created per active second (default: 59)',
    '  --sample-seconds <n>     Quiescent GC sample cadence (default: 30)',
    '  --payload-bytes <n>      Unique bytes per session name (default: 12500 for serialization, otherwise 1024)',
    '  --session-count <n>      Fixed population for serialization (default: 17900)',
    '  --save-cycles <n>        Full saves in serialization arm (default: 4)',
    '  --gc-passes <n>          Forced full-GC passes per sample (default: 4)',
    '  --batch-size <n>         HTTP concurrency for fixed populations (default: 128)',
    '  --repetition <n>         Repetition number recorded in metadata (default: 1)',
    '  --seed <n>               Deterministic payload seed (default: 20260805)',
    '  --output-dir <path>      Artifact directory (default: generated under test/longevity/results)',
  ].join('\n');
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    arm: null,
    durationSeconds: 480,
    sessionRate: 59,
    sampleSeconds: 30,
    payloadBytes: null,
    sessionCount: 17900,
    saveCycles: 4,
    gcPasses: 4,
    batchSize: 128,
    repetition: 1,
    seed: 20260805,
    outputDir: null,
    help: false,
  };
  const flags = {
    '--arm': ['arm', String],
    '--duration-seconds': ['durationSeconds', parsePositiveInteger],
    '--session-rate': ['sessionRate', parsePositiveInteger],
    '--sample-seconds': ['sampleSeconds', parsePositiveInteger],
    '--payload-bytes': ['payloadBytes', parsePositiveInteger],
    '--session-count': ['sessionCount', parsePositiveInteger],
    '--save-cycles': ['saveCycles', parsePositiveInteger],
    '--gc-passes': ['gcPasses', parsePositiveInteger],
    '--batch-size': ['batchSize', parsePositiveInteger],
    '--repetition': ['repetition', parsePositiveInteger],
    '--seed': ['seed', parsePositiveInteger],
    '--output-dir': ['outputDir', String],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const definition = flags[arg];
    if (!definition) throw new Error(`Unknown argument: ${arg}`);
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
    const raw = argv[++i];
    const [key, parser] = definition;
    options[key] = parser === parsePositiveInteger
      ? parser(raw, arg)
      : parser(raw);
  }

  if (options.payloadBytes == null) {
    options.payloadBytes = options.arm === 'serialization' ? 12500 : 1024;
  }

  if (!options.help) {
    if (!ARMS.has(options.arm)) {
      throw new Error('--arm must be one of: persist-on, persist-off, serialization, deletion');
    }
    if (options.payloadBytes < 32) {
      throw new Error('--payload-bytes must be at least 32 so the unique prefix is retained');
    }
    if (options.sampleSeconds > options.durationSeconds && options.arm !== 'serialization') {
      throw new Error('--sample-seconds cannot exceed --duration-seconds');
    }
  }
  return options;
}

function linearRegression(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('linearRegression requires at least two points');
  }
  const n = points.length;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    numerator += dx * (point.y - meanY);
    denominator += dx * dx;
  }
  if (denominator === 0) throw new Error('linearRegression requires varying x values');
  const slope = numerator / denominator;
  const intercept = meanY - slope * meanX;
  let residualSquares = 0;
  let totalSquares = 0;
  for (const point of points) {
    const predicted = intercept + slope * point.x;
    residualSquares += (point.y - predicted) ** 2;
    totalSquares += (point.y - meanY) ** 2;
  }
  const r2 = totalSquares === 0 ? 1 : 1 - residualSquares / totalSquares;
  return { slope, intercept, r2, n };
}

function standardDeviation(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    / (values.length - 1);
  return Math.sqrt(variance);
}

function summarize(values) {
  if (!values.length) return { n: 0, mean: null, sd: null, min: null, max: null };
  return {
    n: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    sd: standardDeviation(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function makeUniquePayload(index, byteLength, seed) {
  const prefix = `probe-${seed}-${index}-`;
  assert(prefix.length < byteLength, 'payload byte length must leave room after its unique prefix');
  const bytes = Buffer.allocUnsafe(byteLength);
  bytes.write(prefix, 0, 'ascii');
  let state = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  for (let i = prefix.length; i < bytes.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = 97 + ((state >>> 0) % 26);
  }
  return bytes.toString('ascii');
}

function assertUniquePayloads(count, byteLength, seed) {
  const hashes = new Set();
  for (let i = 0; i < count; i++) {
    const payload = makeUniquePayload(i, byteLength, seed);
    assert.strictEqual(Buffer.byteLength(payload), byteLength);
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    assert(!hashes.has(digest), `payload collision at session ${i}`);
    hashes.add(digest);
  }
  return hashes.size;
}

function createSampleRecord(input) {
  const required = [
    'arm',
    'phase',
    'repetition',
    'elapsedSeconds',
    'postGcHeapUsedBytes',
    'rssBytes',
    'sessionsTotal',
    'sessionsJsonBytes',
    'instrumentation',
  ];
  for (const key of required) {
    if (!(key in input)) throw new Error(`sample is missing ${key}`);
  }
  return {
    timestamp: new Date().toISOString(),
    arm: input.arm,
    phase: input.phase,
    repetition: input.repetition,
    elapsed_seconds: input.elapsedSeconds,
    post_gc_heap_used_bytes: input.postGcHeapUsedBytes,
    rss_bytes: input.rssBytes,
    sessions_total: input.sessionsTotal,
    sessions_json_bytes: input.sessionsJsonBytes,
    stringify_duration_ms: input.instrumentation.stringifyDurationMs,
    write_duration_ms: input.instrumentation.writeDurationMs,
    save_queue_depth: input.instrumentation.saveQueueDepth,
    save_queue_depth_peak: input.instrumentation.saveQueueDepthPeak,
    write_overlap_count: input.instrumentation.writeOverlapCount,
    stringify_phase_peak_heap_used_bytes: input.instrumentation.stringifyPeakHeapUsedBytes,
    write_phase_peak_heap_used_bytes: input.instrumentation.writePeakHeapUsedBytes,
  };
}

class SessionStoreInstrumentation {
  constructor(store, options = {}) {
    this.store = store;
    this.persistenceEnabled = options.persistenceEnabled !== false;
    this.phaseSampleMs = options.phaseSampleMs || 5;
    this._pendingSaveCallers = 0;
    this._queueDepthPeak = 0;
    this._intervalQueueDepthPeak = 0;
    this._activeWrites = 0;
    this._writeOverlapCount = 0;
    this._intervalWriteOverlapCount = 0;
    this._phaseEvents = [];
    this._phaseCursor = 0;
    this._installed = false;
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    const store = this.store;
    this._originalSaveSessions = store.saveSessions.bind(store);
    this._originalSerialize = store._serializeDataStreamed.bind(store);
    this._originalOpen = fs.promises.open;

    store.saveSessions = async (sessions) => {
      this._pendingSaveCallers++;
      const queueDepth = Math.max(0, this._pendingSaveCallers - 1);
      this._queueDepthPeak = Math.max(this._queueDepthPeak, queueDepth);
      this._intervalQueueDepthPeak = Math.max(this._intervalQueueDepthPeak, queueDepth);
      try {
        if (!this.persistenceEnabled) {
          store._dirty = false;
          return true;
        }
        return await this._originalSaveSessions(sessions);
      } finally {
        this._pendingSaveCallers--;
      }
    };

    store._serializeDataStreamed = async (data) => {
      const phase = this._beginPhase('stringify');
      try {
        return await this._originalSerialize(data);
      } finally {
        this._finishPhase(phase);
      }
    };

    const targetTempFile = path.resolve(`${store.sessionsFile}.tmp`);
    fs.promises.open = async (...args) => {
      const handle = await this._originalOpen.apply(fs.promises, args);
      const openedPath = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
      if (openedPath !== targetTempFile) return handle;
      let writePhase = null;
      return new Proxy(handle, {
        get: (target, property) => {
          if (property === 'writeFile') {
            return async (...writeArgs) => {
              if (!writePhase) {
                if (this._activeWrites > 0) {
                  this._writeOverlapCount++;
                  this._intervalWriteOverlapCount++;
                }
                this._activeWrites++;
                writePhase = this._beginPhase('write');
              }
              try {
                return await target.writeFile(...writeArgs);
              } catch (error) {
                this._finishWritePhase(writePhase);
                writePhase = null;
                throw error;
              }
            };
          }
          if (property === 'sync') {
            return async (...syncArgs) => {
              try {
                return await target.sync(...syncArgs);
              } finally {
                if (writePhase) {
                  this._finishWritePhase(writePhase);
                  writePhase = null;
                }
              }
            };
          }
          if (property === 'close') {
            return async (...closeArgs) => {
              if (writePhase) {
                this._finishWritePhase(writePhase);
                writePhase = null;
              }
              return target.close(...closeArgs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
  }

  setPersistenceEnabled(enabled) {
    this.persistenceEnabled = !!enabled;
    if (!enabled) this.store._dirty = false;
  }

  _beginPhase(name) {
    const phase = {
      name,
      startedAt: performance.now(),
      peakHeapUsedBytes: process.memoryUsage().heapUsed,
      timer: null,
    };
    phase.timer = setInterval(() => {
      phase.peakHeapUsedBytes = Math.max(
        phase.peakHeapUsedBytes,
        process.memoryUsage().heapUsed
      );
    }, this.phaseSampleMs);
    if (phase.timer.unref) phase.timer.unref();
    return phase;
  }

  _finishWritePhase(phase) {
    this._activeWrites--;
    this._finishPhase(phase);
  }

  _finishPhase(phase) {
    clearInterval(phase.timer);
    phase.peakHeapUsedBytes = Math.max(
      phase.peakHeapUsedBytes,
      process.memoryUsage().heapUsed
    );
    this._phaseEvents.push({
      phase: phase.name,
      durationMs: performance.now() - phase.startedAt,
      peakHeapUsedBytes: phase.peakHeapUsedBytes,
    });
  }

  async quiesce() {
    while (true) {
      const pending = this.store._inFlightSave;
      await pending.catch(() => {});
      await new Promise((resolve) => setImmediate(resolve));
      if (pending === this.store._inFlightSave && this._pendingSaveCallers === 0) return;
    }
  }

  takeInterval() {
    const events = this._phaseEvents.slice(this._phaseCursor);
    this._phaseCursor = this._phaseEvents.length;
    const stringify = events.filter((event) => event.phase === 'stringify');
    const writes = events.filter((event) => event.phase === 'write');
    const latestStringify = stringify.at(-1);
    const latestWrite = writes.at(-1);
    const result = {
      stringifyDurationMs: latestStringify ? latestStringify.durationMs : null,
      writeDurationMs: latestWrite ? latestWrite.durationMs : null,
      saveQueueDepth: Math.max(0, this._pendingSaveCallers - 1),
      saveQueueDepthPeak: this._intervalQueueDepthPeak,
      writeOverlapCount: this._intervalWriteOverlapCount,
      stringifyPeakHeapUsedBytes: stringify.length
        ? Math.max(...stringify.map((event) => event.peakHeapUsedBytes)) : null,
      writePeakHeapUsedBytes: writes.length
        ? Math.max(...writes.map((event) => event.peakHeapUsedBytes)) : null,
    };
    this._intervalQueueDepthPeak = Math.max(0, this._pendingSaveCallers - 1);
    this._intervalWriteOverlapCount = 0;
    return result;
  }

  summary() {
    const stringify = this._phaseEvents.filter((event) => event.phase === 'stringify');
    const writes = this._phaseEvents.filter((event) => event.phase === 'write');
    return {
      save_queue_depth_peak: this._queueDepthPeak,
      write_overlap_count: this._writeOverlapCount,
      stringify_duration_ms: summarize(stringify.map((event) => event.durationMs)),
      write_duration_ms: summarize(writes.map((event) => event.durationMs)),
      stringify_phase_peak_heap_used_bytes: stringify.length
        ? Math.max(...stringify.map((event) => event.peakHeapUsedBytes)) : null,
      write_phase_peak_heap_used_bytes: writes.length
        ? Math.max(...writes.map((event) => event.peakHeapUsedBytes)) : null,
    };
  }

  restore() {
    if (!this._installed) return;
    this.store.saveSessions = this._originalSaveSessions;
    this.store._serializeDataStreamed = this._originalSerialize;
    fs.promises.open = this._originalOpen;
    this._installed = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function forceFullGc(passes) {
  for (let i = 0; i < passes; i++) {
    global.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fileSizeOrZero(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

function requestJson(agent, method, url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body == null ? null : JSON.stringify(body);
    const request = http.request({
      agent,
      method,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: payload == null ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsedBody = raw;
        try { parsedBody = JSON.parse(raw); } catch (_) {}
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${method} ${parsed.pathname} returned ${response.statusCode}: ${raw}`));
          return;
        }
        resolve(parsedBody);
      });
    });
    request.on('error', reject);
    request.setTimeout(30_000, () => request.destroy(new Error(`${method} ${parsed.pathname} timed out`)));
    if (payload != null) request.write(payload);
    request.end();
  });
}

async function createSessions(context, count, startIndex) {
  const createdIds = [];
  for (let offset = 0; offset < count; offset += context.options.batchSize) {
    const batchCount = Math.min(context.options.batchSize, count - offset);
    const requests = [];
    for (let j = 0; j < batchCount; j++) {
      const index = startIndex + offset + j;
      const name = makeUniquePayload(index, context.options.payloadBytes, context.options.seed);
      requests.push(requestJson(
        context.agent,
        'POST',
        `${context.controller.baseUrl}/api/sessions/create`,
        { name, workingDir: context.controller.workDir }
      ));
    }
    const responses = await Promise.all(requests);
    for (const response of responses) createdIds.push(response.sessionId);
  }
  return createdIds;
}

async function deleteSessions(context, sessionIds) {
  for (let offset = 0; offset < sessionIds.length; offset += context.options.batchSize) {
    const batch = sessionIds.slice(offset, offset + context.options.batchSize);
    await Promise.all(batch.map((sessionId) => requestJson(
      context.agent,
      'DELETE',
      `${context.controller.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`
    )));
  }
}

async function recordQuiescentSample(context, phase, ensurePersisted) {
  const { controller, instrumentation, options } = context;
  await instrumentation.quiesce();
  if (ensurePersisted && instrumentation.persistenceEnabled) {
    controller.server.sessionStore.markDirty();
    await controller.server.saveSessionsToDisk();
    await instrumentation.quiesce();
  }
  await forceFullGc(options.gcPasses);
  const memory = process.memoryUsage();
  const sample = createSampleRecord({
    arm: options.arm,
    phase,
    repetition: options.repetition,
    elapsedSeconds: (performance.now() - context.startedAt) / 1000,
    postGcHeapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    sessionsTotal: controller.server.claudeSessions.size,
    sessionsJsonBytes: fileSizeOrZero(controller.server.sessionStore.sessionsFile),
    instrumentation: instrumentation.takeInterval(),
  });
  context.samples.push(sample);
  fs.appendFileSync(context.samplesFile, `${JSON.stringify(sample)}\n`);
  process.stdout.write(
    `[probe] ${phase} sessions=${sample.sessions_total} `
    + `live_heap_mb=${(sample.post_gc_heap_used_bytes / 1048576).toFixed(1)} `
    + `json_mb=${(sample.sessions_json_bytes / 1048576).toFixed(1)}\n`
  );
  return sample;
}

async function runCreationPeriod(context, retainIds) {
  const { options } = context;
  const ids = retainIds ? [] : null;
  let created = 0;
  for (let second = 1; second <= options.durationSeconds; second++) {
    const tickStartedAt = performance.now();
    const batchIds = await createSessions(context, options.sessionRate, created);
    created += batchIds.length;
    if (ids) ids.push(...batchIds);
    const remainingMs = 1000 - (performance.now() - tickStartedAt);
    if (remainingMs > 0) await sleep(remainingMs);
    if (second % options.sampleSeconds === 0 || second === options.durationSeconds) {
      await recordQuiescentSample(context, 'retention', options.arm === 'persist-on');
    }
  }
  return ids;
}

async function runRetention(context) {
  await recordQuiescentSample(context, 'baseline', context.options.arm === 'persist-on');
  await runCreationPeriod(context, false);
  const points = context.samples
    .filter((sample) => sample.phase === 'baseline' || sample.phase === 'retention')
    .map((sample) => ({ x: sample.sessions_total, y: sample.post_gc_heap_used_bytes }));
  return {
    regression_bytes_per_session: linearRegression(points),
    final_sessions_json_bytes: context.samples.at(-1).sessions_json_bytes,
  };
}

async function runSerialization(context) {
  await recordQuiescentSample(context, 'empty_baseline', false);
  await createSessions(context, context.options.sessionCount, 0);
  await recordQuiescentSample(context, 'fixed_population_pre_save', false);
  context.instrumentation.setPersistenceEnabled(true);
  for (let cycle = 1; cycle <= context.options.saveCycles; cycle++) {
    await recordQuiescentSample(context, `serialization_save_${cycle}`, true);
  }
  const before = context.samples.find((sample) => sample.phase === 'fixed_population_pre_save');
  const after = context.samples.at(-1);
  return {
    fixed_session_count: after.sessions_total,
    post_gc_live_heap_delta_bytes: after.post_gc_heap_used_bytes - before.post_gc_heap_used_bytes,
    final_sessions_json_bytes: after.sessions_json_bytes,
  };
}

async function runDeletion(context) {
  const baseline = await recordQuiescentSample(context, 'baseline', false);
  await runCreationPeriod(context, false);
  const peak = context.samples.at(-1);
  const ids = Array.from(context.controller.server.claudeSessions.keys());
  await deleteSessions(context, ids);
  ids.length = 0;
  const after = await recordQuiescentSample(context, 'after_delete', false);
  const growth = peak.post_gc_heap_used_bytes - baseline.post_gc_heap_used_bytes;
  const residual = after.post_gc_heap_used_bytes - baseline.post_gc_heap_used_bytes;
  return {
    peak_growth_bytes: growth,
    residual_after_delete_bytes: residual,
    reclaimed_percent: growth === 0 ? null : ((growth - residual) / growth) * 100,
  };
}

function defaultOutputDir(options) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(
    DEFAULT_OUTPUT_ROOT,
    `${stamp}-${options.arm}-rep${options.repetition}`
  );
}

async function runProbe(options) {
  if (typeof global.gc !== 'function') {
    throw new Error('This probe requires --expose-gc; run it with node --expose-gc.');
  }
  const population = options.arm === 'serialization'
    ? options.sessionCount
    : options.durationSeconds * options.sessionRate;
  const uniquenessChecked = assertUniquePayloads(
    population,
    options.payloadBytes,
    options.seed
  );
  await forceFullGc(options.gcPasses);

  const outputDir = path.resolve(options.outputDir || defaultOutputDir(options));
  fs.mkdirSync(outputDir, { recursive: true });
  const samplesFile = path.join(outputDir, 'samples.jsonl');
  fs.writeFileSync(samplesFile, '');
  const metadata = {
    created_at: new Date().toISOString(),
    platform: process.platform,
    os_release: os.release(),
    arch: process.arch,
    node_version: process.version,
    heap_size_limit_bytes: v8.getHeapStatistics().heap_size_limit,
    cpu_count: os.cpus().length,
    config: options,
    payload_uniqueness_checked: uniquenessChecked,
    in_process_server_and_harness_share_heap: true,
  };
  fs.writeFileSync(
    path.join(outputDir, 'metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`
  );

  const { startServer } = require('../test/longevity/harness/server-controller');
  const controller = await startServer();
  const persistenceEnabled = options.arm === 'persist-on';
  const instrumentation = new SessionStoreInstrumentation(controller.server.sessionStore, {
    persistenceEnabled,
  });
  instrumentation.install();
  const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(64, options.batchSize) });
  const context = {
    agent,
    controller,
    instrumentation,
    options,
    outputDir,
    samplesFile,
    samples: [],
    startedAt: performance.now(),
  };

  let armSummary;
  try {
    if (options.arm === 'persist-on' || options.arm === 'persist-off') {
      armSummary = await runRetention(context);
    } else if (options.arm === 'serialization') {
      armSummary = await runSerialization(context);
    } else {
      armSummary = await runDeletion(context);
    }
  } finally {
    instrumentation.setPersistenceEnabled(false);
    try {
      await instrumentation.quiesce();
    } finally {
      try {
        await controller.close();
      } finally {
        instrumentation.restore();
        agent.destroy();
      }
    }
  }

  const summary = {
    completed_at: new Date().toISOString(),
    elapsed_seconds: (performance.now() - context.startedAt) / 1000,
    sample_count: context.samples.length,
    arm: options.arm,
    repetition: options.repetition,
    arm_summary: armSummary,
    instrumentation: instrumentation.summary(),
  };
  const finalMetadata = {
    ...metadata,
    completed_at: summary.completed_at,
    elapsed_seconds: summary.elapsed_seconds,
    sample_count: summary.sample_count,
  };
  fs.writeFileSync(
    path.join(outputDir, 'metadata.json'),
    `${JSON.stringify(finalMetadata, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(outputDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  process.stdout.write(`[probe] artifacts=${outputDir}\n`);
  return { outputDir, metadata: finalMetadata, samples: context.samples, summary };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await runProbe(options);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[probe] ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ARMS,
  SessionStoreInstrumentation,
  assertUniquePayloads,
  createSampleRecord,
  linearRegression,
  makeUniquePayload,
  parseArgs,
  runProbe,
  standardDeviation,
  summarize,
  usage,
};
