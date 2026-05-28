'use strict';

/**
 * PtyFloodWsWorkload (SOAK-05n).
 *
 * The WS-broadcast variant of pty-flood. Unlike the existing `pty-flood`
 * which drives `terminalBridge._handleOsc7Chunk` internally (bypassing
 * the WS broadcast pipeline), this workload pushes output through the
 * production data path:
 *
 *   workload → server._throttledOutputBroadcast(sessionId, chunk)
 *           → coalescer (16 ms / 32 KB FG window per ADR 0009)
 *           → server._flushSessionOutput
 *           → binary WS frame to every connected client
 *           → browser client.app.terminal.write
 *           → PlanDetector.processOutput accumulates into bufferBytes
 *
 * Purpose: exercise the CLIENT-01 plan-detector 8 MB byte cap end-to-end.
 * The original `pty-flood` workload silently never fills the browser's
 * plan-detector buffer because the internal OSC 7 seam doesn't broadcast
 * (SOAK-05m surfaced this as the `client.plan_detector.bytes` peak == 0
 * "vacuous PASS"; the SOAK-05n vacuous-PASS guard in gate-evaluator now
 * upgrades that to FAIL so future regressions can't hide here).
 *
 * Target selection: by default, the workload iterates `server.claudeSessions`
 * and broadcasts to every session that has ≥1 connected client (i.e. the
 * browser sampler's session). Operator can pin to a specific sessionId via
 * `--workload-opts=pty-flood-ws.targetSessionId=<id>`.
 *
 * Default rate: 1 MB/s smoke (matches `pty-flood` smoke default). Stress
 * profile per plan-spec: `--workload-opts=pty-flood-ws.targetBytesPerSecond=5242880`
 * for 5 MB/s. At 5 MB/s the browser's 8 MB plan-detector cap is hit in
 * ~1.6 s, then steady-state holds the cap with eviction.
 */

const path = require('path');
const fs = require('fs');

const { Workload } = require('../workload');
const { sleep } = require('./_net');

const OSC7_PREFIX = '\x1b]7;file://';
const OSC7_SUFFIX = '\x07';

function buildOsc7(filePath) {
  return `${OSC7_PREFIX}${encodeURI(filePath)}${OSC7_SUFFIX}`;
}

function buildChunk(rng, sizeBytes, osc7Str) {
  const padSize = Math.max(0, sizeBytes - osc7Str.length);
  const seedByte = 32 + rng.int(0, 90); // printable ASCII
  const pad = String.fromCharCode(seedByte).repeat(padSize);
  return pad + osc7Str;
}

class PtyFloodWsWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'pty-flood-ws', ...opts });
    this.targetBytesPerSecond = opts.targetBytesPerSecond || 1 * 1024 * 1024;
    this.chunkBytes = opts.chunkBytes || 8 * 1024;
    this.cwdRotation = opts.cwdRotation || 4;
    this.targetSessionId = opts.targetSessionId || null; // null = broadcast to all
    this._abort = false;
    this._loop = null;
    this._cwdDirs = [];
    this._stats = {
      chunks: 0,
      bytes: 0,
      sessionsTargeted: 0,
      noTargetTicks: 0, // ticks with no connected session — sampler not yet joined
      errors: 0,
    };
  }
  describe() {
    return `pty-flood-ws: ~${(this.targetBytesPerSecond / 1024 / 1024).toFixed(1)}MB/s via _throttledOutputBroadcast${this.targetSessionId ? ` → ${this.targetSessionId}` : ' → all sessions w/ clients'}`;
  }
  async start(ctx) {
    this._abort = false;
    this._server = ctx.server;
    if (!this._server || typeof this._server._throttledOutputBroadcast !== 'function') {
      throw new Error('PtyFloodWsWorkload: server._throttledOutputBroadcast required (bundle must include the coalescer; verified at server.js:3546)');
    }
    // Pre-build rotating cwd dirs so the OSC 7 paths in chunks resolve.
    for (let i = 0; i < this.cwdRotation; i++) {
      const d = path.join(ctx.workDir, `pty-ws-cwd-${i.toString().padStart(2, '0')}`);
      fs.mkdirSync(d, { recursive: true });
      this._cwdDirs.push(d);
    }
    this._loop = this._run();
    this.emit('start', {
      targetBps: this.targetBytesPerSecond,
      cwdCount: this._cwdDirs.length,
      targetSessionId: this.targetSessionId,
    });
  }
  async stop() {
    this._abort = true;
    if (this._loop) { try { await this._loop; } catch (_) { /* ignore */ } this._loop = null; }
    for (const d of this._cwdDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
    this._cwdDirs = [];
    this.emit('stop', this._stats);
  }
  stats() { return { ...super.stats(), ...this._stats }; }

  /**
   * Pick the set of sessionIds to broadcast to this tick.
   * - If `targetSessionId` is pinned, use that one (whether it has clients or not).
   * - Otherwise, all sessions with `connections.size > 0` (i.e. the browser
   *   sampler has joined). Empty result means the sampler hasn't joined yet;
   *   we count it and skip (don't broadcast into the void).
   */
  _selectTargets() {
    if (this.targetSessionId) return [this.targetSessionId];
    const result = [];
    for (const [sid, sess] of this._server.claudeSessions) {
      if (sess && sess.connections && sess.connections.size > 0) result.push(sid);
    }
    return result;
  }

  async _run() {
    const chunksPerSecond = Math.max(1, Math.floor(this.targetBytesPerSecond / this.chunkBytes));
    // Same yield discipline as pty-flood: ~200 yields/sec keeps event_loop
    // measurement meaningful even at 5 MB/s.
    const yieldEveryNChunks = Math.max(1, Math.floor(chunksPerSecond / 200));
    const batchPeriodMs = Math.max(1, Math.floor((yieldEveryNChunks * 1000) / chunksPerSecond));
    let i = 0;
    while (!this._abort) {
      const targets = this._selectTargets();
      if (targets.length === 0) {
        this._stats.noTargetTicks++;
        // Slow down when there's no target — full-rate spinning a no-op
        // burns CPU. 100 ms backoff is responsive enough for the browser
        // sampler's session join (which happens in the first ~500 ms).
        await sleep(100);
        continue;
      }
      this._stats.sessionsTargeted = Math.max(this._stats.sessionsTargeted, targets.length);

      const cwd = this._cwdDirs[i % this._cwdDirs.length];
      const osc7 = buildOsc7(cwd);
      const chunk = buildChunk(this.rng, this.chunkBytes, osc7);

      for (const sid of targets) {
        try {
          this._server._throttledOutputBroadcast(sid, chunk);
          this._stats.chunks++;
          this._stats.bytes += chunk.length;
        } catch (err) {
          this._stats.errors++;
        }
      }

      i++;
      if (i % yieldEveryNChunks === 0) await sleep(batchPeriodMs);
    }
  }
}

module.exports = { PtyFloodWsWorkload };
