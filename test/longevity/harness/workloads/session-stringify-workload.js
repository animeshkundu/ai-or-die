'use strict';

/**
 * SessionStringifyWorkload
 *
 * Inject N synthetic sessions (each carrying ~targetBytes of output buffer)
 * into the live server's `claudeSessions` Map, mark the store dirty, and
 * force `saveSessionsToDisk()` at the requested cadence.
 *
 * Stresses HOT-05 (`JSON.stringify` on the main thread for 500×200KB ≈ 100MB
 * of state takes 50–200ms blocking, killing the event-loop p99 gate).
 *
 * This workload reaches into the server instance via `ctx.server` rather
 * than driving public APIs — there's no public surface to inject 500
 * sessions, and the bug we're trying to detect is precisely the
 * single-blocking-stringify on shutdown / autosave.
 */
const CircularBuffer = require('../../../../src/utils/circular-buffer');

const { Workload } = require('../workload');
const { sleep } = require('./_net');

class SessionStringifyWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'session-stringify', ...opts });
    // Defaults sized so the workload is harmless in a 60-second smoke; the
    // plan-spec stress numbers (500 sessions × 200KB) are opt-in via
    // explicit options, see README §"Stress profiles".
    this.sessionCount = opts.sessionCount || 50;
    this.bytesPerSession = opts.bytesPerSession || 50 * 1024;
    this.savesPerMinute = opts.savesPerMinute || 6; // every 10s
    this._abort = false;
    this._loop = null;
    this._injectedIds = [];
    this._stats = { saves: 0, errors: 0, lastSaveMs: null, peakSaveMs: 0 };
  }
  describe() {
    return `session-stringify: ${this.sessionCount} sessions × ${(this.bytesPerSession / 1024).toFixed(0)}KB, ${this.savesPerMinute}saves/min`;
  }
  async start(ctx) {
    this._abort = false;
    this._server = ctx.server;
    if (!this._server || !this._server.claudeSessions) {
      throw new Error('SessionStringifyWorkload: ctx.server must expose claudeSessions');
    }
    // Build a deterministic payload buffer: a line of ~256B padding repeated
    // until we reach bytesPerSession. Per-session output is a CircularBuffer
    // matching the server's own data structures so saveSessionsToDisk takes
    // the production code path.
    const line = 'x'.repeat(240) + '\n';
    const linesPerSession = Math.max(1, Math.ceil(this.bytesPerSession / line.length));
    for (let i = 0; i < this.sessionCount; i++) {
      const sid = `soak-stringify-${i.toString().padStart(4, '0')}`;
      const buf = new CircularBuffer(linesPerSession);
      for (let j = 0; j < linesPerSession; j++) buf.push(line);
      this._server.claudeSessions.set(sid, {
        id: sid,
        name: `stringify-${i}`,
        workingDir: ctx.workDir,
        outputBuffer: buf,
        connections: new Set(),
        agent: 'terminal',
        active: false,
        createdAt: new Date(Date.now() - i * 1000),
        lastActivity: new Date(Date.now() - i * 1000),
      });
      this._injectedIds.push(sid);
    }
    this._loop = this._run();
    this.emit('start', {
      sessionCount: this.sessionCount,
      bytesPerSession: this.bytesPerSession,
      linesPerSession,
    });
  }
  async stop() {
    this._abort = true;
    if (this._loop) { try { await this._loop; } catch (_) { /* ignore */ } this._loop = null; }
    // Remove injected sessions so the next workload starts clean and so the
    // server-close path doesn't churn through 500 fake sessions.
    if (this._server && this._server.claudeSessions) {
      for (const sid of this._injectedIds) this._server.claudeSessions.delete(sid);
    }
    this._injectedIds = [];
    this.emit('stop', this._stats);
  }
  stats() { return { ...super.stats(), ...this._stats }; }

  async _run() {
    const period = Math.max(1000, Math.floor(60_000 / this.savesPerMinute));
    while (!this._abort) {
      // Mark dirty so saveSessions actually serializes (the store short-circuits
      // when !dirty). Use sessionStore.markDirty() if accessible.
      try {
        if (this._server.sessionStore && typeof this._server.sessionStore.markDirty === 'function') {
          this._server.sessionStore.markDirty();
        }
        const t0 = Date.now();
        await this._server.saveSessionsToDisk();
        const elapsed = Date.now() - t0;
        this._stats.saves++;
        this._stats.lastSaveMs = elapsed;
        if (elapsed > this._stats.peakSaveMs) this._stats.peakSaveMs = elapsed;
      } catch (err) {
        this._stats.errors++;
        this.emit('save_error', { error: err.message });
      }
      await sleep(period);
    }
  }
}

module.exports = { SessionStringifyWorkload };
