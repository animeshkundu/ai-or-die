'use strict';

/**
 * NoopWorkload — the smoke-path workload that exercises NO server APIs.
 *
 * Purpose: verify the harness scaffolding (server boot, diagnostics sampling,
 * JSONL writing, gate evaluation, teardown) end-to-end WITHOUT confounding
 * the result with workload-specific load. If the noop smoke shows the heap
 * slope already failing, the harness itself is leaky and must be fixed
 * before any real workload result is trustworthy.
 *
 * SOAK-02 will add the seven real workloads (PTY flood, reconnect storm,
 * watcher flood, WS fuzz, attachment growth, session-store stringify,
 * mock-clock eviction). They share this base contract.
 */
const { Workload } = require('../workload');

class NoopWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'noop', ...opts });
  }
  describe() { return 'noop (smoke path; no server interaction)'; }
  async start(_ctx) {
    this.emit('start', {});
  }
  async stop() {
    this.emit('stop', {});
  }
}

module.exports = { NoopWorkload };
