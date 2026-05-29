'use strict';

/**
 * Abstract base for synthetic soak workloads.
 *
 * Contract every workload implements:
 *   describe()        — short string for logs/reports
 *   async start(ctx)  — begin emitting load against ctx.baseUrl / ctx.wsUrl
 *   async stop()      — quiesce; resolve only after every spawned timer /
 *                       socket / fd is released. Failure to release here
 *                       will leak into the next gate evaluation cycle and
 *                       falsely fail the handles/fd gates.
 *
 * Determinism rules:
 *   - Every workload MUST take an `rng` (Rng instance) and derive its random
 *     choices from it. Never call Math.random.
 *   - Workload-internal timers / message payloads should be stable across
 *     runs with the same seed.
 *
 * Lifecycle ownership:
 *   - The runner calls start() once, waits the soak duration, then calls
 *     stop() and awaits it BEFORE the diagnostics sampler stops. So the
 *     final sample window catches any straggler handles / fs_watch sessions
 *     and the fs_watch gate's "returns to 0" assertion has a chance to fire.
 */
class Workload {
  /**
   * @param {{rng: import('./rng').Rng, name: string}} opts
   */
  constructor(opts) {
    this.name = opts.name || this.constructor.name;
    this.rng = opts.rng;
    this.events = [];
  }
  describe() { return this.name; }
  // eslint-disable-next-line no-unused-vars
  async start(_ctx) { throw new Error(`${this.name}: start() not implemented`); }
  async stop() { throw new Error(`${this.name}: stop() not implemented`); }
  /** Push a structured event into the workload's local buffer. */
  emit(type, data) {
    this.events.push({ ts: new Date().toISOString(), type, data });
  }
  stats() { return { name: this.name, events: this.events.length }; }
}

module.exports = { Workload };
