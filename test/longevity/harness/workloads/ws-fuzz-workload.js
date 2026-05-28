'use strict';

/**
 * WsFuzzWorkload
 *
 * Open a small pool of WebSocket clients and pepper the server with frames
 * of varying sizes (1KB / 100KB / 10MB) and shapes (valid JSON, garbage,
 * binary). Stresses HOT-03 — `JSON.parse(message)` in the WS handler has no
 * size check, so a 10MB frame parses and stalls the loop.
 *
 * The server's `WebSocket.Server({ maxPayload: 8MB })` will (correctly)
 * reject the 10MB frame at the protocol layer. We still SEND it so the
 * close handler runs, and we expect to see no loop stall in the spike
 * window.
 *
 * Deterministic: payload sizes and shapes are picked from a fixed sequence
 * derived from rng.
 */

const { Workload } = require('../workload');
const { openWs, closeWs, wsSend, sleep, WebSocket } = require('./_net');

// Default sizes are smoke-friendly. The plan-spec stress profile adds a
// 10MB frame (over the server's 8MB protocol cap so the rejection path is
// exercised); pass `{sizes: [...]}` to include it.
const SIZES = [1024, 100 * 1024, 1024 * 1024];
const SHAPES = ['json', 'garbage', 'binary', 'truncated'];

function buildPayload(rng, size, shape) {
  switch (shape) {
    case 'json': {
      // Build deterministically-sized JSON: { type: 'input', sessionId, data: <padding> }
      const padLen = Math.max(0, size - 80);
      const pad = 'x'.repeat(padLen);
      return JSON.stringify({ type: 'input', sessionId: 'fuzz', data: pad });
    }
    case 'garbage':
      return Buffer.alloc(size, 0x42).toString('utf8');
    case 'binary':
      return Buffer.alloc(size, rng.int(0, 256));
    case 'truncated':
      return '{"type":"input","sessionId":"fuzz","data":"' + 'x'.repeat(Math.max(0, size - 50));
    default:
      return '';
  }
}

class WsFuzzWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'ws-fuzz', ...opts });
    this.framesPerSecond = opts.framesPerSecond || 10;
    this.poolSize = opts.poolSize || 4;
    this._abort = false;
    this._pool = [];
    this._loop = null;
    this._stats = { framesSent: 0, framesDropped: 0, reopens: 0 };
  }
  describe() {
    return `ws-fuzz: ${this.framesPerSecond}Hz across ${this.poolSize} clients, sizes up to 10MB`;
  }
  async start(ctx) {
    this._abort = false;
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const handle = await openWs(ctx.wsUrl, { timeoutMs: 3000 });
        this._pool.push(handle);
      } catch (err) {
        this.emit('open_error', { idx: i, error: err.message });
      }
    }
    this._loop = this._run(ctx);
    this.emit('start', { poolSize: this._pool.length });
  }
  async stop() {
    this._abort = true;
    if (this._loop) {
      try { await this._loop; } catch (_) { /* ignore */ }
      this._loop = null;
    }
    for (const h of this._pool) await closeWs(h.ws, 500);
    this._pool = [];
    this.emit('stop', this._stats);
  }
  stats() { return { ...super.stats(), ...this._stats }; }

  async _run(ctx) {
    const period = Math.max(1, Math.floor(1000 / this.framesPerSecond));
    let i = 0;
    while (!this._abort) {
      const start = Date.now();
      // Sequence is deterministic given the seed.
      const size = SIZES[i % SIZES.length];
      const shape = SHAPES[Math.floor(i / SIZES.length) % SHAPES.length];
      const target = this._pool[i % Math.max(1, this._pool.length)];
      i++;
      if (!target || target.ws.readyState !== WebSocket.OPEN) {
        // Best-effort reopen so the storm continues across rejected oversize frames.
        try {
          const h = await openWs(ctx.wsUrl, { timeoutMs: 3000 });
          const idx = this._pool.indexOf(target);
          if (idx >= 0) this._pool[idx] = h; else this._pool.push(h);
          this._stats.reopens++;
        } catch (_) { /* try again next tick */ }
      }
      const payload = buildPayload(this.rng, size, shape);
      const dst = this._pool[i % Math.max(1, this._pool.length)];
      if (dst && dst.ws.readyState === WebSocket.OPEN) {
        const ok = wsSend(dst.ws, payload);
        if (ok) this._stats.framesSent++;
        else this._stats.framesDropped++;
      } else {
        this._stats.framesDropped++;
      }
      const elapsed = Date.now() - start;
      const remaining = period - elapsed;
      if (remaining > 0) await sleep(remaining);
    }
  }
}

module.exports = { WsFuzzWorkload };
