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
    this.batchSize = opts.batchSize || 50;
    this.sweepsPerSecond = opts.sweepsPerSecond || 5;
    this.daysOld = opts.daysOld || 90;
    this._abort = false;
    this._loop = null;
    this._stats = { sweeps: 0, injected: 0, peakSweepMs: 0, errors: 0 };
  }
  describe() {
    return `mock-clock: ${this.batchSize}/sweep × ${this.sweepsPerSecond}sweeps/s, ${this.daysOld}d-old sessions`;
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
      // Inject a fresh batch of old sessions.
      for (let i = 0; i < this.batchSize; i++) {
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
      // Sweep.
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
