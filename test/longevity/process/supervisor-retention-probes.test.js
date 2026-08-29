'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const CircularBuffer = require('../../../src/utils/circular-buffer');
const StickyNoteSummarizer = require('../../../src/sticky-note-summarizer');
const UsageReader = require('../../../src/usage-reader');
const UsageAnalytics = require('../../../src/usage-analytics');
const { ArtifactReviewStore } = require('../../../src/artifact-review');
const BaseBridge = require('../../../src/base-bridge');
const TerminalBridge = require('../../../src/terminal-bridge');
const ClaudeBridge = require('../../../src/claude-bridge');
const { ControlEventBus } = require('../../../src/control/event-bus');

const SESSION_OUTPUT_BUFFER_MAX_BYTES = CircularBuffer.LIVE_OUTPUT_MAX_BYTES;

let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../../../src/server'));
} catch (_) {
  // The suite is skipped on environments where the optional native PTY binding
  // cannot load, matching the existing process-longevity suites.
}

function stopServerTimers(server) {
  for (const key of [
    'autoSaveInterval',
    'imageSweepInterval',
    'sessionEvictionInterval',
    'diagnosticsHeartbeatInterval',
    'diskCompactInterval',
    'diskUsageSampleInterval',
    '_stickyJsonlPoll',
    '_wsKeepalive',
  ]) {
    if (server[key]) clearInterval(server[key]);
  }
  if (server.restartManager) server.restartManager.stopMemoryMonitoring();
}

async function makeServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-retention-'));
  const server = new ClaudeCodeWebServer({
    port: 0,
    noAuth: true,
    sessionStoreOptions: { storageDir: path.join(tempDir, 'sessions') },
  });
  await server._sessionsLoaded;
  stopServerTimers(server);
  return { server, tempDir };
}

function makeSession(id, active = false) {
  return {
    id,
    name: id,
    created: new Date(),
    lastActivity: new Date(),
    active,
    agent: null,
    workingDir: process.cwd(),
    connections: new Set(),
    outputBuffer: new CircularBuffer(1000, SESSION_OUTPUT_BUFFER_MAX_BYTES),
    priority: 'foreground',
    stickyNotesEnabled: false,
  };
}

function makeChunk(index, bytes) {
  const prefix = `chunk-${index.toString().padStart(4, '0')}:`;
  return prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix));
}

function chunkIndex(chunk) {
  const match = /^chunk-(\d+):/.exec(chunk);
  return match ? Number(match[1]) : null;
}

function waitForBridgeExit(bridge, sessionId, options = {}) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error(`PTY ${sessionId} did not exit`)), 10000);
    bridge.startSession(sessionId, {
      workingDir: options.workingDir || os.tmpdir(),
      onOutput: options.onOutput || (() => {}),
      onCwdChange: options.onCwdChange,
      onExit: (code, signal) => {
        clearTimeout(timer);
        timer = null;
        resolve({ code, signal });
      },
      onError: (error) => {
        clearTimeout(timer);
        timer = null;
        reject(error);
      },
    }).catch((error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
  });
}

(ClaudeCodeWebServer ? describe : describe.skip)('supervisor retention probes', function () {
  this.timeout(120000);

  let server;
  let tempDir;

  before(async function () {
    ({ server, tempDir } = await makeServer());
  });

  beforeEach(function () {
    for (const sessionId of server.stickyNoteSummarizer._states.keys()) {
      server.stickyNoteSummarizer.cancel(sessionId);
    }
    server.claudeSessions.clear();
    server.webSocketConnections.clear();
    server._evictionHeap.clear();
    server._controlIdempotency.clear();
    server._controlSessionSeq.clear();
    server._stickyJsonl.clear();
    server._claudeNotes.clear();
    server._claudeOffsets.clear();
    server._stickyActive.clear();
    server.activityBroadcastTimestamps.clear();
    if (server._attachmentDirCache) server._attachmentDirCache.clear();
    if (server._steeringQueues) server._steeringQueues.clear();
    server._retentionByteMetricsCache = null;
    server.artifactReviews = new ArtifactReviewStore();
    server.controlEventBus = new ControlEventBus();
    server.usageReader = new UsageReader(5);
    server.usageAnalytics = new UsageAnalytics({ sessionDurationHours: 5 });
  });

  after(async function () {
    if (server) {
      stopServerTimers(server);
      for (const sessionId of server.stickyNoteSummarizer._states.keys()) {
        server.stickyNoteSummarizer.cancel(sessionId);
      }
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports additive retention diagnostics without changing the existing contract', function () {
    const active = makeSession('active', true);
    active.outputBuffer.push('active output');
    const inactive = makeSession('inactive', false);
    inactive.outputBuffer.push('inactive output');
    server.claudeSessions.set(active.id, active);
    server.claudeSessions.set(inactive.id, inactive);

    server.stickyNoteSummarizer.enable('sticky');
    server.stickyNoteSummarizer.feedTurns('sticky', 'pending transcript');
    server.artifactReviews.open('review', path.join(tempDir, 'artifact.html'));
    server.artifactReviews.queuePrompts('review', [{ prompt: 'inspect this' }], '<main>snapshot</main>');
    server.usageReader.cache = { requests: 3 };
    server.usageReader.cacheTime = Date.now() - 10;

    const diagnostics = server._collectDiagnostics();

    assert.strictEqual(typeof diagnostics.memory.heap_used_mb, 'number');
    assert.strictEqual(typeof diagnostics.process.active_handles, 'number');
    assert.strictEqual(typeof diagnostics.process.listener_counts.SIGINT, 'number');
    assert.strictEqual(typeof diagnostics.sessions.total, 'number');
    assert.strictEqual(diagnostics.retention.output_buffers.active.sessions, 1);
    assert.strictEqual(diagnostics.retention.output_buffers.inactive.sessions, 1);
    assert.strictEqual(diagnostics.retention.output_buffers.active.per_session[0].items, 1);
    assert.strictEqual(diagnostics.retention.sticky_pending_text.sessions, 1);
    assert.strictEqual(diagnostics.retention.artifact_reviews.total, 1);
    assert.strictEqual(diagnostics.retention.usage_reader.cache_entry_count, 3);
    assert.strictEqual(typeof diagnostics.retention.bridge_state.terminal_osc7_parsers, 'number');
    assert.strictEqual(typeof diagnostics.retention.control_event_bus.evicted_session_watermarks, 'number');
    assert.strictEqual(typeof diagnostics.retention.websocket.message, 'number');
    assert.strictEqual(typeof diagnostics.retention.timers.server_intervals, 'number');
    assert.strictEqual(typeof diagnostics.retention.workers.sticky_note.queue_length, 'number');
    assert.strictEqual(typeof diagnostics.retention.maps.claude_notes, 'number');
    assert.ok(
      diagnostics.process.windows_handle_count === null ||
      Number.isInteger(diagnostics.process.windows_handle_count),
      'Windows native handle count must be an integer when PowerShell can sample it'
    );
  });

  it('proves the real PTY onOutput sink keeps a newline-free tail capped at 512 KiB', async function () {
    const sessionId = 'pty-chunk-bound';
    const session = makeSession(sessionId);
    server.claudeSessions.set(sessionId, session);
    server.webSocketConnections.set('ws-probe', {
      claudeSessionId: sessionId,
      ws: { readyState: 1, send() {} },
    });
    let callbacks;
    const bridge = {
      _commandReady: Promise.resolve(),
      isAvailable: () => true,
      startSession: async (_id, options) => { callbacks = options; },
    };

    await server.startToolSession('ws-probe', 'terminal', bridge, {}, 80, 24);
    if (session._ctlTranscript) {
      session._ctlTranscript.dispose();
      session._ctlTranscript = null;
    }

    const chunkBytes = 64 * 1024;
    for (let index = 0; index < 1000; index++) {
      callbacks.onOutput(makeChunk(index, chunkBytes));
    }

    const retained = session.outputBuffer.toArray();
    const retainedIndexes = retained.map((chunk) => chunkIndex(chunk));
    const expectedStart = 1000 - retained.length;
    const expectedIndexes = Array.from({ length: retained.length }, (_, i) => expectedStart + i);

    const diagnostics = server._collectDiagnostics();
    const measured = diagnostics.retention.output_buffers.active.per_session[0];
    assert.ok(measured.items > 0 && measured.items < 1000, 'byte cap trims the newest tail before item capacity is reached');
    assert.ok(measured.bytes <= SESSION_OUTPUT_BUFFER_MAX_BYTES, 'live output tail is capped at 512 KiB');
    assert.deepStrictEqual(retainedIndexes, expectedIndexes, 'retained chunks are the newest suffix by chunk index');
    assert.ok(
      session.outputBuffer.toArray().every((chunk) => !chunk.includes('\n')),
      'the proving stream has no lines, so this is the real newline-free PTY path'
    );
    callbacks.onExit(0, null);
    server._retentionByteMetricsCache = null;
    const afterExit = server._collectDiagnostics().retention.output_buffers.inactive.per_session[0];
    assert.ok(afterExit.bytes <= SESSION_OUTPUT_BUFFER_MAX_BYTES, 'inactive session still retains a bounded tail');
    assert.strictEqual(afterExit.bytes, measured.bytes, 'natural exit keeps the bounded tail reachable');
  });

  it('caps a single coalesced onOutput chunk to the newest <=512 KiB suffix', async function () {
    const sessionId = 'pty-oversized-chunk';
    const session = makeSession(sessionId);
    server.claudeSessions.set(sessionId, session);
    server.webSocketConnections.set('ws-oversized', {
      claudeSessionId: sessionId,
      ws: { readyState: 1, send() {} },
    });
    let callbacks;
    const bridge = {
      _commandReady: Promise.resolve(),
      isAvailable: () => true,
      startSession: async (_id, options) => { callbacks = options; },
    };

    await server.startToolSession('ws-oversized', 'terminal', bridge, {}, 80, 24);
    if (session._ctlTranscript) {
      session._ctlTranscript.dispose();
      session._ctlTranscript = null;
    }

    const oversized = 'prefix-' + 'x'.repeat(700 * 1024) + '-tail';
    callbacks.onOutput(oversized);

    const retained = session.outputBuffer.toArray();
    assert.strictEqual(retained.length, 1, 'single oversized coalesced write remains one capped chunk');
    const stored = retained[0];
    assert.ok(Buffer.byteLength(stored, 'utf8') <= SESSION_OUTPUT_BUFFER_MAX_BYTES);
    assert.strictEqual(stored, oversized.slice(oversized.length - stored.length), 'stored output is the newest suffix');
    assert.ok(stored.endsWith('-tail'));

    callbacks.onExit(0, null);
  });

  it('keeps inactive exited-session buffers reachable as bounded tails until the seven-day eviction threshold', async function () {
    const sessionCount = 8;
    const chunksPerSession = 20;
    const chunkBytes = 64 * 1024;
    for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex++) {
      const session = makeSession(`dead-${sessionIndex}`, false);
      for (let chunkIndex = 0; chunkIndex < chunksPerSession; chunkIndex++) {
        session.outputBuffer.push(makeChunk(sessionIndex * chunksPerSession + chunkIndex, chunkBytes));
      }
      server.claudeSessions.set(session.id, session);
      server._pushEvictionEntry(session.id);
    }

    const before = server._collectDiagnostics().retention.output_buffers.inactive;
    const evicted = await server._evictStaleSessions();
    const after = server._collectDiagnostics().retention.output_buffers.inactive;

    assert.strictEqual(evicted, 0, 'freshly exited sessions do not meet the seven-day eviction threshold');
    assert.strictEqual(after.sessions, sessionCount);
    assert.strictEqual(after.bytes, before.bytes);
    assert.strictEqual(after.bytes, sessionCount * SESSION_OUTPUT_BUFFER_MAX_BYTES);
    assert.ok(after.per_session.every((entry) => entry.bytes <= SESSION_OUTPUT_BUFFER_MAX_BYTES));
  });

  it('retains unbounded pending transcript text while JSONL summary inference cannot run', function () {
    const summarizer = new StickyNoteSummarizer({
      engine: {
        isReady: () => false,
        getStatus: () => 'unavailable',
      },
      timers: { set: () => null, clear: () => {} },
    });
    summarizer.enable('pending');

    const chunks = 32;
    const chunkBytes = 64 * 1024;
    for (let index = 0; index < chunks; index++) {
      summarizer.feedTurns('pending', makeChunk(index, chunkBytes));
    }
    summarizer._attempt('pending', 'turn');

    const state = summarizer._states.get('pending');
    const expectedLowerBound = chunks * chunkBytes;
    assert.ok(
      Buffer.byteLength(state.pendingText, 'utf8') >= expectedLowerBound,
      'pendingText has no byte cap and is not drained while inference is unavailable'
    );
    assert.strictEqual(state.needsSummary, true);
    summarizer.cancel('pending');
  });

  it('materializes every matching usage JSONL entry per read but does not retain that array in the reader cache', async function () {
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-reader-retention-'));
    const projectDir = path.join(projectsRoot, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, 'usage.jsonl');
    const entries = 12000;
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-01T00:00:00.000Z',
      message: {
        id: 'message',
        role: 'assistant',
        model: 'sonnet',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      filler: 'x'.repeat(256),
    }) + '\n';
    fs.writeFileSync(file, line.repeat(entries));
    const reader = new UsageReader({ claudeProjectsPath: projectsRoot });

    try {
      const all = await reader.readAllEntries(new Date(0));
      const stats = await reader.getAllTimeUsageStats();
      const extractedBytes = all.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)), 0);
      assert.strictEqual(all.length, entries, 'readAllEntries returns one in-memory object per log entry');
      assert.strictEqual(stats.requests, entries);
      assert.ok(extractedBytes > 1024 * 1024, 'the transient aggregate contains megabytes of extracted objects');
      assert.strictEqual(reader.cache, null, 'all-time reads do not retain the materialized entry array in the five-second cache');
    } finally {
      fs.rmSync(projectsRoot, { recursive: true, force: true });
    }
  });

  it('grows UsageAnalytics.activeSessions for every unique queried usage session because the server never invokes cleanup', async function () {
    const current = {
      sessionId: 'usage-0',
      sessionStartTime: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0,
      models: {},
      sessionNumber: 1,
    };
    server.usageReader = {
      getCurrentSessionStats: async () => current,
      calculateBurnRate: async () => ({ rate: 0, confidence: 0, dataPoints: 0 }),
      detectOverlappingSessions: async () => [],
      getUsageStats: async () => ({ requests: 0 }),
    };
    const wsInfo = { ws: { readyState: 1, send() {} } };

    for (let index = 0; index < 256; index++) {
      current.sessionId = `usage-${index}`;
      await server.handleGetUsage(wsInfo);
    }

    const analytics = server._collectDiagnostics().retention.usage_analytics;
    assert.strictEqual(analytics.active_sessions, 256);
    assert.strictEqual(analytics.historical_data, 0, 'historicalData is not populated by the production usage path');
  });

  it('retains ended artifact reviews, DOM snapshots, and an uncapped chat array in the process-wide review Map', function () {
    const store = new ArtifactReviewStore();
    const sessionId = 'artifact-retention';
    store.open(sessionId, path.join(tempDir, 'artifact.html'));
    store.queuePrompts(sessionId, [{ prompt: 'review payload' }], '<main>' + 'x'.repeat(512 * 1024) + '</main>');
    for (let index = 0; index < 256; index++) {
      store.addAgentReply(sessionId, `reply-${index}:${'y'.repeat(4096)}`);
    }
    store.end(sessionId);
    server.artifactReviews = store;

    const diagnostics = server._collectDiagnostics().retention.artifact_reviews;
    const review = store.get(sessionId);
    assert.strictEqual(store._reviews.size, 1, 'end() marks the review ended but does not remove it from the Map');
    assert.strictEqual(review.status, 'ended');
    assert.strictEqual(review.chat.length, 256, 'chat has no retention cap even though replay events are capped');
    assert.strictEqual(review.events.length, 200, 'event replay is independently bounded');
    assert.ok(diagnostics.dom_snapshot_bytes >= 512 * 1024);
    assert.ok(diagnostics.chat_bytes > 1024 * 1024);
  });

  it('proves BaseBridge forwards newline-free PTY output as raw batches before the server stores it', async function () {
    const bridge = new BaseBridge('raw-output-probe', {
      launcher: { command: process.execPath, prefixArgs: [] },
    });
    bridge.buildArgs = () => [
      '-e',
      "let n=0;const s='x'.repeat(65536);const t=setInterval(()=>{process.stdout.write(s);if(++n===16){clearInterval(t);setTimeout(()=>process.exit(0),50);}},5);",
    ];
    const output = [];
    try {
      await waitForBridgeExit(bridge, 'raw-output', { onOutput: (chunk) => output.push(chunk) });
      await new Promise((resolve) => setImmediate(resolve));
      const bytes = output.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
      assert.ok(bytes >= 1024 * 1024, `expected at least 1 MiB from the real PTY, got ${bytes}`);
      assert.ok(output.length > 0, 'BaseBridge must invoke its output sink');
      assert.ok(output.some((chunk) => !chunk.includes('\n')), 'the PTY stream includes raw batches without line-boundary splitting');
    } finally {
      await bridge.cleanup();
    }
  });

  it('retains TerminalBridge and ClaudeBridge subclass state after natural PTY exit', async function () {
    const terminal = new TerminalBridge();
    await terminal._commandReady;
    terminal.command = process.execPath;
    terminal.buildArgs = () => ['-e', 'process.exit(0)'];

    const claude = new ClaudeBridge();
    claude.command = process.execPath;
    claude._prefixArgs = [];
    claude.buildArgs = () => ['-e', 'process.exit(0)'];
    const terminalIds = ['terminal-exit-0', 'terminal-exit-1', 'terminal-exit-2'];
    const claudeIds = ['claude-exit-0', 'claude-exit-1', 'claude-exit-2'];

    try {
      for (const id of terminalIds) {
        await waitForBridgeExit(terminal, id, { onCwdChange: () => {} });
      }
      for (const id of claudeIds) {
        claude._trustPromptHandled.set(id, true);
        await waitForBridgeExit(claude, id);
      }

      assert.strictEqual(terminal.sessions.size, 0, 'BaseBridge removed naturally exited PTYs');
      assert.strictEqual(terminal._osc7Parsers.size, terminalIds.length);
      assert.strictEqual(terminal._osc7Hooks.size, terminalIds.length);
      assert.strictEqual(terminal._liveCwd.size, terminalIds.length);
      assert.strictEqual(claude.sessions.size, 0, 'BaseBridge removed naturally exited PTYs');
      assert.strictEqual(claude._trustPromptHandled.size, claudeIds.length);
    } finally {
      for (const id of terminalIds) await terminal.stopSession(id);
      for (const id of claudeIds) await claude.stopSession(id);
      await terminal.cleanup();
      await claude.cleanup();
    }
  });

  it('leaves natural-exit TerminalBridge state reachable after the real DELETE endpoint', async function () {
    const sessionId = 'deleted-inactive-terminal';
    const session = makeSession(sessionId, false);
    session.agent = 'terminal';
    server.claudeSessions.set(sessionId, session);
    server.terminalBridge._installOsc7State(sessionId, { onCwdChange: () => {}, validatePath: () => ({ valid: true }) });
    const httpServer = await new Promise((resolve) => {
      const listener = server.app.listen(0, () => resolve(listener));
    });

    try {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: httpServer.address().port,
          path: `/api/sessions/${sessionId}`,
          method: 'DELETE',
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      });

      assert.strictEqual(status, 200);
      assert.strictEqual(server.claudeSessions.has(sessionId), false);
      assert.strictEqual(server.terminalBridge._osc7Parsers.has(sessionId), true);
      assert.strictEqual(server.terminalBridge._osc7Hooks.has(sessionId), true);
    } finally {
      await new Promise((resolve) => httpServer.close(resolve));
      server.terminalBridge._uninstallOsc7State(sessionId);
    }
  });

  it('retains per-session control bookkeeping after the parent session is evicted', async function () {
    const session = makeSession('expired-control');
    session.lastActivity = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    server.claudeSessions.set(session.id, session);
    server._pushEvictionEntry(session.id);
    server._controlBumpSessionSeq(session.id);

    await server._evictStaleSessions();

    assert.strictEqual(server.claudeSessions.has(session.id), false, 'the parent session was evicted');
    assert.strictEqual(server._controlSessionSeq.get(session.id), 1,
      'the control sequence remains reachable after its parent session is gone');
  });

  it('grows control-event overflow watermarks for evicted session rings', function () {
    server.controlEventBus = new ControlEventBus({ maxEventsPerSession: 1, maxSessions: 1 });
    const sessions = 256;
    for (let index = 0; index < sessions; index++) {
      server.controlEventBus.append(`control-event-${index}`, 'session_created');
    }

    const diagnostics = server._collectDiagnostics().retention.control_event_bus;
    assert.strictEqual(diagnostics.bucket_sessions, 1, 'the event-ring payload is capped to one session');
    assert.strictEqual(diagnostics.evicted_session_watermarks, sessions - 1,
      'one watermark is retained for every discarded session ring');
  });
});
