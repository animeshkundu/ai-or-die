'use strict';

/**
 * ReconnectStormWorkload
 *
 * Cycle N WebSocket clients through connect → create_session → disconnect
 * at a deterministic cadence. Stresses:
 *   - webSocketConnections Map cleanup on close (PROC-03)
 *   - session join/leave bookkeeping
 *   - any listener accumulation on the bridge layer
 *
 * Pass/fail signal: read from gates by the runner.
 *   - handles: must stay flat after the storm (drift ≤ 5 / 2%)
 *   - ws_connections: must return to ~0 within the drain window
 *   - event_loop: must hold p99 < 50ms during the storm
 *
 * Why deterministic cadence: keeps the storm rate independent of host speed.
 * A slow CI box still drives the same logical pressure.
 */
const { Workload } = require('../workload');
const { openWs, closeWs, wsSend, sleep } = require('./_net');

class ReconnectStormWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'reconnect-storm', ...opts });
    this.tabCount = opts.tabCount || 50;
    this.cyclesPerSecond = opts.cyclesPerSecond || 1;
    this._abort = false;
    this._loops = [];
    this._stats = { cycles: 0, errors: 0, connects: 0, disconnects: 0 };
  }
  describe() {
    return `reconnect-storm: ${this.tabCount} tabs @ ${this.cyclesPerSecond}Hz`;
  }
  async start(ctx) {
    this._abort = false;
    // Stagger N concurrent loops so the storm rate is steady, not bursty.
    const periodMs = 1000 / this.cyclesPerSecond;
    for (let i = 0; i < this.tabCount; i++) {
      const delay = Math.floor((periodMs * i) / this.tabCount);
      this._loops.push(this._tabLoop(ctx, i, delay, periodMs));
    }
    this.emit('start', { tabCount: this.tabCount, cyclesPerSecond: this.cyclesPerSecond });
  }
  async stop() {
    this._abort = true;
    await Promise.allSettled(this._loops);
    this._loops = [];
    this.emit('stop', this._stats);
  }
  stats() { return { ...super.stats(), ...this._stats }; }

  async _tabLoop(ctx, idx, initialDelay, periodMs) {
    if (initialDelay > 0) await sleep(initialDelay);
    while (!this._abort) {
      const cycleStart = Date.now();
      let handle = null;
      try {
        handle = await openWs(ctx.wsUrl, { timeoutMs: 3000 });
        this._stats.connects++;
        // Best-effort: ask for a session, but don't block on its arrival.
        wsSend(handle.ws, { type: 'create_session', name: `soak-tab-${idx}-${this._stats.cycles}` });
        // Drain server messages briefly so we don't accumulate buffered frames.
        await sleep(50);
      } catch (err) {
        this._stats.errors++;
      } finally {
        if (handle) {
          await closeWs(handle.ws, 500);
          this._stats.disconnects++;
        }
        this._stats.cycles++;
      }
      const elapsed = Date.now() - cycleStart;
      const remaining = periodMs - elapsed;
      if (remaining > 0) await sleep(remaining);
    }
  }
}

module.exports = { ReconnectStormWorkload };
