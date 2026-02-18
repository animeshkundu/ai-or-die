'use strict';

const os = require('os');

const RESTART_EXIT_CODE = 75;
const MEMORY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const NOTIFICATION_THROTTLE_MS = 30 * 60 * 1000; // 30 minutes
const RESTART_BROADCAST_DELAY_MS = 500;
const SERVER_CLOSE_TIMEOUT_MS = 5000;

class RestartManager {
  constructor(server) {
    this.server = server;
    this.gcThresholdBytes = (parseInt(process.env.MEMORY_GC_THRESHOLD_MB, 10) || 1024) * 1024 * 1024;
    this.warnThresholdBytes = (parseInt(process.env.MEMORY_WARN_THRESHOLD_MB, 10) || 2048) * 1024 * 1024;
    this._lastWarningTime = 0;
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

    // Automatic GC when RSS exceeds threshold
    if (mem.rss > this.gcThresholdBytes && typeof global.gc === 'function') {
      console.log(`[memory] RSS ${rssMB} MB exceeds GC threshold, attempting garbage collection...`);
      const before = mem.rss;

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

  async initiateRestart(reason = 'manual') {
    // Guard: prevent double execution
    if (this.server.isShuttingDown) {
      console.log('[restart] Already shutting down, ignoring restart request');
      return;
    }
    this.server.isShuttingDown = true;
    console.log(`[restart] Initiating restart (reason: ${reason})`);

    // Clear all intervals to prevent races
    if (this.server.autoSaveInterval) {
      clearInterval(this.server.autoSaveInterval);
      this.server.autoSaveInterval = null;
    }
    if (this.server.sessionEvictionInterval) {
      clearInterval(this.server.sessionEvictionInterval);
      this.server.sessionEvictionInterval = null;
    }
    if (this.server.imageSweepInterval) {
      clearInterval(this.server.imageSweepInterval);
      this.server.imageSweepInterval = null;
    }
    this.stopMemoryMonitoring();

    // Broadcast restart notification to all clients
    this.server.broadcastToAll({
      type: 'server_restarting',
      reason
    });

    // Wait for message delivery
    await new Promise(r => setTimeout(r, RESTART_BROADCAST_DELAY_MS));

    // Flush pending output timers for all sessions
    for (const [sessionId, session] of this.server.claudeSessions) {
      if (this.server._flushAndClearOutputTimer) {
        this.server._flushAndClearOutputTimer(session, sessionId);
      }
    }

    // Save sessions to disk
    try {
      await this.server.saveSessionsToDisk(true);
      console.log('[restart] Sessions saved to disk');
    } catch (err) {
      console.error('[restart] Failed to save sessions (continuing with last auto-save):', err.message);
    }

    // Stop VS Code tunnels (prevents orphaned child processes)
    if (this.server.vscodeTunnel) {
      try {
        await this.server.vscodeTunnel.stopAll();
      } catch (err) {
        console.warn('[restart] VS Code tunnel cleanup error:', err.message);
      }
    }

    // Stop all PTY processes in parallel — errors don't abort restart
    const bridges = [
      this.server.claudeBridge,
      this.server.codexBridge,
      this.server.copilotBridge,
      this.server.geminiBridge,
      this.server.terminalBridge
    ].filter(Boolean);

    await Promise.allSettled(bridges.map(bridge => {
      return bridge.cleanup().catch(err => {
        console.warn(`[restart] Bridge cleanup error:`, err.message);
      });
    }));
    console.log('[restart] All bridges cleaned up');

    // Close servers with hard timeout
    const exitWithCode = () => {
      console.log(`[restart] Exiting with code ${RESTART_EXIT_CODE}`);
      process.exit(RESTART_EXIT_CODE);
    };

    // Hard timeout: if server.close() hangs, force exit
    const hardTimeout = setTimeout(exitWithCode, SERVER_CLOSE_TIMEOUT_MS);
    hardTimeout.unref();

    try {
      if (this.server.wss) this.server.wss.close();
      if (this.server.server) {
        this.server.server.close(() => {
          clearTimeout(hardTimeout);
          exitWithCode();
        });
      } else {
        clearTimeout(hardTimeout);
        exitWithCode();
      }
    } catch (err) {
      console.error('[restart] Error during server close:', err.message);
      clearTimeout(hardTimeout);
      exitWithCode();
    }
  }
}

module.exports = RestartManager;
module.exports.RESTART_EXIT_CODE = RESTART_EXIT_CODE;
module.exports.MEMORY_CHECK_INTERVAL_MS = MEMORY_CHECK_INTERVAL_MS;
module.exports.NOTIFICATION_THROTTLE_MS = NOTIFICATION_THROTTLE_MS;
