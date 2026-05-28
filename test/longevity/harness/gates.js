'use strict';

/**
 * Gate registry — the single source of truth for which metrics are sampled,
 * which thresholds the campaign promises, and how each gate is evaluated.
 *
 * Each gate has a `name` (referenced by `--gates=`), a list of `metrics`
 * (one row per metric per sample tick), and an `evaluate` function that
 * collapses an array of `{ts, value, ...}` rows for that gate into a single
 * `{pass, summary}` verdict at end-of-run.
 *
 * Three evaluation patterns recur:
 *   1. spot-check (every sample must pass) — event_loop p99, max
 *   2. linear-regression slope (must be < X over the window) — memory.heap
 *   3. drift (final vs initial absolute / percent delta) — handles, fd
 *
 * Plan-file thresholds (verbatim from
 * plans/this-app-needs-to-partitioned-horizon.md §"Pass/fail gates"):
 *   - memory.heap_used_mb slope < 10MB / 4h at steady-state
 *   - process.active_handles drift < 2% over 4h (absolute Δ ≤ 5)
 *   - process.active_requests returns to baseline ±2 within 60s of load cessation
 *   - fd_count drift < 1% over 4h (Linux only)
 *   - sessions.ws_connections matches simulated tab count exactly (caller-supplied)
 *   - sessions.fs_watch_sessions returns to 0 within 30s of disconnect (caller-supplied)
 *   - event-loop p99 < 50ms throughout; no single sample > 200ms
 *   - client: document.querySelectorAll('*').length slope < 100 nodes/hour (separate gate, future)
 *
 * Thresholds here are stated as ABSOLUTE deltas / slopes; the gate evaluator
 * normalizes by elapsed window so a 60s smoke and a 4h soak share the same
 * registry. e.g. heap_slope_mb_per_hour < 2.5 ≈ 10MB/4h.
 */

const GATES = [
  {
    name: 'memory',
    description: 'Heap and RSS — must not grow unboundedly over the soak window.',
    metrics: [
      { name: 'heap_used_mb',     extract: ({ diag }) => diag.memory.heap_used_mb },
      { name: 'heap_total_mb',    extract: ({ diag }) => diag.memory.heap_total_mb },
      { name: 'rss_mb',           extract: ({ diag }) => diag.memory.rss_mb },
      { name: 'external_mb',      extract: ({ diag }) => diag.memory.external_mb },
      { name: 'array_buffers_mb', extract: ({ diag }) => diag.memory.array_buffers_mb },
    ],
    evaluate(rows, ctx) {
      // Only the heap_used slope is gating; the rest are reported for diagnosis.
      const heap = filterMetric(rows, 'heap_used_mb');
      if (heap.length < 2) {
        return { pass: null, summary: 'insufficient samples for slope' };
      }
      const slopeMbPerHour = linearRegressionSlope(heap) * 3600 * 1000;
      // 10MB / 4h = 2.5 MB/h
      const threshold = ctx.thresholds.heap_slope_mb_per_hour ?? 2.5;
      const pass = slopeMbPerHour <= threshold;
      return {
        pass,
        summary: `heap slope ${slopeMbPerHour.toFixed(3)} MB/h (threshold ${threshold}) over ${heap.length} samples`,
        slope_mb_per_hour: slopeMbPerHour,
        threshold,
        samples: heap.length,
      };
    },
  },

  {
    name: 'handles',
    description: 'process.active_handles — drift must stay bounded.',
    metrics: [
      { name: 'active_handles', extract: ({ diag }) => diag.process.active_handles },
    ],
    evaluate(rows, ctx) {
      const xs = filterMetric(rows, 'active_handles');
      if (xs.length < 2) return { pass: null, summary: 'insufficient samples' };
      const first = xs[0].value;
      const last = xs[xs.length - 1].value;
      const max = Math.max(...xs.map(r => r.value));
      const absDelta = last - first;
      const pctDelta = first === 0 ? 0 : (absDelta / first) * 100;
      const absLimit = ctx.thresholds.handles_abs_delta ?? 5;
      const pctLimit = ctx.thresholds.handles_pct_delta ?? 2;
      const pass = Math.abs(absDelta) <= absLimit || Math.abs(pctDelta) <= pctLimit;
      return {
        pass,
        summary: `active_handles ${first} → ${last} (Δ ${absDelta}, ${pctDelta.toFixed(2)}%, peak ${max})`,
        first, last, abs_delta: absDelta, pct_delta: pctDelta, peak: max,
      };
    },
  },

  {
    name: 'requests',
    description: 'process.active_requests — should stay near 0; reported only.',
    metrics: [
      { name: 'active_requests', extract: ({ diag }) => diag.process.active_requests },
    ],
    evaluate(rows) {
      const xs = filterMetric(rows, 'active_requests');
      if (!xs.length) return { pass: null, summary: 'no samples' };
      const peak = Math.max(...xs.map(r => r.value));
      const last = xs[xs.length - 1].value;
      // Reported only — caller asserts ±2-of-baseline after load cessation.
      return { pass: null, summary: `active_requests peak ${peak}, final ${last}`, peak, final: last };
    },
  },

  {
    name: 'fd',
    description: 'fd_count (Linux only) — drift must stay < 1%.',
    metrics: [
      { name: 'fd_count', extract: ({ diag }) => diag.process.fd_count },
    ],
    evaluate(rows, ctx) {
      const xs = filterMetric(rows, 'fd_count').filter(r => typeof r.value === 'number');
      if (xs.length < 2) return { pass: null, summary: 'fd_count unavailable (non-Linux) or insufficient samples' };
      const first = xs[0].value;
      const last = xs[xs.length - 1].value;
      const absDelta = last - first;
      const pctDelta = first === 0 ? 0 : (absDelta / first) * 100;
      const pctLimit = ctx.thresholds.fd_pct_delta ?? 1;
      const pass = Math.abs(pctDelta) <= pctLimit;
      return {
        pass,
        summary: `fd_count ${first} → ${last} (Δ ${absDelta}, ${pctDelta.toFixed(2)}%)`,
        first, last, abs_delta: absDelta, pct_delta: pctDelta,
      };
    },
  },

  {
    name: 'ws',
    description: 'sessions.ws_connections — reported; caller supplies expected count.',
    metrics: [
      { name: 'ws_connections', extract: ({ diag }) => diag.sessions.ws_connections },
    ],
    evaluate(rows) {
      const xs = filterMetric(rows, 'ws_connections');
      if (!xs.length) return { pass: null, summary: 'no samples' };
      const peak = Math.max(...xs.map(r => r.value));
      const last = xs[xs.length - 1].value;
      return { pass: null, summary: `ws_connections peak ${peak}, final ${last}`, peak, final: last };
    },
  },

  {
    name: 'fs_watch',
    description: 'sessions.fs_watch_sessions — must return to 0 by end-of-run.',
    metrics: [
      { name: 'fs_watch_sessions', extract: ({ diag }) => diag.sessions.fs_watch_sessions },
    ],
    evaluate(rows, ctx) {
      const xs = filterMetric(rows, 'fs_watch_sessions');
      if (!xs.length) return { pass: null, summary: 'no samples' };
      const peak = Math.max(...xs.map(r => r.value));
      const last = xs[xs.length - 1].value;
      const tail = xs.slice(-1)[0].value;
      const target = ctx.thresholds.fs_watch_tail_max ?? 0;
      const pass = tail <= target;
      return {
        pass,
        summary: `fs_watch peak ${peak}, final ${last} (target ≤ ${target})`,
        peak, final: last,
      };
    },
  },

  {
    name: 'event_loop',
    description: 'perf_hooks histogram — p99 < 50ms; no sample > 200ms.',
    metrics: [
      {
        name: 'p50_ms',
        extract: ({ eventLoop }) => eventLoop && eventLoop.p50_ms,
      },
      {
        name: 'p99_ms',
        extract: ({ eventLoop }) => eventLoop && eventLoop.p99_ms,
        threshold: 50,
        spotCheck: (v) => v < 50,
      },
      {
        name: 'max_ms',
        extract: ({ eventLoop }) => eventLoop && eventLoop.max_ms,
        threshold: 200,
        spotCheck: (v) => v < 200,
      },
      {
        name: 'mean_ms',
        extract: ({ eventLoop }) => eventLoop && eventLoop.mean_ms,
      },
    ],
    evaluate(rows) {
      const p99 = filterMetric(rows, 'p99_ms');
      const max = filterMetric(rows, 'max_ms');
      if (!p99.length || !max.length) return { pass: null, summary: 'no event-loop samples' };
      const p99Peak = Math.max(...p99.map(r => r.value));
      const maxPeak = Math.max(...max.map(r => r.value));
      const p99Pass = p99.every(r => r.pass !== false);
      const maxPass = max.every(r => r.pass !== false);
      return {
        pass: p99Pass && maxPass,
        summary: `event-loop p99 peak ${p99Peak.toFixed(2)}ms (limit 50), single-sample peak ${maxPeak.toFixed(2)}ms (limit 200)`,
        p99_peak_ms: p99Peak,
        max_peak_ms: maxPeak,
      };
    },
  },
];

// ── helpers ─────────────────────────────────────────────────────────────

function filterMetric(rows, metricName) {
  return rows
    .filter(r => r.metric === metricName && r.value != null)
    .map(r => ({ ...r, ts: typeof r.ts === 'string' ? Date.parse(r.ts) : r.ts }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Simple ordinary-least-squares slope over rows of {ts (ms), value}.
 * Returns value per millisecond; caller multiplies up to its preferred unit.
 */
function linearRegressionSlope(rows) {
  const n = rows.length;
  if (n < 2) return 0;
  const t0 = rows[0].ts;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const r of rows) {
    const x = r.ts - t0;
    const y = r.value;
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  const denom = sumXX - n * meanX * meanX;
  if (denom === 0) return 0;
  return (sumXY - n * meanX * meanY) / denom;
}

module.exports = { GATES, filterMetric, linearRegressionSlope };
