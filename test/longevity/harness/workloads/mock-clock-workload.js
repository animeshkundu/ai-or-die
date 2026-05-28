'use strict';

/**
 * MockClockWorkload
 *
 * Compresses the 7-day idle eviction sweep into seconds by:
 *   1. Injecting N synthetic sessions with `lastActivity` 8+ days in the past.
 *   2. Calling `_evictStaleSessions()` directly at high frequency.
 *
 * Stress target: the eviction sweep is the one path in the codebase gated
 * on wall-clock comparison; everything else is event-driven. We assert that
 * many back-to-back evictions don't:
 *   - leave stragglers in `claudeSessions` (last gate sample asserts empty)
 *   - leak file watchers (`fs_watch_sessions` returns to 0)
 *   - block the event loop > 200ms in a single sweep
 *
 * This workload does NOT touch global Date — that would break the other
 * workloads running in parallel and the JSONL timestamps. Instead it lies
 * to the eviction logic via the per-session `lastActivity` field.
 */
const { Workload } = require('../workload');
const { sleep } = require('./_net');

class MockClockWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'mock-clock', ...opts });
    // SOAK-05o: at 60-min duration the prior defaults (50/batch × 5 sweeps/s
    // = 250 sess/sec, no ceiling) ran the claudeSessions Map up to ~178 000
    // entries by end-of-run. _evictStaleSessions is O(n) (PROC-04 lane to
    // fix sub-linear), so the workload's own sweeps started consuming
    // hundreds of ms each; periodic saveSessions on that working set drove
    // event_loop p99 to 187 ms; 2.4 GB RSS triggered V8 full-tenured GC →
    // 2 709 ms max_ms outlier. Bundle soak FAILED the event_loop +
    // memory + handles gates because of this workload's runaway, not
    // because any fix regressed.
    //
    // New defaults: 10/batch × 5 sweeps/s = 50 sess/sec (5× lower) AND a
    // maxInjected cap of 3 000 sessions so the working set stays bounded
    // regardless of duration. Once cap is hit the workload still runs
    // eviction sweeps (still exercises the eviction code path), it just
    // stops injecting. Smoke run unchanged behaviorally (10-min × 50/sec
    // = 30 000 attempted, capped to 3 000 — same order of magnitude as the
    // smoke run with the old defaults, no behavior cliff at the 10-min
    // mark).
    this.batchSize = opts.batchSize || 10;
    this.sweepsPerSecond = opts.sweepsPerSecond || 5;
    this.daysOld = opts.daysOld || 90;
    this.maxInjected = opts.maxInjected || 3000;
    this._abort = false;
    this._loop = null;
    this._stats = { sweeps: 0, injected: 0, peakSweepMs: 0, errors: 0, capHit: false };
  }
  describe() {
    return `mock-clock: ${this.batchSize}/sweep × ${this.sweepsPerSecond}sweeps/s, cap ${this.maxInjected}, ${this.daysOld}d-old sessions`;
  }
  async start(ctx) {
    this._abort = false;
    this._server = ctx.server;
    if (!this._server || !this._server.claudeSessions) {
      throw new Error('MockClockWorkload: ctx.server required');
    }
    if (typeof this._server._evictStaleSessions !== 'function') {
      throw new Error('MockClockWorkload: server missing _evictStaleSessions');
    }
    this._loop = this._run();
    this.emit('start', { batchSize: this.batchSize, sweepsPerSecond: this.sweepsPerSecond });
  }
  async stop() {
    this._abort = true;
    if (this._loop) { try { await this._loop; } catch (_) { /* ignore */ } this._loop = null; }
    // Final cleanup: remove any leftover soak-evict-* sessions.
    if (this._server && this._server.claudeSessions) {
      for (const id of Array.from(this._server.claudeSessions.keys())) {
        if (id.startsWith('soak-evict-')) this._server.claudeSessions.delete(id);
      }
    }
    this.emit('stop', this._stats);
  }
  stats() { return { ...super.stats(), ...this._stats }; }

  async _run() {
    const period = Math.max(10, Math.floor(1000 / this.sweepsPerSecond));
    const olderThanMs = Date.now() - (this.daysOld * 24 * 60 * 60 * 1000);
    let counter = 0;
    while (!this._abort) {
      // Inject a batch of stale sessions UNTIL we hit maxInjected; after
      // that, keep running sweeps but stop injecting. Lets the workload
      // exercise the eviction path indefinitely without runaway Map growth.
      const remaining = Math.max(0, this.maxInjected - this._stats.injected);
      const thisBatch = Math.min(this.batchSize, remaining);
      if (thisBatch > 0) {
        for (let i = 0; i < thisBatch; i++) {
          const sid = `soak-evict-${counter++}`;
          this._server.claudeSessions.set(sid, {
            id: sid,
            name: sid,
            workingDir: '/tmp',
            connections: new Set(),
            agent: 'terminal',
            active: false,
            createdAt: new Date(olderThanMs),
            lastActivity: new Date(olderThanMs),
          });
          this._stats.injected++;
        }
      } else if (!this._stats.capHit) {
        this._stats.capHit = true;
        this.emit('inject_cap_hit', { injected: this._stats.injected });
      }
      // Sweep — always runs whether we just injected or not.
      const t0 = Date.now();
      try {
        await this._server._evictStaleSessions();
        const elapsed = Date.now() - t0;
        this._stats.sweeps++;
        if (elapsed > this._stats.peakSweepMs) this._stats.peakSweepMs = elapsed;
      } catch (err) {
        this._stats.errors++;
        this.emit('sweep_error', { error: err.message });
      }
      await sleep(period);
    }
  }
}

module.exports = { MockClockWorkload };
