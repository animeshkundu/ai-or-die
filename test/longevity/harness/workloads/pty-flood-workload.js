'use strict';

/**
 * PtyFloodWorkload
 *
 * The plan's "5MB/s for 4h, OSC 7 sequences with rotating cwds across 8
 * simulated tabs to defeat per-session dedupe" workload.
 *
 * Why this implementation does NOT spawn 8 real shells:
 *   - Spawning 8 shells per soak and pumping them at 5MB/s makes the
 *     workload bottleneck on shell scheduling and PTY copy throughput, not
 *     on the server-side OSC 7 / output coalescing pipeline that the gap
 *     audit actually flagged (HOT-01 in terminal-bridge.js:195–243).
 *   - The terminal bridge exposes `_installOsc7State` and
 *     `_handleOsc7Chunk` as underscore-prefixed seams precisely so unit
 *     tests can drive them without a real PTY. We reuse that seam here.
 *   - Cross-platform: a real-shell variant would have to branch
 *     bash/pwsh/cmd handling, which is exactly the kind of complexity that
 *     belongs in the regression test for the fix PR, not in the soak load
 *     generator.
 *
 * What this workload does:
 *   1. Installs 8 fake session contexts on the live `terminalBridge`, each
 *      with its own `validatePath` (real, expensive) and `onCwdChange`
 *      (no-op accumulator).
 *   2. Pumps OSC 7 escape chunks across the sessions in a rotating cwd
 *      pattern so the per-session `_lastRawOsc7` dedupe fires sometimes
 *      and misses others — exactly the audit's "defeat per-session dedupe"
 *      shape.
 *   3. Targets ~5MB/s aggregate by sizing each chunk * cadence.
 *
 * The fix PR (HOT-06) will broaden the dedupe to a path-validation cache;
 * this workload will continue to exercise it.
 */

const path = require('path');
const fs = require('fs');

const { Workload } = require('../workload');
const { sleep } = require('./_net');

const OSC7_PREFIX = '\x1b]7;file://';
const OSC7_SUFFIX = '\x07';

function buildOsc7(filePath) {
  return Buffer.from(`${OSC7_PREFIX}${encodeURI(filePath)}${OSC7_SUFFIX}`);
}

function buildPaddedChunk(rng, sizeBytes, osc7Buf) {
  // Real PTY chunks are mostly ANSI/text with OSC 7 sprinkled in.
  const padSize = Math.max(0, sizeBytes - osc7Buf.length);
  const seedByte = 32 + rng.int(0, 90); // printable ASCII
  const pad = Buffer.alloc(padSize, seedByte);
  return Buffer.concat([pad, osc7Buf]);
}

class PtyFloodWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'pty-flood', ...opts });
    this.tabCount = opts.tabCount || 8;
    // Default 1MB/s for smoke; plan-spec full stress is 5MB/s (opt-in).
    this.targetBytesPerSecond = opts.targetBytesPerSecond || 1 * 1024 * 1024;
    this.chunkBytes = opts.chunkBytes || 8 * 1024;
    this.cwdRotation = opts.cwdRotation || 4; // distinct cwds per tab
    this._abort = false;
    this._loop = null;
    this._installedIds = [];
    this._cwdDirs = [];
    this._stats = { chunks: 0, bytes: 0, osc7Sent: 0, errors: 0 };
  }
  describe() {
    return `pty-flood: ${this.tabCount} tabs × ~${(this.targetBytesPerSecond / 1024 / 1024).toFixed(1)}MB/s, ${this.cwdRotation} cwds/tab`;
  }
  async start(ctx) {
    this._abort = false;
    this._server = ctx.server;
    const bridge = this._server && this._server.terminalBridge;
    if (!bridge || typeof bridge._installOsc7State !== 'function') {
      throw new Error('PtyFloodWorkload: terminalBridge OSC 7 seam unavailable');
    }
    this._bridge = bridge;
    // Pre-build a rotating set of real cwd dirs so validatePath has stat() targets.
    for (let i = 0; i < this.tabCount * this.cwdRotation; i++) {
      const d = path.join(ctx.workDir, `pty-cwd-${i.toString().padStart(3, '0')}`);
      fs.mkdirSync(d, { recursive: true });
      this._cwdDirs.push(d);
    }
    for (let i = 0; i < this.tabCount; i++) {
      const sid = `soak-pty-${i.toString().padStart(2, '0')}`;
      const hooks = {
        onCwdChange: () => {}, // no-op: we sample server-side via gates, not via callback
        validatePath: (raw) => {
          // Mirror server.validatePath's expense (existsSync + realpathSync).
          try {
            const p = raw.replace(/^file:\/\//, '');
            if (!fs.existsSync(p)) return { valid: false, error: 'enoent' };
            return { valid: true, path: fs.realpathSync(p) };
          } catch (err) {
            return { valid: false, error: err.message };
          }
        },
      };
      bridge._installOsc7State(sid, hooks);
      this._installedIds.push(sid);
    }
    this._loop = this._run();
    this.emit('start', {
      tabCount: this.tabCount,
      cwdCount: this._cwdDirs.length,
      targetBps: this.targetBytesPerSecond,
    });
  }
  async stop() {
    this._abort = true;
    if (this._loop) { try { await this._loop; } catch (_) { /* ignore */ } this._loop = null; }
    if (this._bridge) {
      for (const sid of this._installedIds) {
        try { this._bridge._uninstallOsc7State(sid); } catch (_) { /* ignore */ }
      }
    }
    this._installedIds = [];
    for (const d of this._cwdDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
    this._cwdDirs = [];
    this.emit('stop', this._stats);
  }
  stats() { return { ...super.stats(), ...this._stats }; }

  async _run() {
    // Chunks per second to hit the target throughput.
    const chunksPerSecond = Math.max(1, Math.floor(this.targetBytesPerSecond / this.chunkBytes));
    // periodMs is the per-chunk budget; we batch ~1ms worth of chunks per
    // sleep so we don't burn 100% of the loop on setTimeout overhead at
    // ≥1k chunks/s. Tuned so even at the 5MB/s target the loop yields
    // ≥200 times/sec, keeping event-loop p99 measurements meaningful.
    const yieldEveryNChunks = Math.max(1, Math.floor(chunksPerSecond / 200));
    const batchPeriodMs = Math.max(1, Math.floor((yieldEveryNChunks * 1000) / chunksPerSecond));
    let i = 0;
    while (!this._abort) {
      const sidIdx = i % this._installedIds.length;
      const cwdIdx = (sidIdx * this.cwdRotation) + (Math.floor(i / this._installedIds.length) % this.cwdRotation);
      const sid = this._installedIds[sidIdx];
      const cwd = this._cwdDirs[cwdIdx % this._cwdDirs.length];
      const osc7Buf = buildOsc7(cwd);
      const chunk = buildPaddedChunk(this.rng, this.chunkBytes, osc7Buf);
      try {
        this._bridge._handleOsc7Chunk(sid, chunk);
        this._stats.chunks++;
        this._stats.bytes += chunk.length;
        this._stats.osc7Sent++;
      } catch (err) {
        this._stats.errors++;
      }
      i++;
      // Yield to the event loop so the sampler / WS server still runs.
      if (i % yieldEveryNChunks === 0) await sleep(batchPeriodMs);
    }
  }
}

module.exports = { PtyFloodWorkload };
