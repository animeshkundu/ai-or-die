'use strict';

/**
 * Periodically samples the server's diagnostics endpoint AND the local
 * `perf_hooks.monitorEventLoopDelay` histogram, then forwards each metric
 * as one JSONL row of shape `{ts, gate, metric, value, threshold, pass}`
 * via the provided sink.
 *
 * Event-loop delay is the only metric the harness cannot get from
 * /api/diagnostics — it's measured in the harness process. (The harness
 * runs in-process with the server: that's what makes the perf_hooks
 * monitor accurate. When we run the harness as a SEPARATE process driving
 * a separate server, this metric will be reported as null and the gate
 * will be skipped — see future cross-process variant.)
 *
 * "Gate" vs "metric":
 *   - gate  = coarse category the operator can re-run individually
 *             (memory, handles, requests, fd, ws, fs_watch, event_loop)
 *   - metric = specific reading within the gate (heap_used_mb, rss_mb, ...)
 *
 * "pass" semantics per row:
 *   - For instantaneous thresholds (event_loop p99, max), pass=true/false
 *     per sample.
 *   - For trend-based gates (heap slope, handle drift), per-sample pass=null
 *     and the GateEvaluator computes a verdict at end-of-run.
 */

const http = require('http');
const { monitorEventLoopDelay } = require('perf_hooks');

const { GATES } = require('./gates');

class DiagnosticsSampler {
  constructor(options) {
    if (!options || !options.baseUrl || typeof options.sink !== 'function') {
      throw new Error('DiagnosticsSampler: baseUrl and sink are required');
    }
    this.baseUrl = options.baseUrl;
    this.sink = options.sink;
    this.intervalMs = options.intervalMs || 30_000;
    this.eventLoopResolutionMs = options.eventLoopResolutionMs || 20;
    this._timer = null;
    this._elHistogram = null;
    this._sampleCount = 0;
    this._errorCount = 0;
    this._lastSample = null;
  }

  start() {
    if (this._timer) return;
    this._elHistogram = monitorEventLoopDelay({
      resolution: this.eventLoopResolutionMs,
    });
    this._elHistogram.enable();

    // First sample immediately so a 60-second smoke gets ≥2 rows.
    this._tick().catch(err => {
      process.stderr.write(`[soak/sampler] first tick failed: ${err.message}\n`);
    });
    this._timer = setInterval(() => {
      this._tick().catch(err => {
        process.stderr.write(`[soak/sampler] tick failed: ${err.message}\n`);
      });
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  async stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Final tick on the way out so the last 30s window is captured.
    try { await this._tick(); } catch (_) { /* ignore */ }
    if (this._elHistogram) {
      this._elHistogram.disable();
      this._elHistogram = null;
    }
  }

  stats() {
    return {
      samples: this._sampleCount,
      errors: this._errorCount,
      lastSample: this._lastSample,
    };
  }

  async _tick() {
    const ts = new Date().toISOString();
    let diag;
    try {
      diag = await this._fetchDiagnostics();
    } catch (err) {
      this._errorCount++;
      this.sink({
        ts,
        gate: 'meta',
        metric: 'sampler_error',
        value: err.message,
        threshold: null,
        pass: false,
      });
      return;
    }

    // Snapshot perf_hooks histogram in ns, convert to ms, then reset so each
    // sample is a 30-second window (not cumulative since boot).
    const h = this._elHistogram;
    const eventLoop = h ? {
      p50_ms: +(h.percentile(50) / 1e6).toFixed(3),
      p99_ms: +(h.percentile(99) / 1e6).toFixed(3),
      max_ms: +(h.max / 1e6).toFixed(3),
      mean_ms: +(h.mean / 1e6).toFixed(3),
    } : null;
    if (h) h.reset();

    this._sampleCount++;
    this._lastSample = { ts, diag, eventLoop };

    for (const gateDef of GATES) {
      for (const metricDef of gateDef.metrics) {
        let value;
        try {
          value = metricDef.extract({ diag, eventLoop });
        } catch (_) {
          value = null;
        }
        if (value === undefined) value = null;
        const threshold = metricDef.threshold !== undefined ? metricDef.threshold : null;
        let pass = null;
        if (typeof metricDef.spotCheck === 'function' && value != null) {
          try { pass = metricDef.spotCheck(value); } catch (_) { pass = null; }
        }
        this.sink({
          ts,
          gate: gateDef.name,
          metric: metricDef.name,
          value,
          threshold,
          pass,
        });
      }
    }
  }

  _fetchDiagnostics() {
    return new Promise((resolve, reject) => {
      const req = http.get(`${this.baseUrl}/api/diagnostics`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`diag HTTP ${res.statusCode}`));
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`diag JSON parse: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('diag timeout')));
    });
  }
}

module.exports = { DiagnosticsSampler };
