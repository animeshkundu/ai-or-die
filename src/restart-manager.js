'use strict';

const RESTART_EXIT_CODE = 75;
const MEMORY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const NOTIFICATION_THROTTLE_MS = 30 * 60 * 1000; // 30 minutes
const RESTART_BROADCAST_DELAY_MS = 500;
const MIN_RESTART_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between restarts

/**
 * Memory monitoring and restart trigger.
 *
 * This is NOT a supervisor — process lifecycle is managed by bin/supervisor.js.
 * This module only:
 *   1. Monitors memory and triggers GC when RSS exceeds a threshold
 *   2. Notifies clients when memory is critically high
 *   3. Initiates a restart by broadcasting to clients, then delegating to
 *      the server's existing handleShutdown() with exit code 75
 */
class RestartManager {
  constructor(server) {
    this.server = server;
    this.gcThresholdBytes = (parseInt(process.env.MEMORY_GC_THRESHOLD_MB, 10) || 1024) * 1024 * 1024;
    this.warnThresholdBytes = (parseInt(process.env.MEMORY_WARN_THRESHOLD_MB, 10) || 2048) * 1024 * 1024;
    this._lastWarningTime = 0;
    this._lastRestartTime = 0;
    this._monitorInterval = null;
  }

  startMemoryMonitoring() {
    this._monitorInterval = setInterval(() => this._checkMemory(), MEMORY_CHECK_INTERVAL_MS);
    // Don't block process exit
    if (this._monitorInterval.unref) this._monitorInterval.unref();
  }

  stopMemoryMonitoring() {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
      this._monitorInterval = null;
    }
  }

  _checkMemory() {
    const mem = process.memoryUsage();
    const rssMB = (mem.rss / (1024 * 1024)).toFixed(1);
    const heapMB = (mem.heapUsed / (1024 * 1024)).toFixed(1);

    // Schedule GC via setImmediate so in-flight I/O (WebSocket frames, HTTP responses)
    // drains first. global.gc() is synchronous and can stall the event loop 100-300ms.
    if (mem.rss > this.gcThresholdBytes && typeof global.gc === 'function') {
      console.log(`[memory] RSS ${rssMB} MB exceeds GC threshold, scheduling garbage collection...`);
      setImmediate(() => this._runGc());
    }

    // Notify user when RSS exceeds warning threshold (throttled)
    if (mem.rss > this.warnThresholdBytes) {
      const now = Date.now();
      if (now - this._lastWarningTime >= NOTIFICATION_THROTTLE_MS) {
        this._lastWarningTime = now;
        console.warn(`[memory] RSS ${rssMB} MB exceeds warning threshold (${(this.warnThresholdBytes / (1024 * 1024)).toFixed(0)} MB). Notifying clients.`);
        this.server.broadcastToAll({
          type: 'memory_warning',
          rss: `${rssMB} MB`,
          rssBytes: mem.rss,
          heapUsed: `${heapMB} MB`,
          heapUsedBytes: mem.heapUsed,
          threshold: `${(this.warnThresholdBytes / (1024 * 1024)).toFixed(0)} MB`,
          supervised: this.server.supervised
        });
      }
    }
  }

  _runGc() {
    const before = process.memoryUsage().rss;
    // Try minor GC first (young generation, ~5ms)
    try { global.gc({ type: 'minor' }); } catch (_) { /* ignore */ }

    const afterMinor = process.memoryUsage().rss;
    if (afterMinor > this.gcThresholdBytes) {
      // Minor GC wasn't enough, do full GC (~100-300ms)
      try { global.gc(); } catch (_) { /* ignore */ }
    }

    const after = process.memoryUsage().rss;
    const reclaimedMB = ((before - after) / (1024 * 1024)).toFixed(1);
    console.log(`[memory] GC complete. Reclaimed ${reclaimedMB} MB. RSS: ${(after / (1024 * 1024)).toFixed(1)} MB`);
  }

  async initiateRestart(reason = 'manual') {
    // Guard: reuse the server's existing shutdown guard
    if (this.server.isShuttingDown) {
      console.log('[restart] Already shutting down, ignoring restart request');
      return 'already_shutting_down';
    }

    // Rate limit: prevent restart-loop DoS
    const now = Date.now();
    if (now - this._lastRestartTime < MIN_RESTART_INTERVAL_MS) {
      const waitSec = Math.ceil((MIN_RESTART_INTERVAL_MS - (now - this._lastRestartTime)) / 1000);
      console.log(`[restart] Rate limited, ${waitSec}s remaining before next restart allowed`);
      return 'rate_limited';
    }
    this._lastRestartTime = now;

    console.log(`[restart] Initiating restart (reason: ${reason})`);

    // Broadcast restart notification to all clients before shutdown begins.
    // Wrapped in try/catch: a throw here (e.g., half-closed socket) must not
    // abort the restart — the broadcast is best-effort, the shutdown is mandatory.
    try {
      this.server.broadcastToAll({
        type: 'server_restarting',
        reason
      });
    } catch (e) {
      console.warn('[restart] Failed to broadcast restart notification:', e.message);
    }

    // Brief wait for WebSocket frames to be delivered
    await new Promise(r => setTimeout(r, RESTART_BROADCAST_DELAY_MS));

    // Delegate to the server's single shutdown path with restart exit code
    await this.server.handleShutdown(RESTART_EXIT_CODE);
    return 'restarting';
  }
}

module.exports = RestartManager;
module.exports.RESTART_EXIT_CODE = RESTART_EXIT_CODE;
module.exports.MEMORY_CHECK_INTERVAL_MS = MEMORY_CHECK_INTERVAL_MS;
module.exports.NOTIFICATION_THROTTLE_MS = NOTIFICATION_THROTTLE_MS;
module.exports.MIN_RESTART_INTERVAL_MS = MIN_RESTART_INTERVAL_MS;
