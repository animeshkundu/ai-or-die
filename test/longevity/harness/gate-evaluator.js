'use strict';

/**
 * Consumes the in-memory record stream produced by DiagnosticsSampler (or
 * re-parsed from samples.jsonl on disk) and produces a final verdict per
 * gate: `{name, pass, summary, ...}`.
 *
 * Why a separate module: the sampler runs live during the soak; the
 * evaluator runs once at end-of-run AND can also re-run offline against a
 * saved JSONL file (useful for re-evaluating an older soak with new
 * thresholds, or for SUP-REL to diff PR vs baseline).
 */

const fs = require('fs');
const readline = require('readline');

const { GATES } = require('./gates');

const DEFAULT_THRESHOLDS = {
  heap_slope_mb_per_hour: 2.5,   // 10MB / 4h
  handles_abs_delta: 5,
  handles_pct_delta: 2,
  fd_pct_delta: 1,
  fs_watch_tail_max: 0,
};

class GateEvaluator {
  constructor(options = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    this.selectedGates = options.gates || null; // null = all gates
    this._rows = [];
  }

  ingest(row) {
    this._rows.push(row);
  }

  ingestMany(rows) {
    for (const r of rows) this._rows.push(r);
  }

  async ingestFile(filePath) {
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { this._rows.push(JSON.parse(trimmed)); }
      catch (_) { /* skip malformed line */ }
    }
  }

  evaluate() {
    const ctx = { thresholds: this.thresholds };
    const results = [];
    for (const gateDef of GATES) {
      if (this.selectedGates && !this.selectedGates.includes(gateDef.name)) continue;
      const gateRows = this._rows.filter(r => r.gate === gateDef.name);
      let verdict;
      try {
        verdict = gateDef.evaluate(gateRows, ctx);
      } catch (err) {
        verdict = { pass: false, summary: `evaluator threw: ${err.message}` };
      }
      results.push({
        name: gateDef.name,
        description: gateDef.description,
        ...verdict,
      });
    }
    const decidable = results.filter(r => r.pass !== null);
    const overall = decidable.length === 0
      ? null
      : decidable.every(r => r.pass === true);
    return {
      overall,
      gate_count: results.length,
      decidable_count: decidable.length,
      thresholds: this.thresholds,
      gates: results,
    };
  }
}

module.exports = { GateEvaluator, DEFAULT_THRESHOLDS };
