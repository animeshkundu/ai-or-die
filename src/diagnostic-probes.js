'use strict';

const fs = require('fs');
const path = require('path');
const v8 = require('v8');

const MB = 1024 * 1024;
const DEFAULT_SNAPSHOT_HEAP_CEILING_MB = 768;
const DEFAULT_SNAPSHOT_COUNT_CAP = 3;
const DEFAULT_SNAPSHOT_BYTES_CAP = 2 * 1024 * MB;

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items || []) {
    const key = keyFn(item) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function byteLength(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function collectOutputBuffers(sessions) {
  let retainedBytes = 0;
  let retainedEntries = 0;
  let backingSlots = 0;
  let pendingBytes = 0;
  let pendingChunks = 0;
  let bytesTrackingComplete = true;

  for (const session of sessions.values()) {
    const output = session && session.outputBuffer;
    if (output) {
      backingSlots += Number(output.capacity) || (Array.isArray(output.buffer) ? output.buffer.length : 0);
      if (output._trackBytes && typeof output.byteSize === 'number') {
        retainedEntries += Number(output.length) || 0;
        retainedBytes += output.byteSize;
      } else {
        const length = Number(output.length) || 0;
        retainedEntries += length;
        if (length > 0) bytesTrackingComplete = false;
      }
    }
    if (session && Array.isArray(session._pendingChunks)) {
      pendingChunks += session._pendingChunks.length;
      pendingBytes += Number(session._pendingBytes) || 0;
    }
  }

  return {
    retained_bytes: bytesTrackingComplete ? retainedBytes : null,
    bytes_tracking_complete: bytesTrackingComplete,
    retained_entries: retainedEntries,
    backing_slots: backingSlots,
    pending_bytes: pendingBytes,
    pending_chunks: pendingChunks,
  };
}

function collectArtifactReviews(store) {
  const reviews = store && store._reviews instanceof Map ? store._reviews : new Map();
  let queuedPrompts = 0;
  let queuedPromptBytes = 0;
  let chatEntries = 0;
  let chatBytes = 0;
  let replayEvents = 0;
  let domSnapshotBytes = 0;
  let ended = 0;

  for (const review of reviews.values()) {
    if (!review) continue;
    if (review.status === 'ended') ended++;
    const prompts = Array.isArray(review.queuedPrompts) ? review.queuedPrompts : [];
    queuedPrompts += prompts.length;
    queuedPromptBytes += Number(review._diagnosticQueuedPromptBytes) || 0;
    const chat = Array.isArray(review.chat) ? review.chat : [];
    chatEntries += chat.length;
    chatBytes += Number(review._diagnosticChatBytes) || 0;
    replayEvents += Array.isArray(review.events) ? review.events.length : 0;
    domSnapshotBytes += Number(review._diagnosticDomSnapshotBytes) || 0;
  }

  return {
    total: reviews.size,
    ended,
    queued_prompts: queuedPrompts,
    queued_prompt_bytes: queuedPromptBytes,
    chat_entries: chatEntries,
    chat_bytes: chatBytes,
    replay_events: replayEvents,
    dom_snapshot_bytes: domSnapshotBytes,
  };
}

function collectSticky(server) {
  const summarizer = server.stickyNoteSummarizer;
  const states = summarizer && summarizer._states instanceof Map
    ? summarizer._states
    : new Map();
  let pendingTextBytes = 0;
  let pendingSessions = 0;
  let inFlight = 0;
  for (const state of states.values()) {
    if (!state) continue;
    const bytes = byteLength(state.pendingText);
    pendingTextBytes += bytes;
    if (bytes > 0) pendingSessions++;
    if (state.inFlight) inFlight++;
  }

  const stickyEngine = server.stickyNoteEngine;
  const sttEngine = server.sttEngine;
  return {
    jsonl_bindings: server._stickyJsonl instanceof Map ? server._stickyJsonl.size : 0,
    offsets: server._claudeOffsets instanceof Map ? server._claudeOffsets.size : 0,
    active_viewers: server._stickyActive instanceof Map ? server._stickyActive.size : 0,
    summarizer_states: states.size,
    summarizer_pending: summarizer && summarizer._pending instanceof Map ? summarizer._pending.size : 0,
    pending_text_bytes: pendingTextBytes,
    pending_text_sessions: pendingSessions,
    in_flight: inFlight,
    engine: {
      status: stickyEngine && typeof stickyEngine.getStatus === 'function'
        ? stickyEngine.getStatus()
        : null,
      queue: stickyEngine && Array.isArray(stickyEngine._queue) ? stickyEngine._queue.length : 0,
      worker_thread_id: stickyEngine && stickyEngine._worker ? stickyEngine._worker.threadId : null,
      worker: stickyEngine && stickyEngine._workerDiagnostics || null,
    },
    stt: {
      status: sttEngine && typeof sttEngine.getStatus === 'function' ? sttEngine.getStatus() : sttEngine && sttEngine._status,
      queue: sttEngine && Array.isArray(sttEngine._queue) ? sttEngine._queue.length : 0,
      worker_thread_id: sttEngine && sttEngine._worker ? sttEngine._worker.threadId : null,
      worker: sttEngine && sttEngine._workerDiagnostics || null,
    },
  };
}

function collectBridges(server) {
  const out = {};
  for (const name of ['claudeBridge', 'codexBridge', 'copilotBridge', 'geminiBridge', 'terminalBridge']) {
    const bridge = server[name];
    const sessions = bridge && bridge.sessions instanceof Map ? bridge.sessions : new Map();
    let listenerDisposables = 0;
    let jobHandles = 0;
    for (const session of sessions.values()) {
      listenerDisposables += Array.isArray(session && session._ptyDisposables)
        ? session._ptyDisposables.length
        : 0;
      if (session && session.jobHandle) jobHandles++;
    }
    out[name] = {
      sessions: sessions.size,
      listener_disposables: listenerDisposables,
      job_handles: jobHandles,
    };
  }
  return out;
}

function collectTunnelState(server) {
  const vscode = server.vscodeTunnel;
  const tunnels = vscode && vscode.tunnels instanceof Map ? vscode.tunnels : new Map();
  let serverStdoutChars = 0;
  let liveChildren = 0;
  let restartTimers = 0;
  for (const tunnel of tunnels.values()) {
    serverStdoutChars += Number(tunnel && tunnel._diagnosticServerStdoutChars) || 0;
    if (tunnel && tunnel.serverProcess) liveChildren++;
    if (tunnel && tunnel.tunnelProcess) liveChildren++;
    if (tunnel && tunnel._loginProcess) liveChildren++;
    if (tunnel && (tunnel._restartDelayTimer || tunnel._stabilityTimer)) restartTimers++;
  }

  return {
    vscode: {
      tunnels: tunnels.size,
      live_children: liveChildren,
      restart_timers: restartTimers,
      retained_server_stdout_chars: serverStdoutChars,
    },
    app_tunnel: server.tunnelManager ? {
      live_child: !!server.tunnelManager.process,
      restart_timer: !!server.tunnelManager._restartDelayTimer,
    } : null,
    mesh: server.meshManager ? {
      live_child: !!server.meshManager._process,
      stdout_buffer_bytes: byteLength(server.meshManager._stdoutBuffer),
      restart_timer: !!server.meshManager._restartDelayTimer,
    } : null,
    keepalive: {
      live_child: !!(server.keepaliveManager && server.keepaliveManager._child),
    },
  };
}

function collectLibuvHandles() {
  try {
    const report = process.report && process.report.getReport
      ? process.report.getReport()
      : null;
    const libuv = report && Array.isArray(report.libuv) ? report.libuv : [];
    return {
      total: libuv.length,
      by_type: countBy(libuv, (entry) => entry && entry.type),
      active_by_type: countBy(libuv.filter((entry) => entry && entry.is_active), (entry) => entry.type),
    };
  } catch (error) {
    return { total: null, by_type: {}, active_by_type: {}, error: error.code || error.message };
  }
}

function collectCounters(server) {
  const mem = process.memoryUsage();
  const handles = (process._getActiveHandles && process._getActiveHandles()) || [];
  const requests = (process._getActiveRequests && process._getActiveRequests()) || [];
  const sessions = server.claudeSessions instanceof Map ? server.claudeSessions : new Map();
  let connections = 0;
  let outputFlushTimers = 0;
  for (const session of sessions.values()) {
    connections += session && session.connections instanceof Set ? session.connections.size : 0;
    if (session && session._outputFlushTimer) outputFlushTimers++;
  }

  const usageReader = server.usageReader;
  const usageAnalytics = server.usageAnalytics;
  const eventBus = server.controlEventBus;
  return {
    captured_at: new Date().toISOString(),
    process: {
      pid: process.pid,
      ppid: process.ppid,
      thread_id: 0,
      uptime_seconds: process.uptime(),
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: mem,
      heap_statistics: v8.getHeapStatistics(),
      heap_spaces: v8.getHeapSpaceStatistics(),
      active_handles: handles.length,
      active_handles_by_type: countBy(handles, (handle) => handle && handle.constructor && handle.constructor.name),
      active_requests: requests.length,
      active_requests_by_type: countBy(requests, (request) => request && request.constructor && request.constructor.name),
      libuv: collectLibuvHandles(),
      listeners: countBy(process.eventNames().flatMap((name) =>
        new Array(process.listenerCount(name)).fill(name)), (name) => String(name)),
    },
    sessions: {
      total: sessions.size,
      connected_clients: connections,
      ws_connections: server.webSocketConnections instanceof Map ? server.webSocketConnections.size : 0,
      output_flush_timers: outputFlushTimers,
      output_buffers: collectOutputBuffers(sessions),
      eviction_heap: server._evictionHeap ? server._evictionHeap.size : 0,
      activity_timestamps: server.activityBroadcastTimestamps instanceof Map
        ? server.activityBroadcastTimestamps.size
        : 0,
      control_session_seq: server._controlSessionSeq instanceof Map ? server._controlSessionSeq.size : 0,
      control_idempotency: server._controlIdempotency instanceof Map ? server._controlIdempotency.size : 0,
    },
    websocket: {
      server_clients: server.wss && server.wss.clients ? server.wss.clients.size : 0,
      aggregate_listeners: (() => {
        const totals = {};
        if (!(server.webSocketConnections instanceof Map)) return totals;
        for (const info of server.webSocketConnections.values()) {
          if (!info || !info.ws || typeof info.ws.eventNames !== 'function') continue;
          for (const name of info.ws.eventNames()) {
            totals[name] = (totals[name] || 0) + info.ws.listenerCount(name);
          }
        }
        return totals;
      })(),
    },
    bridges: collectBridges(server),
    persistence: server.sessionStore ? {
      ...(server.sessionStore._diagnostics || {}),
      writes_disabled: server._diagnosticPersistenceDisabled === true,
      auto_save_ticks: Number(server._diagnosticAutoSaveTicks) || 0,
    } : null,
    artifact_reviews: collectArtifactReviews(server.artifactReviews),
    sticky_notes: collectSticky(server),
    usage: {
      reader_cache_present: !!(usageReader && usageReader.cache),
      reader_overlapping_sessions: usageReader && Array.isArray(usageReader.overlappingSessions)
        ? usageReader.overlappingSessions.length
        : 0,
      analytics_active_sessions: usageAnalytics && usageAnalytics.activeSessions instanceof Map
        ? usageAnalytics.activeSessions.size
        : 0,
      analytics_session_history: usageAnalytics && Array.isArray(usageAnalytics.sessionHistory)
        ? usageAnalytics.sessionHistory.length
        : 0,
      analytics_recent_usage: usageAnalytics && Array.isArray(usageAnalytics.recentUsage)
        ? usageAnalytics.recentUsage.length
        : 0,
      analytics_historical_data: usageAnalytics && Array.isArray(usageAnalytics.historicalData)
        ? usageAnalytics.historicalData.length
        : 0,
      analytics_burn_rate_history: usageAnalytics && Array.isArray(usageAnalytics.burnRateHistory)
        ? usageAnalytics.burnRateHistory.length
        : 0,
    },
    control_event_bus: {
      buckets: eventBus && eventBus._buckets instanceof Map ? eventBus._buckets.size : 0,
      retained_events: eventBus && typeof eventBus.listEvents === 'function' ? eventBus.listEvents().length : 0,
      evicted_session_watermarks: eventBus && eventBus._evictedBySession instanceof Map
        ? eventBus._evictedBySession.size
        : 0,
      listeners: eventBus && typeof eventBus.listenerCount === 'function'
        ? eventBus.listenerCount('event')
        : 0,
    },
    tunnels: collectTunnelState(server),
  };
}

function forceGcTwice() {
  if (typeof global.gc !== 'function') return false;
  global.gc();
  global.gc();
  return true;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalizeProspectivePath(candidate) {
  const missing = [];
  let cursor = path.resolve(candidate);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const realpath = fs.realpathSync.native || fs.realpathSync;
  const canonicalBase = realpath(cursor);
  return path.join(canonicalBase, ...missing);
}

function deleteSnapshotFile(file, io = fs) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      io.unlinkSync(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      lastError = error;
    }
    if (!io.existsSync(file)) return;
  }
  const error = new Error('over-cap heap snapshot could not be deleted');
  error.code = lastError && lastError.code || 'SNAPSHOT_CLEANUP_FAILED';
  throw error;
}

function installDiagnosticRoutes(server) {
  if (process.env.AOD_DIAG_ENABLED !== '1') return false;
  const token = process.env.AOD_DIAG_TOKEN;
  if (typeof token !== 'string' || token.length < 16) return false;

  server._diagnosticPersistenceDisabled =
    process.env.AOD_DIAG_DISABLE_PERSISTENCE === '1';
  server._diagnosticAutoSaveTicks = 0;
  const snapshotRoot = process.env.AOD_DIAG_SNAPSHOT_DIR
    ? path.resolve(process.env.AOD_DIAG_SNAPSHOT_DIR)
    : null;
  const snapshotHeapCeilingMb =
    Number(process.env.AOD_DIAG_SNAPSHOT_HEAP_CEILING_MB) ||
    DEFAULT_SNAPSHOT_HEAP_CEILING_MB;
  const snapshotCountCap =
    Number(process.env.AOD_DIAG_SNAPSHOT_COUNT_CAP) ||
    DEFAULT_SNAPSHOT_COUNT_CAP;
  const snapshotBytesCap =
    Number(process.env.AOD_DIAG_SNAPSHOT_BYTES_CAP) ||
    DEFAULT_SNAPSHOT_BYTES_CAP;
  const state = {
    snapshot_count: 0,
    snapshot_bytes: 0,
  };

  const authenticate = (req, res, next) => {
    const header = req.headers['x-aod-diag-token'];
    const bearer = typeof req.headers.authorization === 'string' &&
      req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;
    const supplied = header || bearer;
    const suppliedBuffer = typeof supplied === 'string' ? Buffer.from(supplied) : null;
    const tokenBuffer = Buffer.from(token);
    if (!suppliedBuffer ||
        suppliedBuffer.length !== tokenBuffer.length ||
        !require('crypto').timingSafeEqual(suppliedBuffer, tokenBuffer)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };

  server.app.get('/api/_diag/counters', authenticate, async (req, res) => {
    await Promise.allSettled([
      server.stickyNoteEngine && typeof server.stickyNoteEngine.requestDiagnostics === 'function'
        ? server.stickyNoteEngine.requestDiagnostics()
        : null,
      server.sttEngine && typeof server.sttEngine.requestDiagnostics === 'function'
        ? server.sttEngine.requestDiagnostics()
        : null,
    ]);
    res.json(collectCounters(server));
  });

  server.app.post('/api/_diag/gc', authenticate, (req, res) => {
    if (!forceGcTwice()) {
      return res.status(501).json({ error: 'global.gc unavailable; start through bin/supervisor.js' });
    }
    res.json(collectCounters(server));
  });

  server.app.post('/api/_diag/heapsnapshot', authenticate, (req, res) => {
    if (!snapshotRoot) {
      return res.status(503).json({ error: 'AOD_DIAG_SNAPSHOT_DIR is required' });
    }
    const usedMb = v8.getHeapStatistics().used_heap_size / MB;
    if (usedMb > snapshotHeapCeilingMb) {
      return res.status(413).json({
        error: 'heap snapshot preflight ceiling exceeded',
        used_heap_mb: +usedMb.toFixed(1),
        ceiling_mb: snapshotHeapCeilingMb,
      });
    }

    if (state.snapshot_count >= snapshotCountCap || state.snapshot_bytes >= snapshotBytesCap) {
      return res.status(429).json({ error: 'heap snapshot artifact cap reached' });
    }

    const requestedDir = req.body && req.body.directory
      ? path.resolve(String(req.body.directory))
      : snapshotRoot;
    let canonicalRoot;
    let canonicalRequested;
    try {
      fs.mkdirSync(snapshotRoot, { recursive: true });
      canonicalRoot = canonicalizeProspectivePath(snapshotRoot);
      canonicalRequested = canonicalizeProspectivePath(requestedDir);
    } catch (error) {
      return res.status(500).json({ error: error.code || error.message });
    }
    if (!isWithin(canonicalRoot, canonicalRequested)) {
      return res.status(403).json({ error: 'snapshot directory is outside AOD_DIAG_SNAPSHOT_DIR' });
    }

    try {
      fs.mkdirSync(canonicalRequested, { recursive: true });
      forceGcTwice();
      const file = path.join(canonicalRequested, `Heap-${process.pid}-${Date.now()}.heapsnapshot`);
      const written = v8.writeHeapSnapshot(file);
      const bytes = fs.statSync(written).size;
      if (state.snapshot_bytes + bytes > snapshotBytesCap) {
        deleteSnapshotFile(written);
        return res.status(413).json({
          error: 'heap snapshot artifact byte cap exceeded',
          bytes,
          snapshot_bytes: state.snapshot_bytes,
          bytes_cap: snapshotBytesCap,
        });
      }
      state.snapshot_count++;
      state.snapshot_bytes += bytes;
      res.json({
        path: written,
        bytes,
        snapshot_count: state.snapshot_count,
        snapshot_bytes: state.snapshot_bytes,
      });
    } catch (error) {
      res.status(500).json({ error: error.code || error.message });
    }
  });

  return true;
}

module.exports = {
  collectCounters,
  deleteSnapshotFile,
  forceGcTwice,
  installDiagnosticRoutes,
};
