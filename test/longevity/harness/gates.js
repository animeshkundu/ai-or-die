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

  // ── DISK gates (SOAK-05e) ──────────────────────────────────────────────
  // Per SUP-REL spec + SUP-DISK per-PR convention. All four read from
  // `diag.disk.*` fields that DISK-02 / DISK-03 wire into _collectDiagnostics.
  // Each gate gracefully degrades to pass:null when the field is missing
  // (i.e. running against main HEAD before the DISK PRs are bundled) — the
  // harness still works; just doesn't produce a verdict for that gate.

  {
    name: 'disk.atomic_write',
    description: 'sessions.json atomic-write durability (DISK-01) — proxied via disk.ai_or_die_dir_stale === false.',
    // DISK-01 doesn't expose a dedicated atomic_write_ok field; the closest
    // observable is disk.ai_or_die_dir_stale, which DISK-02 sets to true
    // when the bytes-cache snapshot is older than the rotation cadence.
    // A genuinely-broken atomic write would manifest as a stale cache OR a
    // save_failure_count increment (covered by the separate gate below).
    metrics: [
      {
        name: 'ai_or_die_dir_stale',
        extract: ({ diag }) => diag.disk && typeof diag.disk.ai_or_die_dir_stale === 'boolean'
          ? (diag.disk.ai_or_die_dir_stale ? 1 : 0) : null,
        threshold: 0,
        spotCheck: (v) => v === 0,
      },
    ],
    evaluate(rows) {
      const xs = filterMetric(rows, 'ai_or_die_dir_stale');
      if (!xs.length) return { pass: null, summary: 'disk.ai_or_die_dir_stale not exposed (pre-DISK-02 bundle)' };
      const stale = xs.filter(r => r.value === 1);
      // Stale snapshot is allowed if it's transient (one sample window);
      // ≥2 consecutive samples is the regression signal.
      let maxRun = 0, run = 0;
      for (const r of xs) {
        if (r.value === 1) { run++; if (run > maxRun) maxRun = run; }
        else run = 0;
      }
      return {
        pass: maxRun < 2,
        summary: `ai_or_die_dir_stale max consecutive ${maxRun} (fail if ≥ 2); ${stale.length}/${xs.length} samples stale total`,
        max_consecutive_stale: maxRun,
        stale_count: stale.length,
        samples: xs.length,
      };
    },
  },

  {
    name: 'disk.save_failure_count',
    description: 'Cumulative SessionStore save failures — catches concurrent-save race + future fan-out bugs (DISK-04b).',
    // Why this is separate from disk.atomic_write_ok: the rename race
    // (DISK-04) does NOT corrupt sessions.json — the winning rename writes
    // intact data; only the losing rename ENOENTs and stderrs.
    // atomic_write_ok would report TRUE during the race. SUP-DISK pushed
    // back on the consolidation and pointed out we need a counter on
    // saveSessions() === false returns. This gate watches that counter
    // for ANY non-zero growth across the soak window — a single failed
    // save (whether from rename race, fsync error, or a future
    // concurrency bug we haven't seen yet) trips the gate.
    metrics: [
      {
        name: 'save_failure_count',
        extract: ({ diag }) => diag.disk && typeof diag.disk.save_failure_count === 'number'
          ? diag.disk.save_failure_count : null,
      },
    ],
    evaluate(rows) {
      const xs = filterMetric(rows, 'save_failure_count');
      if (xs.length < 2) return { pass: null, summary: 'disk.save_failure_count not exposed (pre-DISK-04b bundle)' };
      const first = xs[0].value;
      const last = xs[xs.length - 1].value;
      const delta = last - first;
      return {
        pass: delta === 0,
        summary: delta === 0
          ? `save_failure_count stable at ${first} across ${xs.length} samples`
          : `save_failure_count grew ${first} → ${last} (Δ +${delta}) — regression detected`,
        first, last, delta,
      };
    },
  },

  {
    name: 'disk.bytes_used',
    description: '~/.ai-or-die/ bytes (DISK-02) — slope must stay bounded under steady load.',
    metrics: [
      {
        name: 'bytes_used_mb',
        // DISK-02 exposes ai_or_die_dir_bytes (in bytes); convert to MB
        // for slope reporting in human-readable units.
        extract: ({ diag }) => diag.disk && typeof diag.disk.ai_or_die_dir_bytes === 'number'
          ? +(diag.disk.ai_or_die_dir_bytes / 1048576).toFixed(2) : null,
      },
    ],
    evaluate(rows, ctx) {
      const xs = filterMetric(rows, 'bytes_used_mb');
      if (xs.length < 2) return { pass: null, summary: 'disk.ai_or_die_dir_bytes not exposed or insufficient samples (pre-DISK-02 bundle)' };
      const slopeMbPerHour = linearRegressionSlope(xs) * 3600 * 1000;
      const threshold = ctx.thresholds.disk_bytes_slope_mb_per_hour ?? 100;
      const pass = slopeMbPerHour <= threshold;
      const last = xs[xs.length - 1].value;
      const peak = Math.max(...xs.map(r => r.value));
      return {
        pass,
        summary: `ai_or_die_dir slope ${slopeMbPerHour.toFixed(2)} MB/h (threshold ${threshold}), final ${last} MB, peak ${peak} MB`,
        slope_mb_per_hour: slopeMbPerHour,
        threshold,
        final_mb: last,
        peak_mb: peak,
        samples: xs.length,
      };
    },
  },

  {
    name: 'disk.circuit_breaker',
    description: 'ENOSPC circuit breaker — must stay closed under normal soak load (DISK-03).',
    metrics: [
      {
        name: 'circuit_breaker_open',
        extract: ({ diag }) => diag.disk && typeof diag.disk.circuit_breaker_open === 'boolean'
          ? (diag.disk.circuit_breaker_open ? 1 : 0) : null,
        threshold: 0,
        // pass = false (breaker stays closed); deliberate-fill tests opt out.
        spotCheck: (v) => v === 0,
      },
    ],
    evaluate(rows, ctx) {
      const xs = filterMetric(rows, 'circuit_breaker_open');
      if (!xs.length) return { pass: null, summary: 'disk.circuit_breaker_open not exposed (pre-DISK-03 bundle)' };
      // The disk-bloat-quota workload deliberately trips the breaker; let
      // callers opt out via thresholds.disk_breaker_allow_trip = true.
      const allowTrip = ctx.thresholds.disk_breaker_allow_trip === true;
      const tripped = xs.filter(r => r.value === 1);
      const pass = allowTrip ? null : tripped.length === 0;
      return {
        pass,
        summary: allowTrip
          ? `disk_breaker tripped ${tripped.length}/${xs.length} samples (allowed by disk-bloat-quota workload)`
          : (tripped.length === 0
            ? `disk_breaker stayed closed across ${xs.length} samples`
            : `disk_breaker OPENED in ${tripped.length}/${xs.length} samples`),
        samples: xs.length,
        trip_count: tripped.length,
      };
    },
  },

  {
    name: 'disk.quota',
    description: 'Quota usage % — must stay below 90% under normal soak load (DISK-03).',
    metrics: [
      {
        name: 'quota_used_pct',
        extract: ({ diag }) => diag.disk && typeof diag.disk.quota_used_pct === 'number'
          ? diag.disk.quota_used_pct : null,
        threshold: 90,
        spotCheck: (v) => v < 90,
      },
    ],
    evaluate(rows, ctx) {
      const xs = filterMetric(rows, 'quota_used_pct');
      if (!xs.length) return { pass: null, summary: 'disk.quota_used_pct not exposed (pre-DISK-03 bundle)' };
      const allowOver = ctx.thresholds.disk_breaker_allow_trip === true;
      const peak = Math.max(...xs.map(r => r.value));
      const last = xs[xs.length - 1].value;
      const threshold = ctx.thresholds.disk_quota_max_pct ?? 90;
      const pass = allowOver ? null : peak < threshold;
      return {
        pass,
        summary: `quota_used_pct peak ${peak.toFixed(1)}%, final ${last.toFixed(1)}% (threshold ${threshold}%)`,
        peak_pct: peak,
        final_pct: last,
        threshold_pct: threshold,
      };
    },
  },

  // ── CLIENT gates (SOAK-05b) ─────────────────────────────────────────────
  // Browser-side metrics emitted by BrowserSampler (Playwright +
  // window.__diagnostics() per CLIENT-03 spec). The sampler emits with the
  // gate names below — the evaluator below consumes them. All client gates
  // gracefully report pass:null when no rows are present (CLIENT-03 not
  // bundled OR --browser-page flag absent).

  {
    name: 'client.plan_detector',
    description: 'plan-detector buffer must stay under 8 MB hard cap (CLIENT-01).',
    metrics: [
      // BrowserSampler emits these; extract from `null` so we never crash
      // on a server-only sample row.
      { name: 'bytes', extract: () => null },
    ],
    evaluate(rows, _ctx) {
      const xs = filterMetric(rows, 'bytes');
      if (!xs.length) return { pass: null, summary: 'client.plan_detector.bytes not sampled (no browser page)' };
      const peak = Math.max(...xs.map(r => r.value));
      const cap = 8 * 1024 * 1024;
      const pass = peak <= cap;
      return {
        pass,
        summary: `plan_detector.bytes peak ${(peak / 1024 / 1024).toFixed(2)} MB (cap ${(cap / 1024 / 1024)} MB)`,
        peak_bytes: peak,
        cap_bytes: cap,
        samples: xs.length,
      };
    },
  },

  {
    name: 'client.dom',
    description: 'DOM total_nodes slope must stay < 100 nodes/h (CLIENT-02).',
    metrics: [
      { name: 'total_nodes', extract: () => null },
    ],
    evaluate(rows, ctx) {
      const xs = filterMetric(rows, 'total_nodes');
      if (xs.length < 2) return { pass: null, summary: 'client.dom.total_nodes not sampled / insufficient samples' };
      const slopePerHour = linearRegressionSlope(xs) * 3600 * 1000;
      const threshold = ctx.thresholds.client_dom_slope_per_hour ?? 100;
      const pass = slopePerHour <= threshold;
      const first = xs[0].value;
      const last = xs[xs.length - 1].value;
      return {
        pass,
        summary: `dom.total_nodes slope ${slopePerHour.toFixed(1)}/h (threshold ${threshold}/h), ${first} → ${last} over ${xs.length} samples`,
        slope_per_hour: slopePerHour,
        threshold,
        first, last,
      };
    },
  },

  {
    name: 'client.xterm',
    description: 'xterm scrollback line count must stay ≤ 10100 (CLIENT-03 §1).',
    metrics: [
      { name: 'scrollback_lines', extract: () => null },
    ],
    evaluate(rows, _ctx) {
      const xs = filterMetric(rows, 'scrollback_lines');
      if (!xs.length) return { pass: null, summary: 'client.xterm.scrollback_lines not sampled' };
      const peak = Math.max(...xs.map(r => r.value));
      const cap = 10100;
      return {
        pass: peak <= cap,
        summary: `xterm.scrollback_lines peak ${peak} (cap ${cap})`,
        peak,
        cap,
      };
    },
  },

  {
    name: 'client.ws',
    description: 'WebSocket state must stay OPEN (1) post-baseline (CLIENT-03 §3 reconnect-failure detection).',
    metrics: [
      { name: 'state', extract: () => null },
    ],
    evaluate(rows, _ctx) {
      const xs = filterMetric(rows, 'state');
      if (xs.length < 2) return { pass: null, summary: 'client.ws.state not sampled / insufficient samples' };
      // Skip the very first sample (pre-session); CLIENT-03 spec §5 allows
      // ws.state to be null/closed at baseline. Subsequent samples must be 1.
      const postBaseline = xs.slice(1);
      const stuck = postBaseline.filter(r => r.value === 2 || r.value === 3);
      // Per spec: failure = state stuck at 2/3 for MORE than one sample period.
      // We approximate as: ≥ 2 consecutive samples at 2/3.
      let maxRun = 0, run = 0;
      for (const r of postBaseline) {
        if (r.value === 2 || r.value === 3) { run++; if (run > maxRun) maxRun = run; }
        else run = 0;
      }
      const pass = maxRun < 2;
      return {
        pass,
        summary: `ws.state max consecutive 2/3 = ${maxRun} (fail if ≥ 2)`,
        max_consecutive_closing_or_closed: maxRun,
        post_baseline_samples: postBaseline.length,
      };
    },
  },

  {
    name: 'client.sse',
    description: 'SSE stream count slope must stay ≤ 0 in steady state (CLIENT-03 §3).',
    metrics: [
      { name: 'streams', extract: () => null },
    ],
    evaluate(rows, _ctx) {
      const xs = filterMetric(rows, 'streams');
      if (xs.length < 3) return { pass: null, summary: 'client.sse.streams not sampled / insufficient samples' };
      // Steady-state slope: skip the first sample (baseline) and last (post-stop drain).
      const steady = xs.slice(1, -1);
      if (steady.length < 2) return { pass: null, summary: 'insufficient steady-state samples' };
      const slopePerHour = linearRegressionSlope(steady) * 3600 * 1000;
      const pass = slopePerHour <= 0.5;
      const peak = Math.max(...steady.map(r => r.value));
      return {
        pass,
        summary: `sse.streams steady-state slope ${slopePerHour.toFixed(2)}/h (peak ${peak})`,
        slope_per_hour: slopePerHour,
        peak,
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
