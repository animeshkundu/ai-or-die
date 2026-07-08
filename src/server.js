const express = require('express');
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const search = require('./utils/search');
const FileWatcher = require('./utils/file-watcher');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const ClaudeBridge = require('./claude-bridge');
const { VALID_PERMISSION_MODES } = require('./claude-bridge');
const CodexBridge = require('./codex-bridge');
const CopilotBridge = require('./copilot-bridge');
const GeminiBridge = require('./gemini-bridge');
const TerminalBridge = require('./terminal-bridge');
const SessionStore = require('./utils/session-store');
const { getFileInfo, computeFileHash, isBinaryFile, sanitizeFileName, isBlockedExtension, formatFileSize, normalizePath, BLOCKED_EXTENSIONS } = require('./utils/file-utils');
const UsageReader = require('./usage-reader');
const UsageAnalytics = require('./usage-analytics');
const { VSCodeTunnelManager } = require('./vscode-tunnel');
const InstallAdvisor = require('./install-advisor');
const SttEngine = require('./stt-engine');
const StickyNoteEngine = require('./sticky-note-engine');
const StickyNoteSummarizer = require('./sticky-note-summarizer');
const StickyNoteJsonl = require('./sticky-note-jsonl');
const { redactSecrets } = require('./utils/secret-redact');
const { isBun } = require('./utils/runtime');
const CircularBuffer = require('./utils/circular-buffer');
const MinHeap = require('./utils/eviction-heap');
const RestartManager = require('./restart-manager');
const KeepaliveManager = require('./keepalive-manager');
const { ControlEventBus, EVENT_KINDS: CONTROL_EVENT_KINDS } = require('./control/event-bus');
const TranscriptBuffer = require('./sticky-note-transcript');
const { createControlRouter } = require('./control/routes');
const { ArtifactReviewStore, createArtifactReviewRouter, createAssetTokenSigner, buildArtifactPushPayload, artifactPushEnabledFromEnv } = require('./artifact-review');
const { deriveStatus, awaitingKindForPendingTool, awaitingFromScreen, TRUST_PROMPT_REGEX, DEFAULT_UNBOUND_QUIET_MS } = require('./control/session-status');
const { detectAwaiting, detectTurnState } = require('./control/jsonl-awaiting');

// HOT-08: per-WebSocket-message size cap. Gates JSON.parse so a single
// large frame can't block the event loop for tens-to-hundreds of ms.
//
// The ws library's protocol-layer `maxPayload` (8 MB, see WebSocket.Server
// construction below) is a SECOND-LINE defence; this constant is the
// application-layer FIRST-LINE. 1 MB matches the realistic upper bound
// for legitimate WS control frames (paste-image and file uploads go via
// HTTP `/api/files/upload` at 10 MB; WS carries small JSON control
// messages). Frames exceeding this cap get a `message_too_large` error
// reply + a ws-standard 1009 close — explicit, debuggable.
//
// See docs/audits/hot-03-ws-frame-size.md.
const MAX_WS_MESSAGE_BYTES = 1 * 1024 * 1024;

// Fleet control-plane contract version (F19). Bumped when the cross-repo wire
// shape (status fields, event kinds, snapshot/capabilities/permission-mode
// contract) changes in a way the github-router client must negotiate. The client
// reads GET /api/control/capabilities once per instance and fails closed when a
// required capability is absent.
const CONTROL_CONTRACT_VERSION = 1;

// Inbound binary voice frames (client mic -> server STT) bypass the JSON guard
// above. Framing + validation (incl. the Buffer[] fragmented-frame normalize)
// lives in utils/ws-voice-frame so it can be unit-tested without a live socket.
// A frame is bounded by MAX_VOICE_BINARY_FRAME_BYTES (oversize -> 1009 close,
// like the text guard); a bad/short header -> 1003 close.
const {
  MAX_VOICE_PCM_BYTES,
  MAX_VOICE_BINARY_FRAME_BYTES,
  normalizeBinaryMessage,
  classifyVoiceFrame,
} = require('./utils/ws-voice-frame');

// Pre-built PWA screenshot SVG buffers (served at /screenshot-wide.png and /screenshot-narrow.png)
const SCREENSHOT_WIDE_BUF = Buffer.from(`
  <svg width="1280" height="720" viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">
    <rect width="1280" height="720" fill="#161b22"/>
    <rect x="0" y="0" width="1280" height="36" fill="#0d1117"/>
    <circle cx="20" cy="18" r="6" fill="#ff5f57" opacity="0.8"/>
    <circle cx="40" cy="18" r="6" fill="#febc2e" opacity="0.8"/>
    <circle cx="60" cy="18" r="6" fill="#28c840" opacity="0.8"/>
    <text x="640" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="#8b949e">ai-or-die</text>
    <rect x="24" y="56" width="1232" height="640" rx="8" fill="#0d1117" opacity="0.6"/>
    <text x="48" y="90" font-family="'JetBrains Mono',monospace" font-size="14" fill="#8b949e">~  ai-or-die</text>
    <text x="48" y="130" font-family="'JetBrains Mono',monospace" font-size="20" fill="#ff6b00">&gt;_</text>
    <text x="88" y="130" font-family="'JetBrains Mono',monospace" font-size="16" fill="#c9d1d9">Ready for input...</text>
    <rect x="48" y="140" width="2" height="18" fill="#ff6b00" opacity="0.8"/>
    <text x="48" y="640" font-family="system-ui,sans-serif" font-size="12" fill="#484f58">Universal AI coding terminal</text>
  </svg>
`);

const SCREENSHOT_NARROW_BUF = Buffer.from(`
  <svg width="540" height="720" viewBox="0 0 540 720" xmlns="http://www.w3.org/2000/svg">
    <rect width="540" height="720" fill="#161b22"/>
    <rect x="0" y="0" width="540" height="36" fill="#0d1117"/>
    <text x="270" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="#8b949e">ai-or-die</text>
    <rect x="12" y="48" width="516" height="660" rx="8" fill="#0d1117" opacity="0.6"/>
    <text x="28" y="80" font-family="'JetBrains Mono',monospace" font-size="13" fill="#8b949e">~  ai-or-die</text>
    <text x="28" y="116" font-family="'JetBrains Mono',monospace" font-size="18" fill="#ff6b00">&gt;_</text>
    <text x="62" y="116" font-family="'JetBrains Mono',monospace" font-size="14" fill="#c9d1d9">Ready for input...</text>
    <rect x="28" y="126" width="2" height="16" fill="#ff6b00" opacity="0.8"/>
    <text x="28" y="660" font-family="system-ui,sans-serif" font-size="11" fill="#484f58">Universal AI coding terminal</text>
  </svg>
`);

/** Foreground/background session priority constants */
const COALESCE_MS_FG = 16;       // 60 flushes/sec for active session
const COALESCE_MS_BG = 200;      // 5 flushes/sec for background sessions
const MAX_COALESCE_BYTES_FG = 32 * 1024;
const MAX_COALESCE_BYTES_BG = 8 * 1024;
const BACKPRESSURE_LIMIT_FG = 256 * 1024;
const BACKPRESSURE_LIMIT_BG = 128 * 1024;

class ClaudeCodeWebServer {
  constructor(options = {}) {
    this.port = options.port != null ? options.port : 7777;
    // Bind host: null = all interfaces (default; devtunnel/LAN). Mesh mode pins
    // '127.0.0.1' so only the tailnet `serve` proxy reaches the port, not the LAN.
    this.bindHost = options.bindHost || null;
    this.auth = options.auth;
    this.noAuth = options.noAuth || false;
    this.dev = options.dev || false;
    this.useHttps = options.https || false;
    this.certFile = options.cert;
    this.keyFile = options.key;
    this.folderMode = options.folderMode !== false; // Default to true
    this.selectedWorkingDir = null;
    // Capture baseFolder via fs.realpathSync so symlinked tmp dirs
    // (notably macOS /var → /private/var) match canonicalized targets
    // in validatePath. Critically: we use the pure-JS realpathSync, NOT
    // fs.realpathSync.native, because the latter expands Windows 8.3 short
    // names to long form — which would propagate the long form to every
    // path validatePath returns, breaking downstream comparisons that
    // expect the short form they sent (file-browser-api, generic-drop,
    // file-watcher subscriptions, etc.). The 8.3 short/long mismatch
    // problem is handled DEFENSIVELY at the comparison site inside
    // isPathWithinBase (see _canonicalizePathSync), without leaking the
    // .native form to callers.
    let _baseFolder = process.cwd();
    try { _baseFolder = fs.realpathSync(_baseFolder); } catch (_) { /* keep cwd on failure */ }
    this.baseFolder = _baseFolder;
    // Extra roots the ARTIFACT review routes (open/view only) may read, beyond
    // baseFolder. Plan files live under ~/.claude/plans (outside the workspace),
    // and an agent that can open them already has terminal/Read access to them —
    // so the workspace sandbox would only block a legitimate review, not a real
    // exfil path. General file-browser validatePath stays strict; this is
    // artifact-scoped. Extend via AIORDIE_ARTIFACT_EXTRA_ROOTS (path-sep list).
    this.artifactExtraRoots = (() => {
      const roots = [path.join(os.homedir(), '.claude', 'plans')];
      const extra = (process.env.AIORDIE_ARTIFACT_EXTRA_ROOTS || '').split(path.delimiter);
      for (const r of extra) { if (r && r.trim()) roots.push(r.trim()); }
      return roots.map((r) => { try { return fs.realpathSync(r); } catch (_) { return path.resolve(r); } });
    })();
    // Session duration in hours (default to 5 hours from first message)
    this.sessionDurationHours = parseFloat(process.env.CLAUDE_SESSION_HOURS || options.sessionHours || 5);
    
    this.app = express();
    this.claudeSessions = new Map(); // Persistent sessions (claude, codex, or agent)
    this.controlEventBus = new ControlEventBus();
    this.artifactReviews = new ArtifactReviewStore();
    this._artifactAssetSecret = crypto.randomBytes(32);
    this._artifactAssetSigner = createAssetTokenSigner(this._artifactAssetSecret);
    this.artifactPollHoldMs = options.artifactPollHoldMs || 25000;
    this.artifactPollHeartbeatMs = options.artifactPollHeartbeatMs || 5000;
    this.artifactSseHeartbeatMs = options.artifactSseHeartbeatMs || 15000;
    // Artifact push (default ON): panel feedback that arrives while the agent is
    // idle (no in-flight poll + PTY quiet) is injected into the CLI as a new turn,
    // so the composer works without the human switching to the terminal or the
    // agent having to poll. Opt OUT with AIORDIE_ARTIFACT_PUSH=0 (or false/off/no).
    // The idle-gate + residual TUI-timing risk are recorded in docs/adrs/0035.
    this._artifactPushEnabled = artifactPushEnabledFromEnv(process.env.AIORDIE_ARTIFACT_PUSH);
    const quietRaw = Number(process.env.AIORDIE_ARTIFACT_PUSH_QUIET_MS);
    this._artifactPushQuietMs = Number.isFinite(quietRaw) && quietRaw > 0 ? quietRaw : 1500;
    // PROC-04: min-heap of {id, lastActivity} pairs keyed by lastActivity.
    // Used by _evictStaleSessions to find the oldest session in O(log n)
    // rather than scanning the full Map every 5 min. Lazy-tombstone protocol
    // — see src/utils/eviction-heap.js. Push via _pushEvictionEntry(id) at
    // every site that creates a session or bumps session.lastActivity.
    this._evictionHeap = new MinHeap();
    this.webSocketConnections = new Map(); // Maps WebSocket connection ID to session info
    this.claudeBridge = new ClaudeBridge();
    this.codexBridge = new CodexBridge();
    this.copilotBridge = new CopilotBridge();
    this.geminiBridge = new GeminiBridge();
    this.terminalBridge = new TerminalBridge();
    this.vscodeTunnel = new VSCodeTunnelManager({
      dev: this.dev,
      onEvent: (sessionId, event) => this.handleVSCodeTunnelEvent(sessionId, event),
    });
    this.tunnelManager = null; // Set via setTunnelManager() from CLI entry point
    this.meshManager = null;   // Set via setMeshManager() from CLI entry point
    this.installAdvisor = new InstallAdvisor();
    // Pure test-runner detection — keeps heavy native/local-model subsystems
    // (STT, sticky-notes) inert in the suite so it never downloads models or
    // spawns native workers. Production (npm start / running bin) is unaffected.
    const underTest =
      /^test/.test(process.env.npm_lifecycle_event || '') ||
      typeof global.it === 'function';
    // CI runners must not be kept awake: the assertion can't hold in a headless
    // CI session anyway, and spawning powershell.exe at startup races node-pty's
    // ConPTY setup on Windows (it flaked the binary smoke test's terminal echo).
    // GitHub Actions and most CIs set CI=true. Keep this OUT of KeepaliveManager
    // so the unit tests (which construct it directly) still exercise win32 logic.
    const ci = process.env.CI;
    const isCI = (typeof ci === 'string' && ci !== '' && ci !== 'false' && ci !== '0') ||
      !!process.env.GITHUB_ACTIONS;
    this.sttEngine = new SttEngine({
      // STT is ON by default (disable with --no-stt / STT_DISABLED=1, handled in
      // bin); an external endpoint always enables it.
      enabled: (options.stt !== false && !underTest) || !!options.sttEndpoint,
      sttEndpoint: options.sttEndpoint,
      modelsDir: options.sttModelDir,
      numThreads: options.sttThreads ? parseInt(options.sttThreads, 10) : undefined,
    });
    // Per-tab local-LLM "sticky note" summariser. ON by default for AI-agent
    // tabs; disable globally with --no-sticky-notes / AIORDIE_DISABLE_STICKY_NOTES=1
    // (sticky-notes only — does NOT affect STT). The engine lazily downloads its
    // model + spawns its worker on the FIRST AI session start, and degrades to
    // "unavailable" if node-llama-cpp / the model is missing.
    //
    // Bun: node-llama-cpp's native N-API addon crashes Bun (NAPI FATAL ERROR,
    // exit 133 — a Bun bug, not ours), which would take down the whole server.
    // Force the feature off under Bun so its worker never spawns. The engine
    // also self-gates (see StickyNoteEngine._doInitialize) as defence-in-depth.
    // STT (sherpa) is unaffected and still runs under Bun.
    this._stickyNotesEnabledGlobally =
      options.stickyNotes !== false && !underTest && !isBun() &&
      process.env.AIORDIE_DISABLE_STICKY_NOTES !== '1';
    this._foregroundSessionId = null;
    this._stickyInitStarted = false;
    this._stickyInitTimer = null;
    // Per-tab binding to a claude JSONL transcript: aiOrDieSessionId -> { file,
    // offset, claudeSessionId }. A poll discovers/tails the active session file
    // (ownership-aware, skipping agent-*.jsonl) and feeds clean turns to the
    // summariser (JSONL mode). Tabs not running claude keep the scrape fallback.
    this._stickyJsonl = new Map();
    this._stickyJsonlPoll = null;
    this._controlIdempotency = new Map();
    this._controlSessionSeq = new Map();
    // Durable notes keyed by CLAUDE sessionId (the JSONL basename / --resume key),
    // so a note survives the tab closing and resumes when the same claude session
    // is reopened (claude --resume, /resume, or a server restart). Rebuilt from
    // persisted sessions on load; capped to bound growth.
    this._claudeNotes = new Map();
    this._claudeNotesCap = 300;
    // In-memory resume offsets (claudeSessionId -> last consumed byte offset) so a
    // tab reopening / following a /resume continues from where it left off instead
    // of re-reading (and re-summarising) the last window. Not persisted; a restart
    // falls back to the recent-window default.
    this._claudeOffsets = new Map();
    // Reference-count of which connected clients have a tab's card EXPANDED
    // (aiOrDieSessionId -> Set<wsId>). Note summarisation runs only while a
    // session has ≥1 expanded viewer; tied to connection presence so a dropped
    // browser can't leak a forever-running inference loop. The cheap ai-title
    // tail runs regardless, so collapsed tabs still get a fresh title.
    this._stickyActive = new Map();
    // A bound tab follows an in-session /resume to a newer session only after its
    // own transcript has been quiet for this many poll ticks (~2s each), so a
    // third unrelated session can't steal a tab that is still actively working.
    this._stickyResumeIdleTicks = 8;
    // Override the claude projects dir (tests point this at a temp fixture so
    // they never read the operator's real ~/.claude transcripts). undefined →
    // StickyNoteJsonl uses its default (~/.claude/projects or the env override).
    this._stickyProjectsDir = undefined;
    this.stickyNoteEngine = new StickyNoteEngine({
      enabled: this._stickyNotesEnabledGlobally,
      modelsDir: options.stickyNotesModelDir,
      model: options.stickyNotesModel ? { url: options.stickyNotesModel } : undefined,
      numThreads: options.stickyNotesThreads ? parseInt(options.stickyNotesThreads, 10) : undefined,
    });
    this.stickyNoteSummarizer = new StickyNoteSummarizer({
      engine: this.stickyNoteEngine,
      redact: redactSecrets,
      getForeground: () => this._foregroundSessionId,
      onResult: (sessionId, payload) => this._onStickyNoteResult(sessionId, payload),
    });

    // Keep the host machine awake for as long as the server runs (Windows 11
    // only; instant no-op on macOS/Linux). Acquired in start() once listening,
    // released in close() after the session-save flush. Gated on !underTest so
    // mocha never spawns the PowerShell helper. See docs/specs/keepalive.md.
    this.keepaliveManager = new KeepaliveManager({
      enabled: options.keepalive !== false && !underTest && !isCI &&
        process.env.AIORDIE_DISABLE_KEEPALIVE !== '1',
      keepDisplayOn: !!options.keepaliveDisplay,
    });

    this.sessionStore = new SessionStore(options.sessionStoreOptions);
    this.usageReader = new UsageReader(this.sessionDurationHours);
    this.usageAnalytics = new UsageAnalytics({
      sessionDurationHours: this.sessionDurationHours,
      plan: options.plan || process.env.CLAUDE_PLAN || 'max20',
      customCostLimit: parseFloat(process.env.CLAUDE_COST_LIMIT || options.customCostLimit || 50.00)
    });
    this.autoSaveInterval = null;
    this.activityBroadcastTimestamps = new Map(); // sessionId -> last broadcast timestamp
    this.startTime = Date.now(); // Track server start time
    this.isShuttingDown = false; // Flag to prevent duplicate shutdown
    // DISK-03: disk quota + circuit breaker state.
    // Default 1 GB ceiling on ~/.ai-or-die/; override with AIORDIE_DISK_QUOTA_MB.
    const quotaEnv = parseInt(process.env.AIORDIE_DISK_QUOTA_MB, 10);
    this._diskQuotaMb = (Number.isFinite(quotaEnv) && quotaEnv > 0) ? quotaEnv : 1024;
    this._diskFull = false;          // circuit breaker state
    this._diskFullSince = null;      // ms timestamp of last IDLE→FULL transition
    this._diskUsageCache = null;     // populated by _sampleDiskUsage
    this._diskUsageCacheAt = 0;
    this.supervised = typeof process.send === 'function'; // Running under supervisor with IPC
    this.restartManager = new RestartManager(this);
    this.restartManager.startMemoryMonitoring();
    // Commands dropdown removed
    // Assistant aliases (for UI display only)
    this.aliases = {
      claude: options.claudeAlias || process.env.CLAUDE_ALIAS || 'Claude',
      codex: options.codexAlias || process.env.CODEX_ALIAS || 'Codex',
      copilot: options.copilotAlias || process.env.COPILOT_ALIAS || 'Copilot',
      gemini: options.geminiAlias || process.env.GEMINI_ALIAS || 'Gemini',
      terminal: options.terminalAlias || process.env.TERMINAL_ALIAS || 'Terminal'
    };
    
    this.setupExpress();
    this._sessionsLoaded = this.loadPersistedSessions();
    this.setupAutoSave();
    this.setupIpcListener();
  }
  
  async loadPersistedSessions() {
    try {
      const sessions = await this.sessionStore.loadSessions();
      // Merge loaded sessions into the existing map to avoid overwriting
      // sessions created between constructor and load completion
      for (const [id, session] of sessions) {
        if (!this.claudeSessions.has(id)) {
          this.claudeSessions.set(id, session);
          this._pushEvictionEntry(id); // PROC-04
          // Rebuild the durable per-claude-session note store so a note resumes
          // after a server restart when the same claude session reopens.
          if (session.stickyNote && session.stickyClaudeSessionId) {
            this._claudeNotes.set(session.stickyClaudeSessionId, session.stickyNote);
          }
        }
      }
      this._capClaudeNotes();
      // Remove orphan claude-bind sidecars whose tab no longer exists.
      this._sweepClaudeBindSidecars();
      if (sessions.size > 0) {
        console.log(`Loaded ${sessions.size} persisted sessions`);
      }
      this.sweepOldTempImages();
    } catch (error) {
      console.error('Failed to load persisted sessions:', error);
    }
  }
  
  setupAutoSave() {
    // Auto-save sessions every 30 seconds
    this.autoSaveInterval = setInterval(() => {
      this.saveSessionsToDisk();
    }, 30000);

    // Sweep old temp images every 30 minutes
    this.imageSweepInterval = setInterval(() => this.sweepOldTempImages(), 30 * 60 * 1000);

    // Evict stale inactive sessions older than 7 days every 5 minutes.
    // Body is extracted into _evictStaleSessions so it has a clean unit-test
    // seam (the timer body is otherwise unreachable from outside the class).
    this.sessionEvictionInterval = setInterval(() => {
      this._evictStaleSessions().catch((err) => {
        console.warn('Eviction sweep failed:', err && err.message);
      });
    }, 5 * 60 * 1000);

    // Diagnostics heartbeat: log a structured snapshot of leak-relevant
    // resources every 5 minutes. Lets an operator `grep '[diagnostics]'
    // server.log | tail -100` to see resource growth over time without
    // running a profiler. Counts only — no PII.
    this.diagnosticsHeartbeatInterval = setInterval(() => {
      try {
        console.log('[diagnostics]', JSON.stringify(this._collectDiagnostics()));
      } catch (_) { /* never break the timer */ }
    }, 5 * 60 * 1000);

    // DISK-02: opt-in usage-JSONL compaction + crash-file pruning.
    // Runs on the same 5 min cadence as diagnostics but offset so the
    // two don't pile up. Behind an env flag for the first release; once
    // soak verifies, the default flips on.
    if (process.env.AI_OR_DIE_USAGE_COMPACT === '1') {
      this.diskCompactInterval = setInterval(() => {
        this._diskCompactionSweep().catch((err) => {
          console.warn('Disk compaction sweep failed:', err && err.message);
        });
      }, 5 * 60 * 1000);
    }

    // DISK-02: prune stale .crash files on startup. Always-on (low risk:
    // keeps the most recent crash for inspection, deletes anything > 7
    // days old). Schedule via setImmediate so we don't block startup.
    setImmediate(() => {
      this._pruneCrashFilesOnce().catch((err) => {
        console.warn('Crash-file pruning failed:', err && err.message);
      });
    });

    // DISK-02/03: warm the disk-usage sample so /api/diagnostics returns
    // real numbers within the first 60 s. Bounded time budget; never
    // blocks the event loop.
    setImmediate(() => {
      this._sampleDiskUsage(150).catch(() => { /* ignore */ });
    });
    // Re-sample on the 5 min cadence (cheap; 60 s cache hit is the
    // common path).
    this.diskUsageSampleInterval = setInterval(() => {
      this._sampleDiskUsage(150).catch(() => { /* ignore */ });
    }, 5 * 60 * 1000);

    // Also save on process exit
    process.on('SIGINT', () => this.handleShutdown());
    process.on('SIGTERM', () => this.handleShutdown());
    process.on('beforeExit', () => this.saveSessionsToDisk(true));
    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception:', err);
      // Synchronous save — async is unsafe after uncaught exception
      try {
        const data = this.sessionStore.serializeForSave
          ? this.sessionStore.serializeForSave(this.claudeSessions)
          : JSON.stringify([...this.claudeSessions.entries()]);
        const fs = require('fs');
        fs.writeFileSync(this.sessionStore.sessionsFile + '.crash', data, { mode: 0o600 });
      } catch (saveErr) {
        console.error('Failed to save sessions on crash:', saveErr);
      }
      // Reap PTY subtrees so the CLI's node/bun grandchildren don't outlive this crashed
      // server. Synchronous (the event loop is unsafe here). Windows closes each per-PTY
      // job; POSIX group-kills. Best-effort; never rethrows.
      try { this._reapAllPtySubtreesSync(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled rejection:', reason);
      // Don't swallow — let it propagate to uncaughtException on Node 15+
    });
  }

  setupIpcListener() {
    if (!this.supervised) return;
    // When running under the supervisor, listen for graceful shutdown via IPC
    process.on('message', (msg) => {
      if (msg && msg.type === 'shutdown') {
        console.log('Received shutdown request via IPC');
        this.handleShutdown();
      }
    });
    // If the supervisor's IPC channel drops, the supervisor died. Per the
    // "everything dies when the main process dies" contract, this server must NOT
    // keep running standalone (the old behavior) — it tears down its own PTY trees
    // (incl. the CLI's node/bun grandchildren) and shuts down.
    process.on('disconnect', () => {
      // Expected channel close: a graceful shutdown / memory-restart we initiated is
      // already in flight (the supervisor sent {type:'shutdown'} or we exited 75). No-op.
      if (this.isShuttingDown) return;
      console.warn('IPC channel disconnected (supervisor died). Tearing down this server and its process tree.');
      // Reap PTY subtrees synchronously FIRST so the node/bun grandchildren die immediately,
      // even if the ordered handleShutdown below is slow. On Windows with the job guard
      // active the kernel has usually already killed us; this is the cross-platform /
      // degraded-mode backstop.
      try { this._reapAllPtySubtreesSync(); } catch (_) { /* best-effort */ }
      this.handleShutdown(0);
    });
  }
  
  setTunnelManager(tm) {
    this.tunnelManager = tm;
  }

  setMeshManager(mm) {
    this.meshManager = mm;
  }

  async saveSessionsToDisk(force = false) {
    if (force) {
      this.sessionStore.markDirty();
    }
    const ok = await this.sessionStore.saveSessions(this.claudeSessions);
    // DISK-03: detect ENOSPC and open the circuit breaker. Edge-triggered
    // — broadcast `disk_full` exactly once per IDLE→FULL transition.
    if (!ok && this.sessionStore._lastSaveError) {
      const err = this.sessionStore._lastSaveError;
      if (err.code === 'ENOSPC' || err.code === 'EDQUOT') {
        this._enterDiskFull({ source: 'fs', op: 'session-save', code: err.code });
      }
    }
    return ok;
  }

  /**
   * DISK-03: open the disk-full circuit breaker. Broadcasts
   * { type: 'disk_full', detail: {...} } to all connected WS clients
   * exactly once per IDLE→FULL transition.
   */
  _enterDiskFull(detail) {
    if (this._diskFull) return; // already open — no broadcast spam
    this._diskFull = true;
    this._diskFullSince = Date.now();
    console.warn('[disk-full] entering disk-full state:', JSON.stringify(detail));
    this._broadcastDiskFull({
      ...detail,
      quota_total_mb: this._diskQuotaMb,
      quota_used_pct: this._diskUsagePercentOfQuota(),
    });
  }

  /**
   * DISK-03: close the circuit breaker when disk pressure clears.
   * Hysteresis: only clears when usage drops 10% below the quota.
   */
  _maybeExitDiskFull() {
    if (!this._diskFull) return;
    const pct = this._diskUsagePercentOfQuota();
    // Clear when below 80% of quota (10% hysteresis below the 90% open threshold).
    if (pct !== null && pct < 80) {
      this._diskFull = false;
      this._diskFullSince = null;
      console.log('[disk-full] exiting disk-full state; quota_used_pct=', pct);
    }
  }

  _diskUsagePercentOfQuota() {
    if (!this._diskQuotaMb) return null;
    const sample = this._diskUsageCache;
    if (!sample || typeof sample.ai_or_die_dir_bytes !== 'number') return null;
    return (sample.ai_or_die_dir_bytes / (this._diskQuotaMb * 1024 * 1024)) * 100;
  }

  _broadcastDiskFull(detail) {
    try {
      const msg = { type: 'disk_full', detail };
      const json = JSON.stringify(msg);
      if (this.webSocketConnections) {
        for (const [, wsInfo] of this.webSocketConnections) {
          if (wsInfo && wsInfo.ws && wsInfo.ws.readyState === 1) {
            try { wsInfo.ws.send(json); } catch (_) { /* best effort */ }
          }
        }
      }
    } catch (_) { /* never break the caller */ }
  }

  async handleShutdown(exitCode = 0) {
    // Prevent multiple shutdown attempts
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    // Hard timeout: if close() hangs, force exit (protects unsupervised mode)
    const forceExitTimer = setTimeout(() => {
      console.error(`Shutdown timed out after 15s, forcing exit (code ${exitCode})`);
      // Drop the keep-awake assertion before a hard exit in case close() hung.
      try { this.keepaliveManager.releaseSync(); } catch (_) { /* ignore */ }
      process.exit(exitCode);
    }, 15000);
    forceExitTimer.unref();

    console.log(`\nGracefully shutting down (exit code: ${exitCode})...`);
    // Persist sessions FIRST, before the (bounded but potentially multi-second)
    // native-engine teardown below. If a pathological native teardown ever blew
    // the 15s force-exit budget, sessions would already be safe on disk. close()
    // saves again at the end of a normal shutdown.
    try { await this.saveSessionsToDisk(true); } catch (_) { /* ignore */ }
    // Tear down the local-LLM summariser + worker so the model/worker thread
    // don't keep the process alive (and don't hold a GGUF file lock on Windows).
    if (this._stickyInitTimer) { clearTimeout(this._stickyInitTimer); this._stickyInitTimer = null; }
    if (this._stickyJsonlPoll) { clearInterval(this._stickyJsonlPoll); this._stickyJsonlPoll = null; }
    this._stickyJsonl.clear();
    try { this.stickyNoteSummarizer.shutdown(); } catch (_) { /* ignore */ }
    // Tear down both local native worker engines (sticky-note = node-llama-cpp,
    // STT = sherpa-onnx) concurrently. Each disposes its loaded model/recognizer
    // on its worker thread before exiting; force-tearing them down via
    // process.exit() while a model is loaded/loading aborts the process (SIGABRT)
    // during native cleanup. Running them in parallel keeps total shutdown well
    // inside the 15s force-exit budget above. STT shutdown was previously missing
    // entirely. The CLI dev tunnel (only set in --tunnel mode) used to be stopped
    // by a second SIGINT handler in bin/ai-or-die.js, now removed to avoid a
    // shutdown race; its stop moves here onto the single graceful path.
    await Promise.allSettled([
      Promise.resolve().then(() => this.stickyNoteEngine.shutdown()),
      Promise.resolve().then(() => this.sttEngine.shutdown()),
      Promise.resolve().then(() => (this.tunnelManager ? this.tunnelManager.stop() : undefined)),
      Promise.resolve().then(() => (this.meshManager ? this.meshManager.stop() : undefined)),
    ]);
    await this.close();
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }

  /**
   * Canonicalize a filesystem path to a single deterministic form so the
   * lexical sandbox check in isPathWithinBase compares apples-to-apples
   * regardless of which "flavour" of the path the input started in.
   *
   * Windows specifics (this is the load-bearing OS):
   *   - `fs.realpathSync` (pure JS) does NOT expand 8.3 short names on
   *     Node 22. Inputs like `C:\Users\RUNNER~1\...` stay short. Inputs
   *     like `C:\Users\runneradmin\...` stay long. So two paths to the
   *     same dir can lexically disagree.
   *   - `fs.realpathSync.native` delegates to libuv → GetFinalPathNameByHandleW
   *     which DOES expand 8.3 — but sometimes returns a `\\?\`-prefixed
   *     long path. The `\\?\` prefix is a Windows API hint, not part of
   *     the canonical path, and breaks lexical comparison against
   *     paths that don't carry it.
   *
   * Strategy: prefer `.native` (so 8.3 shorts always expand). Strip any
   * `\\?\` prefix the native call adds (handle both DOS-drive and UNC
   * forms). Fall back to pure-JS `realpathSync` on any error (e.g. a
   * non-existent path on POSIX where .native throws ENOENT but JS
   * fallback can still resolve the parent).
   *
   * POSIX: `.native` is a thin wrapper around realpath(3); behaviour
   * matches `realpathSync` for existing paths. No `\\?\` prefix
   * concern. Returns the same value either way.
   *
   * Returns the input unchanged when both calls fail (e.g. neither
   * the path nor its parent exists). Callers that need an existence
   * guarantee should `fs.existsSync` first.
   *
   * @param {string} p Absolute or relative path. Resolved against cwd
   *   before canonicalization.
   * @returns {string} Canonical absolute path, or the resolved input
   *   on canonicalization failure.
   */
  _canonicalizePathSync(p) {
    if (!p) return p;
    const resolved = path.resolve(p);
    // Prefer .native — only it expands Windows 8.3 short names.
    try {
      let out = fs.realpathSync.native(resolved);
      // Strip the Windows long-path `\\?\` prefix that .native sometimes
      // adds. Two forms:
      //   `\\?\C:\Users\...`       → `C:\Users\...`
      //   `\\?\UNC\server\share\…` → `\\server\share\…`
      // Without this, baseFolder (resolved before the prefix was added)
      // and the realpath'd target would still lexically disagree.
      if (process.platform === 'win32' && out.startsWith('\\\\?\\')) {
        out = out.startsWith('\\\\?\\UNC\\') ? '\\\\' + out.slice(8) : out.slice(4);
      }
      return out;
    } catch (_) {
      // Path doesn't exist — recurse on the parent (which usually does)
      // and append the basename. This propagates the 8.3 / symlink
      // expansion from the closest existing ancestor down to the
      // non-existent leaf, so the lexical compare against an existing
      // baseFolder still resolves correctly.
      //
      // Without this, a brand-new upload destination (e.g. a file path
      // about to be created, or a directory that hasn't been mkdir'd
      // yet) would canonicalize to its input form (SHORT on Windows
      // CI) while baseFolder canonicalizes to LONG — and the lexical
      // compare in isPathWithinBase would reject it as out-of-sandbox.
      try {
        const parent = path.dirname(resolved);
        if (parent && parent !== resolved) {
          return path.join(this._canonicalizePathSync(parent), path.basename(resolved));
        }
      } catch (__) { /* recursion fell through — fall through to plain JS realpath */ }
      // Last-ditch: pure-JS realpath (may resolve some POSIX symlinks
      // that .native couldn't, e.g. broken-symlink edge cases).
      try { return fs.realpathSync(resolved); } catch (___) { return resolved; }
    }
  }

  isPathWithinBase(targetPath) {
    try {
      // Canonicalize BOTH sides at compare time using _canonicalizePathSync
      // (which expands Windows 8.3 short names and strips \\?\ prefix).
      // This collapses short/long, prefix-presence/absence, and symlink
      // variance into a single deterministic key per filesystem entity —
      // so the lexical compare below works regardless of which form the
      // caller's path was in.
      //
      // We deliberately do NOT propagate the canonicalized form back to
      // callers (validatePath returns the JS-realpath form, NOT the
      // .native form); .native is only used HERE, where it can't leak
      // into response paths or watcher-subscription keys.
      const resolvedTarget = this._canonicalizePathSync(targetPath);
      // Memoized — baseFolder is constant for the process lifetime, but
      // _canonicalizePathSync calls fs.realpathSync.native which is a real
      // syscall (10–50ms on a SUBST/network drive). isPathWithinBase runs
      // on every OSC 7 emission via validatePath; without this cache, each
      // emission paid a redundant baseFolder realpath round-trip.
      if (!this._canonicalizedBaseFolder) {
        this._canonicalizedBaseFolder = this._canonicalizePathSync(this.baseFolder);
      }
      const resolvedBase = this._canonicalizedBaseFolder;
      // Use path.relative instead of startsWith to avoid prefix-matching false positives
      // (e.g. /home/user-admin would match /home/user with startsWith)
      const relative = path.relative(resolvedBase, resolvedTarget);
      // Allow base folder itself (relative === '') and any descendant path
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch (error) {
      return false;
    }
  }

  validatePath(targetPath) {
    if (!targetPath) {
      return { valid: false, error: 'Path is required' };
    }

    let canonicalPath = path.resolve(targetPath);

    // Canonicalize symlinks BEFORE the within-base check. Otherwise an input
    // passed in its pre-symlink form (e.g. `/var/folders/x` where `/var ->
    // /private/var` on macOS) won't match a baseFolder that came from
    // `process.cwd()` — which returns the realpath form. Without this,
    // EVERY /api/files/* request hitting a symlinked tmp dir returns 403
    // even when the realpath would be inside baseFolder. (This was the
    // root cause of 28 file-browser-api.test.js failures on macOS; the
    // tests had effectively never been run end-to-end on a symlinked tmp.)
    //
    // For non-existent inputs (new uploads, files about to be created),
    // canonicalize the parent so a symlinked parent dir doesn't leak past
    // the within-base check either.
    //
    // The post-canonicalize within-base check still defends against the
    // "user-planted symlink escapes baseFolder" case: realpath follows
    // the symlink, then we compare the FOLLOWED path against base.
    //
    // We use fs.realpathSync (pure JS), NOT .native, so the returned
    // canonicalPath preserves the form the caller submitted on Windows
    // (SHORT vs LONG). The 8.3 short/long mismatch in the sandbox check
    // is handled at the comparison site inside isPathWithinBase.
    try {
      if (fs.existsSync(canonicalPath)) {
        canonicalPath = fs.realpathSync(canonicalPath);
      } else {
        const parent = path.dirname(canonicalPath);
        if (parent && parent !== canonicalPath && fs.existsSync(parent)) {
          canonicalPath = path.join(fs.realpathSync(parent), path.basename(canonicalPath));
        }
      }
    } catch (_) { /* keep the lexical form on realpath failure */ }

    if (!this.isPathWithinBase(canonicalPath)) {
      return {
        valid: false,
        error: 'Access denied: Path is outside the allowed directory'
      };
    }

    return { valid: true, path: canonicalPath };
  }

  /** True when targetPath (canonicalized) is within `root` (canonicalized). */
  isPathWithinRoot(targetPath, root) {
    try {
      const resolvedTarget = this._canonicalizePathSync(targetPath);
      const resolvedRoot = this._canonicalizePathSync(root);
      const relative = path.relative(resolvedRoot, resolvedTarget);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch (_) {
      return false;
    }
  }

  /**
   * Path validator for the ARTIFACT review routes (open/view): allows baseFolder
   * (like validatePath) OR any configured artifactExtraRoots (plan dir etc.), so
   * a plan stored outside the workspace can be reviewed. Same symlink
   * canonicalization as validatePath; the general file sandbox is unchanged.
   */
  validateArtifactPath(targetPath) {
    const base = this.validatePath(targetPath);
    if (base.valid) return base;
    // baseFolder rejected it — retry against the extra roots using the same
    // canonicalization validatePath applied.
    if (!targetPath) return base;
    let canonicalPath = path.resolve(targetPath);
    try {
      if (fs.existsSync(canonicalPath)) {
        canonicalPath = fs.realpathSync(canonicalPath);
      } else {
        const parent = path.dirname(canonicalPath);
        if (parent && parent !== canonicalPath && fs.existsSync(parent)) {
          canonicalPath = path.join(fs.realpathSync(parent), path.basename(canonicalPath));
        }
      }
    } catch (_) { /* keep lexical form */ }
    for (const root of this.artifactExtraRoots || []) {
      if (this.isPathWithinRoot(canonicalPath, root)) return { valid: true, path: canonicalPath };
    }
    return { valid: false, error: 'Access denied: Path is outside the allowed directory' };
  }

  /**
   * Walk up from a file path looking for a `.git` entry (directory in a
   * regular repo, file in a worktree). Returns the absolute path of the
   * directory containing `.git`, or null if not inside any git repo.
   *
   * Bounded by the filesystem root and by the configured baseFolder — we
   * never walk above baseFolder, which prevents leaking info about repos
   * outside the served directory.
   */
  _findGitRoot(startPath) {
    let current;
    try {
      const stat = fs.statSync(startPath);
      current = stat.isDirectory() ? startPath : path.dirname(startPath);
    } catch (_) {
      current = path.dirname(startPath);
    }

    // baseFolder may itself be a symlink — resolve to its realpath ONCE so
    // the lexical equality check below matches the realpath validatePath
    // returned for the file we're walking up from. Without this, a server
    // started with `--folder /symlink-to-foo` could keep walking past the
    // intended boundary because the operator's lexical path !== realpath.
    // (Reviewer LOW-1 on 2fa99d1.)
    //
    // Uses fs.realpathSync (NOT .native) so the form matches what
    // validatePath returns. The 8.3 short/long mismatch is handled
    // separately inside isPathWithinBase.
    let baseResolved;
    try { baseResolved = fs.realpathSync(this.baseFolder); }
    catch (_) { baseResolved = path.resolve(this.baseFolder); }

    // Defensive cap: walk at most 64 levels up. parent === current already
    // terminates at the FS root, but the cap defends against pathological
    // path inputs that pass path.dirname non-lexically (none in stdlib
    // today, but cheap insurance).
    for (let i = 0; i < 64; i++) {
      // lstat (NOT existsSync, which follows symlinks): a user with write
      // access inside baseFolder could otherwise plant `.git → /etc` and
      // redirect git's repo discovery to a directory of their choosing.
      // Worktree pointers are regular files containing `gitdir: ...`, so
      // we accept either dir or file but explicitly reject symlinks.
      // (Reviewer MEDIUM-4 on 2fa99d1.)
      try {
        const st = fs.lstatSync(path.join(current, '.git'));
        if (st.isDirectory() || st.isFile()) return current;
        // Symlink, socket, anything else → skip; keep walking.
      } catch (_) { /* ENOENT or perm error → keep walking */ }

      const parent = path.dirname(current);
      if (parent === current) return null;          // hit FS root
      // Don't walk above the served baseFolder.
      if (current === baseResolved) return null;
      current = parent;
    }
    return null;
  }

  /**
   * Sliding-window per-IP rate limiter. Returns null if the request is
   * allowed, or { retryAfterMs } if it should be 429'd. Keeps a separate
   * Map per `bucket` name (so /api/search and /api/files/git-show have
   * independent budgets). Map size capped at 10k entries — DoS hardening
   * against floods of new IPs.
   *
   * Lifted from the inline /api/search implementation so /api/files/git-show
   * (and any future endpoint) can share the same primitive without
   * cargo-culting the boundary logic. Per reviewer MEDIUM-1 on 2fa99d1.
   */
  _perIpRateLimit(req, bucket, max, windowMs) {
    const ip = (req.ip || (req.connection && req.connection.remoteAddress) || 'unknown').toString();
    if (!this._rateLimitBuckets) this._rateLimitBuckets = new Map();
    let map = this._rateLimitBuckets.get(bucket);
    if (!map) { map = new Map(); this._rateLimitBuckets.set(bucket, map); }
    const now = Date.now();
    const recent = (map.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return { retryAfterMs: windowMs - (now - recent[0]) };
    }
    recent.push(now);
    map.set(ip, recent);
    if (map.size > 10_000) {
      const firstKey = map.keys().next().value;
      if (firstKey) map.delete(firstKey);
    }
    return null;
  }

  /**
   * Sliding-window per-SESSION rate limiter. Same shape as _perIpRateLimit
   * but keyed on a sessionId rather than an IP — the right granularity for
   * /api/files/find (and any future endpoint scoped to a single user's
   * working session) since IP buckets collapse legitimate users behind a
   * shared reverse proxy or NAT.
   *
   * Bucket maps are kept small (cap 10k entries with LRU-ish eviction) so
   * a flood of fake session ids can't OOM the limiter.
   */
  _perSessionRateLimit(sessionId, bucket, max, windowMs) {
    if (!sessionId) return null;
    if (!this._sessionRateLimitBuckets) this._sessionRateLimitBuckets = new Map();
    let map = this._sessionRateLimitBuckets.get(bucket);
    if (!map) { map = new Map(); this._sessionRateLimitBuckets.set(bucket, map); }
    const now = Date.now();
    const recent = (map.get(sessionId) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return { retryAfterMs: windowMs - (now - recent[0]) };
    }
    recent.push(now);
    map.set(sessionId, recent);
    if (map.size > 10_000) {
      const firstKey = map.keys().next().value;
      if (firstKey) map.delete(firstKey);
    }
    return null;
  }

  // ------------------------------------------------------------------------
  // Generic-drop attachment helpers (file-browser.md §"Generic file drop").
  // Used by POST /api/files/upload to enforce the per-session size cap on
  // .claude-attachments/, append the .gitignore guard on first write, and
  // sweep stale attachments on session delete + server shutdown.
  // ------------------------------------------------------------------------

  /** 100 MB per-session cap on .claude-attachments/ totals. */
  _attachmentSessionCapBytes() {
    return 100 * 1024 * 1024;
  }

  /**
   * Cache used by `_attachmentDirBytes` to avoid the O(N) `readdirSync` +
   * per-entry `statSync` scan on every `/api/files/upload` request. Keyed
   * by the input directory path (whatever the caller passed — typically
   * the canonicalized path from `validatePath`). Value: `{bytes, mtimeMs}`
   * where `mtimeMs` is the directory's last-modified time at the moment
   * the byte count was computed.
   *
   * Freshness check is a single `fs.statSync(dir)` to read the dir's
   * current mtime. On match → cache hit, return cached bytes (0 syscalls
   * beyond the stat). On mismatch or first-touch → re-scan + populate.
   *
   * Known-write paths in the upload handler use
   * `_attachmentDirCacheRecordWrite` to incrementally update the cache
   * after a successful `fs.writeFile`, avoiding the next-upload re-scan
   * entirely. The sweep path uses `_attachmentDirCacheInvalidate` to
   * force a re-scan on the next upload.
   *
   * Cardinality is bounded by the number of distinct attachment dirs the
   * user has across all working dirs (typically 1-50). No explicit cap.
   *
   * Closes the per-upload O(N) scan gap documented in
   * docs/audits/hot-04-attachment-scan.md (HOT-09).
   *
   * @type {Map<string, {bytes:number, mtimeMs:number}>}
   * @private
   */
  // Initialized lazily on first access since instance fields can't see
  // sibling instance state in older Node ESM; the underscore-prefixed
  // accessor below handles the one-shot init.

  _getAttachmentDirCache() {
    if (!this._attachmentDirCache) this._attachmentDirCache = new Map();
    return this._attachmentDirCache;
  }

  /**
   * Sum of bytes for all top-level files inside an attachments directory.
   * Top-level only — generic drop never creates subdirectories there, and
   * walking deep would let a user-side `ln -s /` symlink balloon the
   * computation. Robust to a missing directory (returns 0).
   *
   * HOT-09: cached by `(canonicalDir, mtimeMs)`. The check pays one
   * `fs.statSync(dir)` to read the dir's current mtime; if it matches the
   * cached entry, returns the cached bytes (no readdir, no per-entry
   * stats). The previous unconditional O(N) scan blocked the event loop
   * for 50 ms on a 1000-file SSD and up to 20 s on a 1000-file network
   * share — per upload. See `docs/audits/hot-04-attachment-scan.md`.
   */
  _attachmentDirBytes(attachmentsDir) {
    const cache = this._getAttachmentDirCache();

    // Single dir-stat for freshness check. If the dir is missing
    // (ENOENT), drop any stale cache entry and return 0.
    let dirStat;
    try {
      dirStat = fs.statSync(attachmentsDir);
    } catch (_) {
      cache.delete(attachmentsDir);
      return 0;
    }
    if (!dirStat.isDirectory()) {
      cache.delete(attachmentsDir);
      return 0;
    }

    const cached = cache.get(attachmentsDir);
    if (cached && cached.mtimeMs === dirStat.mtimeMs) {
      return cached.bytes; // fresh — skip the O(N) scan
    }

    // STALE or first-touch. Re-scan and populate.
    let total = 0;
    let entries;
    try {
      entries = fs.readdirSync(attachmentsDir, { withFileTypes: true });
    } catch (_) {
      cache.delete(attachmentsDir);
      return 0;
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      try {
        const st = fs.statSync(path.join(attachmentsDir, ent.name));
        total += st.size;
      } catch (_) { /* file vanished mid-readdir — skip */ }
    }
    cache.set(attachmentsDir, { bytes: total, mtimeMs: dirStat.mtimeMs });
    return total;
  }

  /**
   * HOT-09: called by the upload handler after a successful
   * `fs.writeFile` to incrementally update the cache. Avoids the
   * next-upload re-scan that would otherwise fire because the new file
   * advanced the dir's mtime.
   *
   * If no cache entry exists yet, this is a no-op (the next read will
   * full-scan and populate naturally).
   * @private
   */
  _attachmentDirCacheRecordWrite(attachmentsDir, addedBytes) {
    const cache = this._getAttachmentDirCache();
    const cached = cache.get(attachmentsDir);
    if (!cached) return; // not populated → next read full-scans
    let dirStat;
    try { dirStat = fs.statSync(attachmentsDir); }
    catch (_) { cache.delete(attachmentsDir); return; }
    cache.set(attachmentsDir, {
      bytes: cached.bytes + addedBytes,
      mtimeMs: dirStat.mtimeMs,
    });
  }

  /**
   * HOT-09: drop the cache entry for `attachmentsDir`, forcing the next
   * `_attachmentDirBytes` call to re-scan. Used after delete/unlink
   * operations on the dir (the sweep path) where computing the delta
   * incrementally would require knowing each removed file's size.
   * @private
   */
  _attachmentDirCacheInvalidate(attachmentsDir) {
    const cache = this._getAttachmentDirCache();
    cache.delete(attachmentsDir);
  }

  /**
   * Idempotent .gitignore guard: append `.claude-attachments/` to
   * <workingDir>/.gitignore IF the file exists and the line is not already
   * present. Best-effort — never throws (callers do not need to wrap).
   *
   * Per spec: NOT auto-created when missing. The user's repo hygiene is
   * theirs to manage; we only piggy-back on an existing convention.
   */
  _ensureAttachmentsGitignore(workingDir) {
    try {
      const gi = path.join(workingDir, '.gitignore');
      if (!fs.existsSync(gi)) return; // best-effort — no auto-create.
      const current = fs.readFileSync(gi, 'utf-8');
      // Match `.claude-attachments/` as an exact line (with or without
      // trailing newline). Avoid false matches on substrings like
      // `# .claude-attachments/foo`.
      const lines = current.split(/\r?\n/);
      if (lines.some((l) => l.trim() === '.claude-attachments/')) return;
      const sep = current.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(gi, sep + '.claude-attachments/\n');
    } catch (err) {
      if (this.dev) {
        console.warn('attachment .gitignore append failed:', err && err.message);
      }
    }
  }

  /**
   * Sweep <workingDir>/.claude-attachments/ for top-level files older
   * than `maxAgeMs` (default 24 h). Invoked on session delete + server
   * shutdown so stale generic-drop attachments don't accumulate forever
   * inside the user's project. Synchronous + best-effort; safe to call
   * with a missing or empty directory.
   *
   * Exposed as an instance method (underscore-prefixed) so unit tests can
   * drive it without waiting 24 h.
   */
  _sweepAttachments(workingDir, opts) {
    if (!workingDir) return;
    const maxAgeMs = (opts && opts.maxAgeMs) || (24 * 60 * 60 * 1000);
    const dir = path.join(workingDir, '.claude-attachments');
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return; // missing dir → nothing to do
    }
    const cutoff = Date.now() - maxAgeMs;
    let unlinked = 0;
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const fp = path.join(dir, ent.name);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) { fs.unlinkSync(fp); unlinked++; }
      } catch (_) { /* tolerate races */ }
    }
    // HOT-09: any unlink advances the dir's mtime AND drops bytes the
    // cached entry doesn't know about. Computing the delta incrementally
    // would require knowing each removed file's pre-unlink size; simpler
    // to invalidate and let the next upload re-scan once.
    if (unlinked > 0) {
      this._attachmentDirCacheInvalidate(dir);
    }
  }



  setupExpress() {
    this.app.use(cors());
    // Global JSON parser for normal endpoints (Express default ~100kb limit).
    // The upload route mounts its own higher-limit parser (see
    // POST /api/files/upload below); exempt it here so a base64 file body
    // isn't rejected by the ~100kb default before the route runs. The
    // trailing-slash normalization matches exactly the set of paths Express
    // routes to that handler (`/api/files/upload` and `/api/files/upload/`).
    const _globalJsonParser = express.json();
    this.app.use((req, res, next) => {
      // Case-insensitive + trailing-slash-normalized to match Express's
      // default route matching (case-insensitive routing), so every form that
      // reaches the upload handler is exempt from the ~100kb global parser.
      const p = req.path.replace(/\/+$/, '').toLowerCase() || '/';
      if (p === '/api/files/upload' || p === '/api/images/upload') return next();
      return _globalJsonParser(req, res, next);
    });
    
    // Serve manifest.json with the correct MIME type. The manifest is built
    // dynamically so the installed PWA name can carry the machine identity
    // (`[HOST] ai-or-die`). Registered BEFORE express.static so the dynamic
    // route wins over the physical public/manifest.json file.
    this.app.get('/manifest.json', (req, res) => {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.setHeader('Cache-Control', 'no-cache');
      try {
        const appIdentity = require('./public/app-identity.js');
        let raw;
        if (global.__SEA_MODE__) {
          const sea = require('node:sea');
          raw = Buffer.from(sea.getRawAsset('public/manifest.json')).toString('utf8');
        } else {
          raw = fs.readFileSync(path.join(__dirname, 'public', 'manifest.json'), 'utf8');
        }
        const manifest = JSON.parse(raw);
        // Privacy: the manifest is served pre-auth (this route is registered
        // before the auth middleware), so embed the host ONLY when there is no
        // auth token at all. Fail-closed: if any token is set we never put
        // os.hostname() in the publicly-fetchable manifest. In-session title/UI
        // still show the host in all cases.
        if (!this.auth) {
          const host = os.hostname();
          manifest.name = appIdentity.formatAppIdentity({ hostname: host });
          manifest.short_name = appIdentity.formatShortName({ hostname: host });
        }
        res.send(JSON.stringify(manifest));
      } catch (err) {
        // Fall back to the static manifest so install metadata still works.
        console.warn('[manifest] dynamic build failed, serving static:', err && err.message);
        if (global.__SEA_MODE__) {
          this._sendSeaAsset(res, 'public/manifest.json');
        } else {
          res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
        }
      }
    });

    if (global.__SEA_MODE__) {
      this.app.use((req, res, next) => {
        const assetKey = 'public' + req.path;
        if (this._sendSeaAsset(res, assetKey)) return;
        next();
      });
    } else {
      this.app.use(express.static(path.join(__dirname, 'public')));
    }

    // Static-serve project docs at /docs for in-app deep links —
    // specifically the Layer 5 resolver-failure toast's "Show me how →"
    // CTA which opens the OSC 7 shell-hooks section of the file-browser
    // spec. Path-traversal protection: express.static + the dotfiles:
    // 'ignore' option below + Express's path-normalization mean the
    // mount can only serve descendants of repo/docs. (Round-2 peer
    // review #2: prior CTA URL was broken because docs/ wasn't
    // exposed.)
    //
    // NOTE: in SEA-packaged builds, docs/ isn't bundled — _sendSeaAsset
    // would need a 'docs' asset path. For now, the CTA gracefully
    // 404s in SEA mode; the toast body still carries the actionable
    // text ("install the OSC 7 hook"). The full snippets live in
    // docs/specs/file-browser.md regardless.
    this.app.use('/docs', express.static(path.join(__dirname, '..', 'docs'), {
      dotfiles: 'ignore',
      index: false,
      fallthrough: false,
    }));

    // PWA icons are static PNG files in src/public/ (icon-<size>.png), served by
    // express.static above (or the SEA asset middleware). They are real PNGs so the
    // served Content-Type matches the manifest's declared `image/png` — required for
    // Chromium installability and iOS apple-touch-icon. Regenerate with
    // `node scripts/generate-pwa-icons.js`.

    // PWA Screenshot routes - serve pre-built branded screenshots
    this.app.get('/screenshot-wide.png', (req, res) => {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.send(SCREENSHOT_WIDE_BUF);
    });

    this.app.get('/screenshot-narrow.png', (req, res) => {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.send(SCREENSHOT_NARROW_BUF);
    });

    // Auth status endpoint - always accessible
    this.app.get('/auth-status', (req, res) => {
      res.json({ 
        authRequired: !this.noAuth && !!this.auth,
        authenticated: false 
      });
    });

    // Auth verify endpoint - check if token is valid
    this.app.post('/auth-verify', (req, res) => {
      if (this.noAuth || !this.auth) {
        return res.json({ valid: true }); // No auth required
      }
      
      const { token } = req.body;
      const valid = token === this.auth;
      
      if (valid) {
        res.json({ valid: true });
      } else {
        res.status(401).json({ valid: false, error: 'Invalid token' });
      }
    });

    if (!this.noAuth && this.auth) {
      this.app.use((req, res, next) => {
        const asset = this._artifactAssetAuthFromPath(req);
        if (asset && this._artifactAssetSigner.verify(asset.sessionId, asset.token)) {
          req.artifactAssetPathToken = asset.token;
          return next();
        }
        const token = req.headers.authorization || req.query.token;
        if (token !== `Bearer ${this.auth}` && token !== this.auth) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
      });
    } else {
      this.app.use((req, res, next) => {
        const asset = this._artifactAssetAuthFromPath(req);
        if (asset && this._artifactAssetSigner.verify(asset.sessionId, asset.token)) {
          req.artifactAssetPathToken = asset.token;
        }
        next();
      });
    }

    this.app.use('/api/control', createControlRouter(this._buildControlDeps()));
    this.app.use('/api/artifact', createArtifactReviewRouter({
      store: this.artifactReviews,
      validatePath: (p) => this.validateArtifactPath(p),
      mintAssetToken: (sid) => this._artifactAssetSigner.mint(sid),
      broadcastToSession: (sessionId, obj) => this.broadcastToSession(sessionId, obj),
      pollHoldMs: this.artifactPollHoldMs,
      pollHeartbeatMs: this.artifactPollHeartbeatMs,
      sseHeartbeatMs: this.artifactSseHeartbeatMs,
      pushToAgent: this._artifactPushEnabled
        ? (sessionId, text) => this._pushArtifactFeedbackToAgent(sessionId, text)
        : null,
      routeApprovalAction: (sessionId, action) => this._routeArtifactApproval(sessionId, action),
    }));

    // Commands API removed

    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        claudeSessions: this.claudeSessions.size,
        activeConnections: this.webSocketConnections.size
      });
    });

    // Resource diagnostics for long-running-process leak detection.
    //
    // Returns memory + handle + per-resource-Map counts so an operator can
    // grep a heartbeat log (or curl this endpoint on demand) and tell which
    // resource is leaking when the server eventually goes unresponsive.
    // Counts only — no paths, no usernames, no session content — so it is
    // safe to expose without auth on the same posture as /api/health.
    //
    // History: added during PR #108 after a weeks-long-unresponsive incident
    // where the team had to guess the resource class because no instrumentation
    // existed. Companion heartbeat logger runs every 5 minutes (see
    // setupAutoSave). Future hardening: gate behind auth for shared deploys.
    this.app.get('/api/diagnostics', (req, res) => {
      res.json(this._collectDiagnostics());
    });

    // App-level tunnel status
    this.app.get('/api/tunnel/status', (req, res) => {
      if (!this.tunnelManager) {
        return res.json({ running: false, publicUrl: null });
      }
      res.json(this.tunnelManager.getStatus());
    });

    // App-level tunnel restart
    this.app.post('/api/tunnel/restart', (req, res) => {
      if (!this.tunnelManager) {
        return res.status(404).json({ error: 'No tunnel configured' });
      }

      // Broadcast warning to all connected clients before killing
      this.webSocketConnections.forEach((wsInfo) => {
        if (wsInfo.ws.readyState === WebSocket.OPEN) {
          wsInfo.ws.send(JSON.stringify({ type: 'app_tunnel_restarting' }));
        }
      });

      // Respond immediately, restart async
      res.status(202).json({ message: 'Tunnel restart initiated' });

      const broadcastTunnelStatus = (status) => {
        this.webSocketConnections.forEach((wsInfo) => {
          if (wsInfo.ws.readyState === WebSocket.OPEN) {
            wsInfo.ws.send(JSON.stringify(status));
          }
        });
      };

      this.tunnelManager.restart().then((result) => {
        if (result.success) {
          broadcastTunnelStatus({
            type: 'app_tunnel_status',
            running: true,
            publicUrl: result.publicUrl,
          });
        } else {
          broadcastTunnelStatus({
            type: 'app_tunnel_status',
            running: false,
            publicUrl: null,
            error: result.error,
          });
        }
      }).catch((err) => {
        console.error('[tunnel] Restart failed:', err.message);
        broadcastTunnelStatus({
          type: 'app_tunnel_status',
          running: false,
          publicUrl: null,
          error: err.message,
        });
      });
    });

    // Get session persistence info
    this.app.get('/api/sessions/persistence', async (req, res) => {
      const metadata = await this.sessionStore.getSessionMetadata();
      res.json({
        ...metadata,
        currentSessions: this.claudeSessions.size,
        autoSaveEnabled: true,
        autoSaveInterval: 30000
      });
    });

    // List all Claude sessions
    this.app.get('/api/sessions/list', (req, res) => {
      const sessionList = Array.from(this.claudeSessions.entries()).map(([id, session]) => ({
        id,
        name: session.name,
        created: session.created,
        active: session.active,
        agent: session.agent || null,
        workingDir: session.workingDir,
        connectedClients: session.connections.size,
        lastActivity: session.lastActivity
      }));
      res.json({ sessions: sessionList });
    });

    // Create a new session
    this.app.post('/api/sessions/create', (req, res) => {
      const { name, workingDir } = req.body;
      const sessionId = uuidv4();
      
      // Validate working directory if provided
      let validWorkingDir = this.baseFolder;
      if (workingDir) {
        const validation = this.validatePath(workingDir);
        if (!validation.valid) {
          return res.status(403).json({ 
            error: validation.error,
            message: 'Cannot create session with working directory outside the allowed area' 
          });
        }
        validWorkingDir = validation.path;
      } else if (this.selectedWorkingDir) {
        validWorkingDir = this.selectedWorkingDir;
      }
      
      const session = {
        id: sessionId,
        name: name || `Session ${new Date().toLocaleString()}`,
        created: new Date(),
        lastActivity: new Date(),
        active: false,
        agent: null, // 'claude' | 'codex' when started
        workingDir: validWorkingDir,
        connections: new Set(),
        outputBuffer: new CircularBuffer(1000),
        priority: 'foreground',
        sessionStartTime: null,
        sessionUsage: {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          totalCost: 0,
          models: {}
        },
        maxBufferSize: 1000
      };
      
      this.claudeSessions.set(sessionId, session);
      this._pushEvictionEntry(sessionId); // PROC-04
      this.sessionStore.markDirty();

      // Save sessions after creating new one
      this.saveSessionsToDisk();

      if (this.dev) {
        console.log(`Created new session: ${sessionId} (${session.name})`);
      }

      res.json({
        success: true,
        sessionId,
        session: {
          id: sessionId,
          name: session.name,
          workingDir: session.workingDir
        }
      });
    });

    // Get session details
    this.app.get('/api/sessions/:sessionId', (req, res) => {
      const session = this.claudeSessions.get(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      res.json({
        id: session.id,
        name: session.name,
        created: session.created,
        active: session.active,
        workingDir: session.workingDir,
        connectedClients: session.connections.size,
        lastActivity: session.lastActivity
      });
    });

    // Delete a Claude session
    this.app.delete('/api/sessions/:sessionId', async (req, res) => {
      const sessionId = req.params.sessionId;
      const session = this.claudeSessions.get(sessionId);
      
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      // Stop running process if active. Must `await` so the PTY teardown
      // (listener disposal + kill + bounded wait) completes BEFORE we
      // remove the session from claudeSessions. Without the await, the
      // PTY exit callback raced session map mutation: callers landing
      // mid-teardown saw a session that was "gone" from the map but
      // whose ptyProcess was still alive holding FDs.
      if (session.active) {
        const bridge = this.getBridgeForAgent(session.agent);
        if (bridge) {
          try {
            await bridge.stopSession(sessionId);
          } catch (err) {
            console.warn(`stopSession failed during DELETE for ${sessionId}: ${err && err.message}`);
          }
        }
      }
      
      // Notify WebSocket connections that this session was deleted
      // Do NOT close the WS — the client may already be joined to a
      // different session on the same connection. Let the client handle
      // cleanup via the session_deleted message.
      session.connections.forEach(wsId => {
        const wsInfo = this.webSocketConnections.get(wsId);
        if (wsInfo && wsInfo.ws.readyState === WebSocket.OPEN) {
          wsInfo.ws.send(JSON.stringify({
            type: 'session_deleted',
            sessionId: sessionId,
            message: 'Session has been deleted'
          }));
        }
      });

      // Flush any pending output before cleanup
      this._flushAndClearOutputTimer(session, sessionId);

      // Clean up temp images
      this.cleanupSessionImages(session);

      // Sweep stale generic-drop attachments older than 24 h. The user
      // may still need younger ones for an in-flight conversation, so
      // we keep recent files.
      try { this._sweepAttachments(session.workingDir); } catch (_) { /* ignore */ }

      // Tear down any orphan fs-watch SSE for this session BEFORE the
      // session map deletion. Without this, chokidar watchers leaked
      // (PR #99 regression) — kernel inotify-watch + FD exhaustion after
      // weeks of uptime. See _cleanupFsWatchSession.
      this._cleanupFsWatchSession(sessionId, 'session_deleted');

      // Stop + tear down the summariser so an in-flight inference is discarded.
      this.stickyNoteSummarizer.cancel(sessionId);
      this._stickyJsonl.delete(sessionId);
      this._removeClaudeBindSidecar(session);
      if (this._foregroundSessionId === sessionId) this._foregroundSessionId = null;

      this.claudeSessions.delete(sessionId);
      if (this.controlEventBus) this.controlEventBus.append(sessionId, 'session_deleted');
      this.activityBroadcastTimestamps.delete(sessionId);
      this.sessionStore.markDirty();

      // Save sessions after deletion — await to ensure persistence
      await this.saveSessionsToDisk();

      res.json({ success: true, message: 'Session deleted' });
    });

    this.app.get('/api/config', async (req, res) => {
      const toolEntries = {
        claude: { bridge: this.claudeBridge, hasDangerousMode: true },
        codex: { bridge: this.codexBridge, hasDangerousMode: true },
        copilot: { bridge: this.copilotBridge, hasDangerousMode: true },
        gemini: { bridge: this.geminiBridge, hasDangerousMode: true },
        terminal: { bridge: this.terminalBridge, hasDangerousMode: false },
      };

      // Wait for all bridges' async command discovery to finish before
      // calling isAvailable(). Without this, isAvailable() falls back to
      // synchronous execFileSync('where') which blocks the event loop for
      // up to 5s per unavailable tool (20s total on CI with no AI CLIs).
      // Use allSettled to prevent one failing bridge from blocking all others.
      await Promise.allSettled(
        Object.values(toolEntries).map(e => e.bridge._commandReady)
      );

      const tools = {};
      for (const [id, entry] of Object.entries(toolEntries)) {
        const available = entry.bridge.isAvailable();
        tools[id] = {
          alias: this.aliases[id],
          available,
          hasDangerousMode: entry.hasDangerousMode,
        };
        if (!available && id !== 'terminal') {
          tools[id].install = this.installAdvisor.getInstallInfo(id);
        }
      }

      let prerequisites = null;
      const hasUnavailable = Object.values(tools).some(t => !t.available);
      if (hasUnavailable) {
        prerequisites = await this.installAdvisor.detectPrerequisites();
      }

      const vscodeTunnelAvailable = this.vscodeTunnel.isAvailableSync();
      res.json({
        folderMode: this.folderMode,
        selectedWorkingDir: this.selectedWorkingDir,
        baseFolder: this.baseFolder,
        hostname: os.hostname(),
        aliases: this.aliases,
        tools,
        vscodeTunnel: {
          available: vscodeTunnelAvailable,
          devtunnelAvailable: this.vscodeTunnel._devtunnelAvailable,
          ...(!vscodeTunnelAvailable ? { install: this.installAdvisor.getInstallInfo('vscode') } : {}),
        },
        voiceInput: {
          localStatus: this.sttEngine.getStatus(),
          localEnabled: !!(this.sttEngine._enabled && !this.sttEngine._sttEndpoint),
          cloudAvailable: true,
        },
        ...(prerequisites ? { prerequisites } : {}),
      });
    });

    this.app.post('/api/tools/:toolId/recheck', async (req, res) => {
      const { toolId } = req.params;
      const bridge = this.getBridgeForAgent(toolId);
      if (!bridge) {
        return res.status(404).json({ error: 'Unknown tool' });
      }

      bridge.clearAvailabilityCache();
      await bridge.initCommand();

      const available = bridge.isAvailable();
      res.json({ toolId, available });
    });

    this.app.post('/api/create-folder', (req, res) => {
      const { parentPath, folderName } = req.body;
      
      if (!folderName || !folderName.trim()) {
        return res.status(400).json({ message: 'Folder name is required' });
      }
      
      if (folderName.includes('/') || folderName.includes('\\')) {
        return res.status(400).json({ message: 'Invalid folder name' });
      }
      
      const basePath = parentPath || this.baseFolder;
      const fullPath = path.join(basePath, folderName);
      
      // Validate that the parent path and resulting path are within base folder
      const parentValidation = this.validatePath(basePath);
      if (!parentValidation.valid) {
        return res.status(403).json({ 
          message: 'Cannot create folder outside the allowed area' 
        });
      }
      
      const fullValidation = this.validatePath(fullPath);
      if (!fullValidation.valid) {
        return res.status(403).json({ 
          message: 'Cannot create folder outside the allowed area' 
        });
      }
      
      try {
        // Check if folder already exists
        if (fs.existsSync(fullValidation.path)) {
          return res.status(409).json({ message: 'Folder already exists' });
        }
        
        // Create the folder
        fs.mkdirSync(fullValidation.path, { recursive: true });
        
        res.json({
          success: true,
          path: fullValidation.path,
          message: `Folder "${folderName}" created successfully`
        });
      } catch (error) {
        console.error('Failed to create folder:', error);
        res.status(500).json({ 
          message: `Failed to create folder: ${error.message}` 
        });
      }
    });

    this.app.get('/api/folders', (req, res) => {
      const requestedPath = req.query.path || this.baseFolder;

      // Validate the requested path
      const validation = this.validatePath(requestedPath);
      if (!validation.valid) {
        return res.status(403).json({
          error: validation.error,
          message: 'Access to this directory is not allowed'
        });
      }

      const currentPath = validation.path;

      try {
        const items = fs.readdirSync(currentPath, { withFileTypes: true });
        const folders = items
          .filter(item => item.isDirectory())
          .filter(item => !item.name.startsWith('.') || req.query.showHidden === 'true')
          .map(item => ({
            name: item.name,
            path: path.join(currentPath, item.name),
            isDirectory: true
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        const parentDir = path.dirname(currentPath);
        const canGoUp = this.isPathWithinBase(parentDir) && parentDir !== currentPath;

        res.json({
          currentPath,
          parentPath: canGoUp ? parentDir : null,
          folders,
          home: this.baseFolder,
          baseFolder: this.baseFolder
        });
      } catch (error) {
        res.status(403).json({
          error: 'Cannot access directory',
          message: error.message
        });
      }
    });

    // ── File Browser Endpoints ──────────────────────────────────────────

    // GET /api/files — List directory (files + folders), paginated
    this.app.get('/api/files', (req, res) => {
      // Per-tab file-browser root. Resolve the requesting session's home dir
      // (live OSC 7 cwd if tracked, else the spawn dir) when a `session` id is
      // supplied and its dir still validates. Used as (a) the default root
      // when the client sends no explicit `path`, and (b) the `home` value the
      // client points "Home" at — so Home stays the tab's dir even while
      // browsing subdirs. Mirrors GET /api/files/find. Falls back to baseFolder
      // for unknown/stale sessions so the browser never 403s on open.
      let sessionHome = null;
      const sid = typeof req.query.session === 'string' ? req.query.session : '';
      if (sid) {
        const session = this.claudeSessions.get(sid);
        if (session) {
          const candidate = session.liveCwd || session.workingDir;
          if (candidate && this.validatePath(candidate).valid) {
            sessionHome = candidate;
          } else {
            // Known session but its dir is missing or no longer inside the
            // sandbox — a real misconfiguration worth logging. (Unknown session
            // ids fall through silently: expected during cold-cache races.)
            console.warn(`/api/files: session ${sid} working dir unavailable; using baseFolder`);
          }
        }
      }
      const requestedPath = req.query.path || sessionHome || this.baseFolder;
      const validation = this.validatePath(requestedPath);
      if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
      }
      const currentPath = validation.path;
      const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
      const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || '500', 10) || 500));
      const showHidden = req.query.showHidden === 'true';

      (async () => {
        try {
          const stat = await fs.promises.stat(currentPath);
          if (!stat.isDirectory()) {
            return res.status(400).json({ error: 'Path is not a directory' });
          }
          const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
          const filtered = entries.filter(e => showHidden || !e.name.startsWith('.'));

          const statResults = await Promise.all(
            filtered.map(async (entry) => {
              const itemPath = path.join(currentPath, entry.name);
              const isDir = entry.isDirectory();
              let size = null;
              let modified = null;
              let extension = null;
              let mimeCategory = null;
              let editable = false;

              try {
                const st = await fs.promises.stat(itemPath);
                modified = st.mtime.toISOString();
                if (!isDir) {
                  size = st.size;
                }
              } catch { /* skip stat errors */ }

              if (!isDir) {
                const info = getFileInfo(itemPath);
                extension = info.extension;
                mimeCategory = info.mimeCategory;
                editable = info.editable;
              }

              return {
                name: entry.name,
                path: normalizePath(itemPath),
                isDirectory: isDir,
                size,
                modified,
                extension,
                mimeCategory,
                editable,
              };
            })
          );
          const mapped = statResults;

          // Sort: directories first, then alphabetical
          mapped.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

          const totalCount = mapped.length;
          const items = mapped.slice(offset, offset + limit);

          const parentDir = path.dirname(currentPath);
          const canGoUp = this.isPathWithinBase(parentDir) && parentDir !== currentPath;

          res.json({
            currentPath: normalizePath(currentPath),
            parentPath: canGoUp ? normalizePath(parentDir) : null,
            items,
            totalCount,
            offset,
            limit,
            home: normalizePath(sessionHome || this.baseFolder),
            baseFolder: normalizePath(this.baseFolder),
          });
        } catch (error) {
          res.status(403).json({ error: 'Cannot access directory', message: error.message });
        }
      })();
    });

    // GET /api/files/stat — File/dir metadata with hash
    this.app.get('/api/files/stat', async (req, res) => {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: 'Path is required' });

      const validation = this.validatePath(filePath);
      if (!validation.valid) return res.status(403).json({ error: validation.error });

      const resolvedPath = validation.path;
      try {
        const stat = await fs.promises.stat(resolvedPath);
        const info = getFileInfo(resolvedPath);
        let hash = null;
        if (!stat.isDirectory() && info.mimeCategory !== 'binary') {
          try { hash = await computeFileHash(resolvedPath); } catch { /* skip */ }
        }

        res.json({
          path: normalizePath(resolvedPath),
          name: path.basename(resolvedPath),
          isDirectory: stat.isDirectory(),
          size: stat.size,
          sizeFormatted: formatFileSize(stat.size),
          modified: stat.mtime.toISOString(),
          created: stat.birthtime.toISOString(),
          extension: info.extension,
          mimeType: info.mimeType,
          mimeCategory: info.mimeCategory,
          previewable: info.previewable,
          editable: info.editable,
          hash,
        });
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({ error: 'File not found' });
        }
        res.status(500).json({ error: 'Failed to get file info', message: error.message });
      }
    });

    // ── Plan File Endpoints ───────────────────────────────────────────────

    // GET /api/plans/content — Read a plan file from known plan directories
    this.app.get('/api/plans/content', async (req, res) => {
      const { name, scope } = req.query;
      if (!name || !scope) {
        return res.status(400).json({ error: 'name and scope are required' });
      }

      const PLAN_DIRS = {
        workspace: () => path.join(this.baseFolder, '.claude', 'plans'),
        global: () => path.join(os.homedir(), '.claude', 'plans'),
      };

      if (!PLAN_DIRS[scope]) {
        return res.status(400).json({ error: 'scope must be workspace or global' });
      }

      // Sanitize filename — strip path separators and dangerous chars
      const safeName = sanitizeFileName(name);
      const safeBase = path.basename(safeName);
      if (!safeBase || safeBase === '.' || safeBase === '..') {
        return res.status(400).json({ error: 'Invalid plan name' });
      }

      const planDir = PLAN_DIRS[scope]();
      const resolved = path.resolve(planDir, safeBase);

      // Containment check
      const relative = path.relative(planDir, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      try {
        // Check symlinks
        const lstat = await fs.promises.lstat(resolved);
        if (lstat.isSymbolicLink()) {
          return res.status(403).json({ error: 'Symlinks not allowed' });
        }

        // Size check
        if (lstat.size > 512 * 1024) {
          return res.status(413).json({ error: 'Plan file too large' });
        }

        const content = await fs.promises.readFile(resolved, 'utf8');
        res.json({
          name: safeBase,
          scope: scope,
          content: content,
          modified: lstat.mtime.toISOString(),
          size: lstat.size
        });
      } catch (err) {
        if (err.code === 'ENOENT') {
          return res.status(404).json({ error: 'Plan file not found' });
        }
        res.status(500).json({ error: 'Failed to read plan file' });
      }
    });

    // GET /api/plans/list — List plan files from workspace and/or global scope
    this.app.get('/api/plans/list', async (req, res) => {
      const { scope } = req.query;
      const PLAN_DIRS = {
        workspace: () => path.join(this.baseFolder, '.claude', 'plans'),
        global: () => path.join(os.homedir(), '.claude', 'plans'),
      };

      const scopes = scope ? [scope] : ['workspace', 'global'];
      const plans = [];

      for (const s of scopes) {
        if (!PLAN_DIRS[s]) continue;
        const dir = PLAN_DIRS[s]();
        try {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && !entry.isSymbolicLink() && (entry.name.endsWith('.md') || entry.name.endsWith('.json'))) {
              const filePath = path.join(dir, entry.name);
              // Double-check with lstat to catch symlinks on older Node versions
              const lstat = await fs.promises.lstat(filePath);
              if (lstat.isSymbolicLink()) continue;
              plans.push({
                name: entry.name,
                scope: s,
                modified: lstat.mtime.toISOString(),
                size: lstat.size
              });
            }
          }
        } catch {
          // Directory doesn't exist — that's fine
        }
      }

      // Sort by modified descending
      plans.sort((a, b) => new Date(b.modified) - new Date(a.modified));
      res.json({ plans: plans.slice(0, 50) });
    });

    // GET /api/files/content — Serve text content as JSON envelope
    this.app.get('/api/files/content', async (req, res) => {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: 'Path is required' });

      const validation = this.validatePath(filePath);
      if (!validation.valid) return res.status(403).json({ error: validation.error });

      const resolvedPath = validation.path;
      try {
        const stat = await fs.promises.stat(resolvedPath);
        if (stat.isDirectory()) {
          return res.status(400).json({ error: 'Path is a directory' });
        }

        const info = getFileInfo(resolvedPath);
        const maxSize = Math.min(
          parseInt(req.query.maxSize || '5242880', 10) || 5242880,
          5242880 // 5MB hard cap
        );

        // Binary check: extension-based first, then null-byte heuristic
        if (info.mimeCategory === 'binary') {
          const binary = await isBinaryFile(resolvedPath);
          if (binary) {
            return res.status(415).json({ error: 'Binary file cannot be previewed as text' });
          }
        }

        // Even for "text" categories, check for binary content
        if (info.mimeCategory !== 'binary') {
          try {
            const binary = await isBinaryFile(resolvedPath);
            if (binary) {
              return res.status(415).json({ error: 'File contains binary content and cannot be previewed as text' });
            }
          } catch { /* if check fails, try to serve anyway */ }
        }

        const hash = await computeFileHash(resolvedPath);
        const truncated = stat.size > maxSize;
        const readSize = Math.min(stat.size, maxSize);

        const buffer = Buffer.alloc(readSize);
        const fd = await fs.promises.open(resolvedPath, 'r');
        try {
          await fd.read(buffer, 0, readSize, 0);
        } finally {
          await fd.close();
        }

        const content = buffer.toString('utf-8');

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          content,
          hash,
          truncated,
          totalSize: stat.size,
          mimeCategory: info.mimeCategory,
          extension: info.extension,
          editable: info.editable,
        });
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({ error: 'File not found' });
        }
        res.status(500).json({ error: 'Failed to read file', message: error.message });
      }
    });

    // GET /api/files/download — Stream file with inline/attachment support
    this.app.get('/api/files/download', async (req, res) => {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: 'Path is required' });

      const validation = this.validatePath(filePath);
      if (!validation.valid) return res.status(403).json({ error: validation.error });

      const resolvedPath = validation.path;
      try {
        const stat = await fs.promises.stat(resolvedPath);
        if (stat.isDirectory()) {
          return res.status(400).json({ error: 'Cannot download a directory' });
        }
        if (stat.size > 100 * 1024 * 1024) {
          return res.status(413).json({ error: 'File too large (>100MB)' });
        }

        const fileName = path.basename(resolvedPath);
        const info = getFileInfo(resolvedPath);
        const inline = req.query.inline === '1';

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');

        if (inline) {
          // Serve inline for preview (images, PDFs)
          res.setHeader('Content-Type', info.mimeType);
          res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
          res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
        } else {
          // Force download
          res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        }

        const stream = fs.createReadStream(resolvedPath);
        stream.pipe(res);
        stream.on('error', (err) => {
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream file', message: err.message });
          }
        });
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({ error: 'File not found' });
        }
        res.status(500).json({ error: 'Failed to download file', message: error.message });
      }
    });

    // GET /api/files/git-show — Returns `git show <ref>:<relpath>` content.
    //
    // Use case: file diff view shows the working-tree version vs the version
    // from git (HEAD by default) so users can see "what changed since last
    // commit" or "what would Claude's edit revert".
    //
    // Security:
    //   - Path is funnelled through validatePath() (TOCTOU-safe via realpath).
    //   - git is spawned via execFile with shell:false (NEVER shell:true) so
    //     argument values can't be reinterpreted as shell metachars.
    //   - --end-of-options separates options from positional args so a ref
    //     starting with "-" can't be reinterpreted as a git option.
    //   - Ref is also character-allowlisted (refs and SHAs only) as defence
    //     in depth (e.g., reject NUL, semicolons, redirections, --options).
    //   - Output capped at 5 MB; truncate cleanly with a marker.
    //   - 404 if the file isn't inside any git repo (no `.git` ancestor).
    this.app.get('/api/files/git-show', async (req, res) => {
      const filePath = req.query.path;
      const ref = req.query.ref || 'HEAD';

      if (!filePath) return res.status(400).json({ error: 'Path is required' });

      // Allowlist for refs: alphanum + a small set of git-rev punctuation.
      // Covers HEAD, HEAD~3, HEAD^, branch names like main/feat-x, tags
      // like v1.2.3, and full SHAs. Disallows -options, NUL, ;, |, $, `,
      // backslash, whitespace, glob chars.
      if (!/^[A-Za-z0-9_./~^@-]{1,200}$/.test(ref) || ref.startsWith('-')) {
        return res.status(400).json({ error: 'Invalid ref' });
      }

      // Per-IP rate limit: 30/min/IP. `git show` on a packed-refs repo with
      // a 5MB blob is expensive enough that an authenticated client could
      // saturate CPU with a flood of concurrent requests. Reviewer MEDIUM-1
      // on 2fa99d1 — bucket separate from /api/search so the diff view
      // doesn't share a budget with cross-file search.
      const rl = this._perIpRateLimit(req, 'git-show', 30, 60_000);
      if (rl) {
        return res.status(429).json({ error: 'Too many git-show requests', retryAfterMs: rl.retryAfterMs });
      }

      const validation = this.validatePath(filePath);
      if (!validation.valid) return res.status(403).json({ error: validation.error });
      const resolvedPath = validation.path;

      // Walk up from the file's directory to locate the .git directory
      // (covers nested repos, submodules-as-directories, and worktrees
      // where .git is a file pointing at the actual git dir).
      const gitRoot = this._findGitRoot(resolvedPath);
      if (!gitRoot) {
        return res.status(404).json({
          error: 'Not a git repository',
          message: 'No .git directory found in any parent of the requested path',
        });
      }

      // Path relative to the git root, with forward slashes (git's canonical
      // form). path.relative on Windows yields backslashes — normalize.
      let relPath = path.relative(gitRoot, resolvedPath);
      if (process.platform === 'win32') relPath = relPath.replace(/\\/g, '/');
      if (!relPath || relPath.startsWith('..')) {
        return res.status(400).json({ error: 'Path is outside the git repository' });
      }

      // Strip server-absolute paths from any string we send to the client.
      // git error messages routinely contain `cwd`-resolved absolute paths
      // (e.g. "fatal: not a git repository: '/Users/.../foo/.git'") which
      // leak host filesystem layout. Reviewer MEDIUM-2 on 2fa99d1.
      const sanitize = (s) => {
        if (!s) return s;
        let out = String(s);
        try {
          const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (gitRoot) out = out.replace(new RegExp(escapeRe(gitRoot), 'g'), '<repo>');
          if (this.baseFolder) out = out.replace(new RegExp(escapeRe(this.baseFolder), 'g'), '<base>');
        } catch (_) {}
        // Catch-all: redact long absolute path tokens that survived the prefix
        // strip (different drive letters, symlink-resolved variants, etc.).
        out = out.replace(/(['"]?)(\/[^\s'"`]{12,}|[A-Za-z]:[\\/][^\s'"`]{6,})\1/g, '<path>');
        return out.slice(0, 300);
      };

      const MAX_BYTES = 5 * 1024 * 1024;
      // execFile buffers stdout in memory; cap maxBuffer at MAX_BYTES + slack.
      // shell:false is the default for execFile but make it explicit anyway.
      const args = ['show', '--end-of-options', `${ref}:${relPath}`];
      execFile('git', args, {
        cwd: gitRoot,
        shell: false,
        maxBuffer: MAX_BYTES + 1024,
        timeout: 10_000,        // 10s — git show on a single file is usually <100ms
        windowsHide: true,
      }, (err, stdout, stderr) => {
        if (err) {
          // Distinguish well-known cases:
          //   - ENOENT: git not installed
          //   - exit !== 0: git returned an error (bad ref, file not in tree, etc.)
          //   - timeout / maxBuffer overflow
          if (err.code === 'ENOENT') {
            return res.status(503).json({ error: 'git is not installed on the server' });
          }
          if (err.killed && err.signal === 'SIGTERM') {
            return res.status(504).json({ error: 'git show timed out' });
          }
          if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            return res.status(413).json({ error: 'File too large at this revision (>5MB)' });
          }
          // Most likely: bad ref or file doesn't exist at that revision.
          // Sanitize stderr first so absolute server paths don't leak
          // (reviewer MEDIUM-2 on 2fa99d1).
          const firstLine = sanitize((stderr || '').split('\n')[0])
            || sanitize(err.message)
            || 'Unknown git error';
          return res.status(404).json({
            error: 'git show failed',
            message: firstLine,
          });
        }

        // Truncate at MAX_BYTES on a BYTE boundary (reviewer MEDIUM-3 on
        // 2fa99d1 — String.prototype.slice cuts on codepoints, but our
        // cap is in bytes; multibyte UTF-8 → up to 4× MAX_BYTES bytes
        // through the wire). Buffer.slice + toString('utf8') replaces a
        // partial codepoint at the cut with U+FFFD instead of producing
        // malformed UTF-8.
        let truncated = false;
        let content = stdout;
        const buf = Buffer.from(stdout, 'utf8');
        if (buf.length > MAX_BYTES) {
          content = buf.slice(0, MAX_BYTES).toString('utf8');
          truncated = true;
        }

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          path: filePath,
          ref: ref,
          relPath: relPath,
          gitRoot: gitRoot,
          truncated: truncated,
          content: content,
        });
      });
    });

    // GET /api/search — SSE-streamed cross-file search via ripgrep (or grep
    // fallback on Linux). One match per SSE event; capped at 500 matches per
    // request and 50 matches per file. Rate-limited per IP at 10/minute.
    //
    // Query params (all optional except q):
    //   q             string, required — search query
    //   regex         '0' | '1' (default '0') — interpret q as regex
    //   caseSensitive '0' | '1' (default '0') — case-sensitive match
    //   glob          string — file glob filter (e.g. "*.{ts,tsx}");
    //                          rejected if it contains shell metachars
    //   path          string — root directory to search; defaults to baseFolder.
    //                          Must pass validatePath() (no traversal).
    //
    // SSE event shapes (newline-terminated, two-newline-separated):
    //   data: {"type":"start","backend":"rg"|"grep"}\n\n
    //   data: {"type":"match","path":"src/foo.js","line":42,"col":5,"text":"..."}\n\n
    //   data: {"type":"end","matches":7,"truncated":false}\n\n
    //   data: {"type":"error","message":"..."}\n\n
    this.app.get('/api/search', (req, res) => {
      const q = req.query.q;
      if (!q || typeof q !== 'string') {
        return res.status(400).json({ error: 'q (query) is required' });
      }
      if (q.length > 1024) {
        return res.status(400).json({ error: 'q is too long (max 1024 chars)' });
      }

      const useRegex = req.query.regex === '1';
      const caseSensitive = req.query.caseSensitive === '1';
      // Normalize Windows-style backslash separators to forward slashes
      // BEFORE the glob regex check (codex review). Windows users naturally
      // write globs like `src\public\*.js`; ripgrep + grep both accept
      // forward-slash globs on every platform, so canonicalizing here is
      // the cross-platform-safe path. Matches the input-canonicalization
      // pattern in validatePath() (commit 158c1c2).
      let glob = req.query.glob ? String(req.query.glob) : null;
      if (glob !== null) glob = glob.replace(/\\/g, '/');

      // Glob validation: allow letters/digits, wildcard chars (* ? [ ]),
      // braces ({} ,), dots, slashes, hyphens, underscores. Reject any
      // shell metachar that might be misinterpreted by a future code
      // path. Cap at 256 chars. Reject leading '!' (grep --include doesn't
      // negate; ripgrep --glob does, but we keep semantics consistent).
      if (glob !== null) {
        if (glob.length > 256 || !/^[\w./*?[\]{},\-]+$/.test(glob) || glob.startsWith('!')) {
          return res.status(400).json({ error: 'Invalid glob pattern' });
        }
      }

      // Per-IP rate limit: 10 searches/minute. Shared sliding-window
      // helper (see _perIpRateLimit) — separate bucket from
      // /api/files/git-show so the diff view doesn't share a budget
      // with cross-file search.
      const rl = this._perIpRateLimit(req, 'search', 10, 60_000);
      if (rl) {
        return res.status(429).json({
          error: 'Too many searches',
          retryAfterMs: rl.retryAfterMs,
        });
      }

      // Resolve and validate the search root.
      const rawPath = req.query.path ? String(req.query.path) : this.baseFolder;
      const validation = this.validatePath(rawPath);
      if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
      }
      const cwd = validation.path;

      // SSE response headers — NEVER buffered.
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');     // hint for proxies
      // Flush headers immediately so the client EventSource opens.
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      function send(obj) {
        // SSE frame. Keep it terse — per-match overhead matters for big
        // result sets. We don't escape `\n` in `text`; we strip CR/LF in
        // the search util before this point.
        try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {}
      }

      const handle = search.searchStream(q, {
        cwd: cwd,
        regex: useRegex,
        caseSensitive: caseSensitive,
        glob: glob,
        maxPerFile: 50,
        maxTotal: 500,
        maxFilesize: '10M',
        onMatch: (m) => {
          // rg's positional is `.` (relative) — see _buildRgArgs comment.
          // Resolve relative match paths to absolute against cwd so the
          // wire shape stays consistent (clients expect absPath absolute).
          const absMatchPath = path.isAbsolute(m.path)
            ? m.path
            : path.resolve(cwd, m.path);
          // Make path relative to cwd so the client can resolve consistently.
          const relPath = path.relative(cwd, absMatchPath) || absMatchPath;
          send({
            type: 'match',
            path: relPath,
            absPath: absMatchPath,
            line: m.line,
            col: m.col,
            text: m.text,
          });
        },
        onError: (err) => {
          send({ type: 'error', message: err && err.message ? String(err.message).slice(0, 300) : 'search error' });
        },
        onEnd: ({ matches, truncated, backend, droppedLines }) => {
          send({
            type: 'end',
            matches: matches,
            truncated: truncated,
            backend: backend,
            droppedLines: droppedLines || 0,
          });
          try { res.end(); } catch (_) {}
        },
      });

      send({ type: 'start', backend: handle.backend });

      // Client disconnect → kill the child immediately so we don't keep
      // ripgrep running after the user navigated away.
      req.on('close', () => { handle.kill(); });
    });

    // GET /api/files/find — fuzzy filename search ("Cmd-P" Go-to-File).
    //
    // Pipeline (per docs/specs/file-browser.md §"GET /api/files/find"):
    //   1. validatePath() the requested root (defaults to liveCwd ?? session.workingDir).
    //   2. Spawn `rg --files --hidden --glob '!.git'` rooted at that path.
    //      Backend selection re-uses the same chain as /api/search via
    //      utils/search.js (system rg → bundled @vscode/ripgrep → SEA path).
    //      grep is NOT a viable fallback here (it has no --files mode); if
    //      the backend chain returns null we 503 with a clear hint.
    //   3. Hard-cap enumeration at 10,000 files. Above that, return
    //      { truncated: true, totalFound } so the UI can render a "refine
    //      your search" hint instead of blocking the event loop on a giant
    //      fuzzysort sweep.
    //   4. Score with fuzzysort (acronym + contiguous + basename boosts).
    //   5. Sort desc by score, slice to limit (default 50, max 200).
    //
    // Per-session 5 queries/sec rate limit (per spec — IP rate limiting is
    // wrong granularity behind reverse proxies).
    //
    // Response shape: { matches: [{ path, basename, score, mtimeMs }],
    //                   truncated, totalFound, queryMs }.
    this.app.get('/api/files/find', async (req, res) => {
      const t0 = Date.now();

      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const trimmed = q.trim();
      if (!trimmed) {
        return res.status(400).json({ error: 'q (query) is required' });
      }
      if (q.length > 1024) {
        return res.status(400).json({ error: 'q is too long (max 1024 chars)' });
      }

      const sessionId = typeof req.query.session === 'string' ? req.query.session : '';
      if (!sessionId) {
        return res.status(400).json({ error: 'session is required' });
      }
      const session = this.claudeSessions.get(sessionId);
      // session may be missing (the client sometimes calls find before any
      // session is created — e.g. fresh tab); we still allow that, but
      // then `path` MUST be supplied explicitly because there is no
      // workingDir / liveCwd to default to.

      // Per-session rate limit: 5 queries/sec sliding window.
      const rl = this._perSessionRateLimit(sessionId, 'files-find', 5, 1000);
      if (rl) {
        return res.status(429).json({
          error: 'Too many find queries for this session',
          retryAfterMs: rl.retryAfterMs,
        });
      }

      // Resolve the search root: explicit `path` > liveCwd > workingDir > 400.
      let rawPath = typeof req.query.path === 'string' ? req.query.path : '';
      if (!rawPath && session) {
        rawPath = session.liveCwd || session.workingDir || '';
      }
      if (!rawPath) {
        return res.status(400).json({ error: 'path is required (no session workingDir to default to)' });
      }

      const validation = this.validatePath(rawPath);
      if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
      }
      const root = validation.path;

      // limit: default 50, hard cap 200.
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 50;
      if (limit > 200) limit = 200;

      // Enumeration: spawn `rg --files --hidden --glob '!.git'`. We reuse
      // the search-backend detection from utils/search.js so the bundled
      // @vscode/ripgrep path (the primary backend on Windows + corporate
      // installs) is honoured the same way as /api/search.
      const backend = search.detectBackend();
      if (backend !== 'rg') {
        // grep can't enumerate files (it can list with `find . -type f` but
        // that has different .gitignore semantics; v1 hard-requires rg).
        return res.status(503).json({
          error: 'ripgrep is required for fuzzy file find but is not available',
        });
      }

      const rgPath = search.detectRgPath() || 'rg';

      let stdoutBuf = '';
      let totalFound = 0;
      let truncated = false;
      const ENUMERATION_CAP = 10_000;

      const { spawn } = require('child_process');
      let proc;
      try {
        proc = spawn(rgPath, ['--files', '--hidden', '--glob', '!.git', '--no-messages'], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return res.status(503).json({ error: 'failed to spawn ripgrep', message: err.message });
      }

      let killed = false;
      const killForCap = () => {
        if (killed) return;
        killed = true;
        truncated = true;
        try { proc.kill('SIGTERM'); } catch (_) {}
      };

      // Buffer-and-split stdout. rg --files emits one path per line, no
      // structured framing — cheap to parse and skip the JSON overhead.
      const files = [];
      proc.stdout.on('data', (chunk) => {
        if (killed) return;
        stdoutBuf += chunk.toString('utf-8');
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          totalFound++;
          if (totalFound > ENUMERATION_CAP) {
            killForCap();
            break;
          }
          // Normalize separators to '/' so path-separator queries
          // (`utils/format`) match on Windows where ripgrep emits
          // native '\' separators. The fuzzysort target shape is what
          // the user types against, not what the OS reports.
          files.push(process.platform === 'win32' ? line.replace(/\\/g, '/') : line);
        }
      });

      // Drain stderr to avoid backpressure deadlock — rg can write to it
      // for permission warnings, etc. We don't surface them; --no-messages
      // already silences most.
      proc.stderr.resume();

      proc.on('error', (err) => {
        // Process never started or died catastrophically. Surface as 503.
        if (!res.headersSent) {
          res.status(503).json({ error: 'ripgrep error', message: err.message });
        }
      });

      proc.on('close', () => {
        try {
          // Score each file with fuzzysort. We score against the BASENAME
          // for the primary key (matches user mental model — they type
          // the filename, not the directory) but `fuzzysort.go` also
          // accepts a key-extraction wrapper. We do this by hand because
          // we want score+basename in the response.
          const fuzzysort = require('fuzzysort');
          // Prepare targets with BOTH basename AND relative-path keys.
          // fuzzysort's multi-key API (via `keys` in go() below) scores
          // each target against every listed key and surfaces the best
          // per-target score. This is what makes path-separator queries
          // like `utils/format` or `components/UserProfile` work — the
          // basename never contains a slash, so basename-only scoring
          // would collapse to 0 the moment the user types `/`. Real users
          // type `path/file` to disambiguate among same-named files in
          // monorepos (the canonical VS Code Quick Open pattern). Per
          // QA journey P1 finding #5 (task #14).
          const prepared = files.map((rel) => {
            const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
            const base = path.basename(rel);
            return {
              abs,
              base,
              rel,
              prepBase: fuzzysort.prepare(base),
              prepRel: fuzzysort.prepare(rel),
            };
          });

          // fuzzysort.go returns matches sorted by score descending.
          const scored = fuzzysort.go(trimmed, prepared, {
            keys: ['prepBase', 'prepRel'],
            limit,
            // threshold is fuzzysort's "minimum score" knob — anything
            // below is filtered out. -10000 = "include even weak partials"
            // (matches the VS Code Cmd-P feel).
            threshold: -10000,
          });

          const matches = [];
          for (const s of scored) {
            const item = s.obj;
            let mtimeMs = 0;
            try {
              mtimeMs = fs.statSync(item.abs).mtimeMs;
            } catch (_) {
              // File vanished between rg enumeration and the stat — skip
              // mtime but include the match.
            }
            matches.push({
              path: item.abs,
              basename: item.base,
              score: s.score,
              mtimeMs,
            });
          }

          res.json({
            matches,
            truncated,
            totalFound,
            queryMs: Date.now() - t0,
          });
        } catch (err) {
          if (!res.headersSent) {
            res.status(500).json({ error: 'find failed', message: err.message });
          }
        }
      });

      // Client disconnect → kill the child immediately.
      req.on('close', () => {
        try { proc.kill('SIGTERM'); } catch (_) {}
      });
    });

    // GET /api/sessions/:sessionId/repo-root — resolve git repo root for
    // a session's working directory. Used by the client-side terminal-path
    // resolver chain (file-browser.js TerminalPathDetector) so paths like
    // "src/app.js" inside a stack trace can be tried against the repo root
    // in addition to liveCwd and workingDir. See spec
    // docs/specs/file-browser.md §"GET /api/sessions/:id/repo-root".
    //
    // Cached per session for the session lifetime (the repo root doesn't
    // move during a session). Cache is invalidated only when the session
    // is deleted.
    this.app.get('/api/sessions/:sessionId/repo-root', (req, res) => {
      const sessionId = req.params.sessionId;
      const session = this.claudeSessions.get(sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });

      // Cached?
      if (Object.prototype.hasOwnProperty.call(session, '_repoRootCache')) {
        return res.json({ root: session._repoRootCache });
      }

      const startDir = session.liveCwd || session.workingDir;
      if (!startDir) return res.json({ root: null });

      const validation = this.validatePath(startDir);
      if (!validation.valid) return res.status(403).json({ error: validation.error });

      // Use git rev-parse rather than the local _findGitRoot walk so we
      // correctly handle worktrees (where .git is a file, not a dir
      // pointing into the main repo). _findGitRoot also handles worktrees
      // but git's own resolver is the definitive answer.
      execFile('git', ['rev-parse', '--show-toplevel'], {
        cwd: validation.path,
        timeout: 5000,
      }, (err, stdout) => {
        if (err) {
          // Most common: not in a git repo (`fatal: not a git repository`).
          // Cache null so we don't re-spawn git on every link click.
          session._repoRootCache = null;
          return res.json({ root: null });
        }
        const root = String(stdout).trim();
        if (!root) {
          session._repoRootCache = null;
          return res.json({ root: null });
        }
        // Normalize separators before validation — `git rev-parse
        // --show-toplevel` returns POSIX-style forward slashes on Windows
        // (`C:/Users/...`). validatePath calls path.resolve which DOES
        // normalize to backslashes on win32, but the test-fixture
        // comparison (fs.realpathSync) returns backslashes, so we want
        // the cached value to match without relying on each consumer
        // re-normalizing.
        const normalizedRoot = path.normalize(root);
        // Validate the resolved root is inside the sandbox before caching
        // and returning — git could theoretically resolve to something
        // outside baseFolder if the session's workingDir is a deep path
        // into a repo whose root sits above baseFolder (the served
        // sub-directory case).
        const rootValidation = this.validatePath(normalizedRoot);
        if (!rootValidation.valid) {
          session._repoRootCache = null;
          return res.json({ root: null });
        }
        session._repoRootCache = rootValidation.path;
        res.json({ root: session._repoRootCache });
      });
    });


    // via chokidar. Per ADR-0017 (#100, amended at 4d047d1): proactive sync
    // between agent edits and user-open Monaco tabs / file-browser
    // listings, complementing the hash-based 409-Conflict-on-save backstop
    // from ADR-0012.
    //
    // Session-scoped multiplexing (ADR-0017 §Multiplexing): ONE EventSource
    // per session, with paths managed via the POST /subscribe + /unsubscribe
    // control channel. This avoids hitting Chromium's 6-EventSource-per-
    // origin cap that would otherwise break workflows above ~5 open tabs.
    //
    // Wire shape:
    //   GET  /api/files/watch?session=<id>&path=<rootDir>[&token=<auth>]
    //     Opens the SSE stream. Watcher rooted at <rootDir> (typically the
    //     session's workingDir). If an EventSource for this session is
    //     already open, it is replaced (single-ES-per-session semantics).
    //
    //   POST /api/files/watch/subscribe?session=<id>&path=<abs>[&token=<auth>]
    //     Adds <abs> to the active subscription set. Subsequent SSE events
    //     for that path arrive on the open EventSource. Returns 204; 404 if
    //     no EventSource is open for that session; 403 on validatePath fail.
    //
    //   POST /api/files/watch/unsubscribe?session=<id>&path=<abs>[&token=<auth>]
    //     Removes <abs> from the subscription set. 204.
    //
    // Auth: ?token= (EventSource cannot carry custom headers; same
    // constraint as PDF.js worker / `<img src>` / `<iframe src>` per #96).
    //
    // Concurrent-watcher cap (ADR-0017 §Rate limiting layer 1):
    //   5 open watchers per IP. Cleanest mechanic for SSE — open count
    //   directly maps to active server load (one chokidar watcher + one
    //   open TCP connection per concurrent watcher). Tracked via
    //   _activeWatchersByIp Map<ip, count>; decremented on req.on('close').
    //
    // Per-session emission cap (ADR-0017 §Rate limiting layer 2):
    //   100 events/min/session via the existing _perIpRateLimit helper.
    //   Excess events are dropped silently (NOT queued); the SSE consumer
    //   treats this as the same kind of event-loss the WebSocket-reconnect
    //   path already handles via mtime-drift re-check on focus.
    //
    // SSE event shapes (newline-terminated, two-newline-separated):
    //   data: {"type":"start"}\n\n
    //   data: {"type":"add"|"change"|"unlink"|"rename",
    //          "path":"<abs>", "relPath":"<rel>",
    //          "mtime":<ms-or-null>, "hash"?:"<md5>",
    //          "prevPath"?:"<abs, rename only>"}\n\n
    //   data: {"type":"error","message":"..."}\n\n
    //   data: {"type":"end","reason":"client-disconnect"|"replaced"|"watcher-error"}\n\n
    this.app.get('/api/files/watch', async (req, res) => {
      const sessionId = req.query.session;
      const rawPath = req.query.path;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'session is required' });
      }
      if (!rawPath || typeof rawPath !== 'string') {
        return res.status(400).json({ error: 'path is required' });
      }

      // Concurrent-watcher cap (5/IP) — must be enforced BEFORE we open
      // the chokidar watcher, otherwise an attacker could exhaust kernel
      // file-watch resources by opening 1000 connections faster than they
      // close.
      const ip = (req.ip || (req.connection && req.connection.remoteAddress) || 'unknown').toString();
      if (!this._activeWatchersByIp) this._activeWatchersByIp = new Map();
      if (!this._fsWatchSessions) this._fsWatchSessions = new Map();

      // If an EventSource already exists for this session, replace it
      // (single-ES-per-session per ADR-0017). Delegate to the central
      // cleanup helper so the displaced session frees its per-IP slot,
      // closes its chokidar watcher, and emits one end-event (not two).
      this._cleanupFsWatchSession(sessionId, 'replaced');

      const currentCount = this._activeWatchersByIp.get(ip) || 0;
      const MAX_CONCURRENT_WATCHERS = 5;
      if (currentCount >= MAX_CONCURRENT_WATCHERS) {
        return res.status(429).json({
          error: 'Too many concurrent file watchers',
          activeWatchers: currentCount,
          maxAllowed: MAX_CONCURRENT_WATCHERS,
        });
      }

      // Path validation — same realpath canonicalization as every other
      // /api/files/* endpoint (commit 158c1c2). Symlinks resolved before
      // the within-base check; rejects traversal + symlink-escape.
      const validation = this.validatePath(rawPath);
      if (!validation.valid) return res.status(403).json({ error: validation.error });
      const watchRoot = validation.path;

      // Stat the resolved path — must be a directory.
      try {
        const st = fs.statSync(watchRoot);
        if (!st.isDirectory()) {
          return res.status(400).json({ error: 'path must be a directory' });
        }
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'path not found' });
        return res.status(500).json({ error: 'stat failed', message: err.message });
      }

      // Race guard: if the parent claudeSession was deleted (or never
      // existed) between request arrival and now, do not register an
      // orphan watcher entry — it would never be cleaned up because the
      // session-delete handler has nothing to key off. Reply 200 + SSE
      // end-event with reason='session_missing' so the EventSource client
      // closes cleanly, but DO NOT consume a per-IP slot (otherwise a
      // burst of bogus sessionIds would block legitimate watchers and
      // mask the rate-limit cap behaviour).
      //
      // Runs AFTER path validation (so callers still see 400/403/404 for
      // bad paths even with bogus sessionIds — the same observable
      // surface that test/file-browser-api.test.js asserts) and BEFORE
      // the counter increment (so bogus sessionIds do not consume slots
      // that get released on cleanup, which is what previously cycled
      // the per-IP counter back to 0 and broke the cap test).
      if (!this.claudeSessions.has(sessionId)) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform, no-store');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        try {
          res.write('data: ' + JSON.stringify({ type: 'end', reason: 'session_missing' }) + '\n\n');
          res.end();
        } catch (_) { /* ignore — client may have already disconnected */ }
        return;
      }

      // Increment the concurrent-watcher counter BEFORE async work so a
      // burst of simultaneous requests can't all pass the cap check
      // before any of them increment.
      this._activeWatchersByIp.set(ip, currentCount + 1);

      // SSE response headers — flush immediately so the client EventSource
      // resolves its onopen handler.
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform, no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      function send(obj) {
        try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {}
      }

      let watcher;
      let watcherClosed = false;
      // Per the diagnosed Windows hang on Q:\src with multi-worktree + Claude
      // bulk edits: the 100ms default barely coalesced — a single bulk-edit
      // wave produced thousands of debounce timers. 500ms is still well below
      // the 5s "stale buffer" UX threshold from ADR-0017 but cuts emitted
      // event rate by ~5x under bulk activity.
      const debounceMs = parseInt(process.env.FS_WATCHER_DEBOUNCE_MS, 10) || 500;
      // FS_WATCHER_STABILITY_MS env: defaults to 80ms (the tuned-down
      // value per ADR-0017 §Coalescing). Setting to 0 DISABLES chokidar's
      // awaitWriteFinish entirely — useful in tests where sync
      // writeFileSync races chokidar's poll cycle. Must NOT be 0 in
      // production (loses read-during-write protection).
      const rawStability = process.env.FS_WATCHER_STABILITY_MS;
      const stabilityMs = rawStability !== undefined && rawStability !== ''
        ? parseInt(rawStability, 10)
        : 80;
      const disableAwaitWriteFinish = stabilityMs === 0;
      const pollIntervalMs = parseInt(process.env.FS_WATCHER_POLL_MS, 10) || 30;
      // FS_WATCHER_USE_POLLING=1 → chokidar uses fs.stat-loop instead of
      // FSEvents/inotify. Test-only: bypasses FSEvents flakiness on
      // macOS with sync writeFileSync. Production stays on native
      // OS backend.
      const usePolling = process.env.FS_WATCHER_USE_POLLING === '1';
      const ignoreFromEnv = (process.env.FS_WATCHER_IGNORE || '').split(',').map((s) => s.trim()).filter(Boolean);
      const self = this;

      function decrementWatcherCount() {
        if (!self._activeWatchersByIp) return;
        const c = self._activeWatchersByIp.get(ip) || 0;
        if (c <= 1) self._activeWatchersByIp.delete(ip);
        else self._activeWatchersByIp.set(ip, c - 1);
      }

      function cleanup(reason) {
        if (watcherClosed) return;
        watcherClosed = true;
        decrementWatcherCount();
        if (self._fsWatchSessions.get(sessionId) === sessionEntry) {
          self._fsWatchSessions.delete(sessionId);
        }
        if (watcher) {
          watcher.close().catch(() => {});
        }
        try {
          send({ type: 'end', reason: reason });
          res.end();
        } catch (_) {}
      }

      // Register the session entry BEFORE chokidar startup so concurrent
      // POST subscribe/unsubscribe calls during startup find it (they'll
      // race-add to the watcher's subscription set; subscribe() is safe
      // to call any time after FileWatcher construction).
      const sessionEntry = {
        watcher: null,        // assigned after FileWatcher construction
        send: send,
        cleanup: cleanup,
        ip: ip,
        res: res,             // for manual-fallback teardown in _cleanupFsWatchSession
      };

      // Race guard: if the parent claudeSession was deleted (or never
      // existed) between request arrival and now, do not register an
      // orphan watcher entry — it would never be cleaned up because the
      // session-delete handler has nothing to key off. Run cleanup
      // immediately and bail out. This is the load-bearing fix for the
      // PR #99 leak: every entry in _fsWatchSessions now corresponds to
      // a live claudeSession.
      if (!this.claudeSessions.has(sessionId)) {
        cleanup('session_missing');
        return;
      }

      this._fsWatchSessions.set(sessionId, sessionEntry);

      try {
        watcher = new FileWatcher({
          watchRoot: watchRoot,
          debounceMs: debounceMs,
          stabilityMs: stabilityMs,
          pollIntervalMs: pollIntervalMs,
          // FS_WATCHER_STABILITY_MS=0 → disable awaitWriteFinish entirely.
          // For test-only timing-control; production keeps the default tuned
          // 80/30 for read-during-write protection.
          awaitWriteFinish: disableAwaitWriteFinish ? false : undefined,
          // FS_WATCHER_USE_POLLING=1 → chokidar uses fs.stat-loop backend.
          usePolling: usePolling,
          ignoreDirs: ignoreFromEnv.length ? ignoreFromEnv : undefined,
          // Narrow scope: chokidar only watches direct children of every
          // subscribed path (vs. the prior recursive watch of the entire
          // watchRoot tree). This is the load-bearing knob that bounds
          // active_handles on large/multi-worktree trees — the symptom
          // that prompted the unhang work. The client's existing soft-
          // filter subscription model (current dir + open tabs) drives
          // what chokidar actually watches via add()/unwatch() inside
          // FileWatcher. Subscriptions for paths NOT in the displayed
          // dir or an open tab don't allocate watch handles at all.
          depth: 0,
        });
        sessionEntry.watcher = watcher;

        watcher.on('event', (evt) => {
          if (watcherClosed) return;
          // Per-session emission cap (100/min). Bucketed by session id
          // for accuracy across IP-shared environments (proxy / NAT).
          const rl = self._perIpRateLimit({
            ip: 'session:' + sessionId,
            connection: { remoteAddress: 'session:' + sessionId },
          }, 'watch-emit', 100, 60_000);
          if (rl) {
            // Drop the event silently per ADR-0017 §Rate limiting layer 2.
            return;
          }
          send(evt);
        });

        watcher.on('error', (err) => {
          send({ type: 'error', message: (err && err.message) || String(err) });
          // Don't terminate on transient chokidar errors (perm-denied on
          // walk, etc.) — surface them but keep the channel open.
        });

        await watcher.start();
        send({ type: 'start' });
      } catch (err) {
        cleanup('watcher-error');
        return;
      }

      // Client disconnect → close the watcher, decrement the per-IP
      // counter, and free kernel watch resources immediately.
      req.on('close', () => cleanup('client-disconnect'));
    });

    // POST /api/files/watch/subscribe — add a path to the active session's
    // subscription set. Required: ?session=<id>&path=<absolute>.
    // Optional: ?recursive=1 — subscribes the path AS A DIRECTORY-RECURSIVE
    // match (events for the dir AND any descendant fire). Used by
    // FileBrowserPanel for the "auto-refresh listing on agent-create"
    // case where the new file's path isn't known at subscribe time.
    // Default (no flag): exact-path subscription.
    // Returns 204 on success; 404 if no EventSource is open for the session;
    // 403 if path fails validatePath.
    this.app.post('/api/files/watch/subscribe', express.json({ limit: '64kb' }), async (req, res) => {
      const sessionId = req.query.session || (req.body && req.body.session);
      const rawPath = req.query.path || (req.body && req.body.path);
      const recursive = req.query.recursive === '1' ||
                        (req.body && (req.body.recursive === '1' || req.body.recursive === true));
      if (!sessionId || !rawPath) {
        return res.status(400).json({ error: 'session and path are required' });
      }

      if (!this._fsWatchSessions) this._fsWatchSessions = new Map();
      const entry = this._fsWatchSessions.get(sessionId);
      if (!entry || !entry.watcher) {
        return res.status(404).json({ error: 'no active watcher for session; open EventSource first' });
      }

      const validation = this.validatePath(rawPath);
      if (!validation.valid) return res.status(403).json({ error: validation.error });

      try {
        await entry.watcher.subscribe(validation.path, { recursive: recursive });
      } catch (err) {
        return res.status(500).json({ error: 'subscribe failed', message: err.message });
      }
      res.status(204).end();
    });

    // POST /api/files/watch/unsubscribe — remove a path from the active
    // session's subscription set. Idempotent — returns 204 even if the
    // path was never subscribed.
    // Optional: ?recursive=1 — must MATCH the flavour the path was
    // subscribed with. Calling with the wrong flavour is a no-op (the
    // exact-flavour subscription stays). This lets clients safely "remove
    // both flavours" by issuing both calls without prior knowledge.
    this.app.post('/api/files/watch/unsubscribe', express.json({ limit: '64kb' }), async (req, res) => {
      const sessionId = req.query.session || (req.body && req.body.session);
      const rawPath = req.query.path || (req.body && req.body.path);
      const recursive = req.query.recursive === '1' ||
                        (req.body && (req.body.recursive === '1' || req.body.recursive === true));
      if (!sessionId || !rawPath) {
        return res.status(400).json({ error: 'session and path are required' });
      }

      if (!this._fsWatchSessions) this._fsWatchSessions = new Map();
      const entry = this._fsWatchSessions.get(sessionId);
      if (!entry || !entry.watcher) {
        // Idempotent: no-op, return 204.
        return res.status(204).end();
      }

      // Skip validatePath here — unsubscribe with a path that's outside
      // baseFolder is a no-op since it could never have been subscribed
      // in the first place. We still resolve to canonical form to match
      // however subscribe() stored it.
      const canonicalPath = path.resolve(rawPath);

      try {
        await entry.watcher.unsubscribe(canonicalPath, { recursive: recursive });
      } catch (err) {
        return res.status(500).json({ error: 'unsubscribe failed', message: err.message });
      }
      res.status(204).end();
    });


    this.app.put('/api/files/content', async (req, res) => {
      const { path: filePath, content, hash } = req.body;
      if (!filePath) return res.status(400).json({ error: 'Path is required' });
      if (content === undefined || content === null) return res.status(400).json({ error: 'Content is required' });

      const validation = this.validatePath(filePath);
      if (!validation.valid) return res.status(403).json({ error: validation.error });

      const resolvedPath = validation.path;

      // Check content size (5MB limit for editor saves)
      if (Buffer.byteLength(content, 'utf-8') > 5 * 1024 * 1024) {
        return res.status(413).json({ error: 'Content too large (>5MB)' });
      }

      try {
        // Hash-based conflict detection
        if (hash && fs.existsSync(resolvedPath)) {
          const currentHash = await computeFileHash(resolvedPath);
          if (currentHash !== hash) {
            return res.status(409).json({
              error: 'File was modified externally',
              currentHash,
              yourHash: hash,
            });
          }
        }

        await fs.promises.writeFile(resolvedPath, content, 'utf-8');
        const newHash = await computeFileHash(resolvedPath);
        const stat = await fs.promises.stat(resolvedPath);

        res.json({ hash: newHash, size: stat.size });
      } catch (error) {
        if (error.code === 'ENOSPC') {
          return res.status(507).json({ error: 'Insufficient storage space' });
        }
        res.status(500).json({ error: 'Failed to save file', message: error.message });
      }
    });

    // POST /api/files/upload — Upload file (base64 JSON, route-specific limit).
    //
    // Generic-drop reinforcements (file-browser.md §"Generic file drop"):
    //
    //   - Per-session size cap: when the upload targets a `.claude-attachments/`
    //     directory, total bytes in that dir cannot exceed 100 MB. Over-cap
    //     attempts return 413 with `code: "attachment_cap_exceeded"` so the
    //     client can switch on that to show the specific toast (vs the
    //     generic >10MB message).
    //
    //   - .gitignore append: on a successful upload to `.claude-attachments/`,
    //     append `.claude-attachments/` to the parent directory's .gitignore
    //     IF that file exists and the line isn't already present. Best-effort
    //     — never fails the upload on .gitignore errors. Idempotent (line is
    //     not duplicated). The .gitignore is NOT auto-created when missing,
    //     per spec ("user shell config is sacrosanct" applies to .gitignore
    //     too — we don't want to silently introduce a new tracked-by-default
    //     side effect on the user's repo).
    // POST /api/images/upload — image paste/drop/pick upload (base64 JSON).
    // Images go over HTTP (not the WS image_upload path) so a real photo's
    // base64 (~5.5 MB) is not force-closed by the 1 MiB WS JSON guard. Mirrors
    // handleImageUpload's pipeline via the shared _persistImageUpload core and
    // returns the temp file path the client injects into the terminal.
    this.app.post('/api/images/upload', express.json({ limit: '20mb' }), async (req, res) => {
      const { sessionId, base64, mimeType, fileName, caption } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const session = this.claudeSessions.get(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      try {
        const result = await this._persistImageUpload(session, { base64, mimeType, fileName, caption });
        return res.json({ filePath: result.filePath, mimeType, size: result.size });
      } catch (error) {
        if (!error.userMessage) console.error('Image HTTP upload error:', error);
        return res.status(error.status || 500).json({ error: error.userMessage || 'Failed to save image' });
      }
    });

    // Route parser limit is sized for base64 of the 10 MB decoded cap
    // (~14 MB) plus the small JSON envelope. The decoded-size guard below
    // (buffer.length > 10 MB) remains the real per-file cap. This parser is
    // the ONLY one that runs for this route — the global parser above skips
    // `/api/files/upload`, so this limit governs (not the ~100kb default).
    this.app.post('/api/files/upload', express.json({ limit: '20mb' }), async (req, res) => {
      const { targetDir, fileName, content, overwrite } = req.body;
      if (!targetDir || !fileName || !content) {
        return res.status(400).json({ error: 'targetDir, fileName, and content are required' });
      }

      // Validate target directory
      const dirValidation = this.validatePath(targetDir);
      if (!dirValidation.valid) return res.status(403).json({ error: dirValidation.error });

      // Sanitize and validate filename
      let safeName;
      try {
        safeName = sanitizeFileName(fileName);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }

      if (isBlockedExtension(safeName)) {
        return res.status(403).json({ error: `Upload of ${path.extname(safeName)} files is not allowed` });
      }

      const targetPath = path.join(dirValidation.path, safeName);

      // Validate the full target path is still within base
      const targetValidation = this.validatePath(targetPath);
      if (!targetValidation.valid) return res.status(403).json({ error: targetValidation.error });

      try {
        // Check if file already exists
        if (fs.existsSync(targetPath) && !overwrite) {
          return res.status(409).json({ error: 'File already exists', fileName: safeName });
        }

        // Ensure parent directory exists (for directory upload with relative paths)
        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) {
          // Validate each directory level is within base
          const parentValidation = this.validatePath(parentDir);
          if (!parentValidation.valid) return res.status(403).json({ error: parentValidation.error });
          await fs.promises.mkdir(parentDir, { recursive: true });
        }

        // Decode base64 and write
        const buffer = Buffer.from(content, 'base64');
        if (buffer.length > 10 * 1024 * 1024) {
          return res.status(413).json({ error: 'File too large (>10MB)' });
        }

        // Generic-drop per-session cap (.claude-attachments/ only). The cap
        // applies whenever the resolved target dir's basename matches the
        // `.claude-attachments` convention — that's the namespace the
        // generic-drop client owns. Other targetDirs are unaffected.
        const isAttachmentDir = path.basename(dirValidation.path) === '.claude-attachments';
        if (isAttachmentDir) {
          const currentSize = this._attachmentDirBytes(dirValidation.path);
          if (currentSize + buffer.length > this._attachmentSessionCapBytes()) {
            return res.status(413).json({
              error: 'Attachment cap reached for this session — delete some via terminal or wait for the 24 h sweep',
              code: 'attachment_cap_exceeded',
              capBytes: this._attachmentSessionCapBytes(),
              currentBytes: currentSize,
            });
          }
        }

        await fs.promises.writeFile(targetPath, buffer);
        const stat = await fs.promises.stat(targetPath);

        // HOT-09: incrementally update the attachment-dir bytes cache so
        // the next upload doesn't pay an O(N) re-scan. Safe no-op if the
        // cache isn't populated yet (next read will full-scan).
        if (isAttachmentDir) {
          this._attachmentDirCacheRecordWrite(dirValidation.path, stat.size);
        }

        // Best-effort .gitignore guard — never fails the upload on error.
        if (isAttachmentDir) {
          this._ensureAttachmentsGitignore(path.dirname(dirValidation.path));
        }

        res.json({
          name: safeName,
          path: normalizePath(targetPath),
          size: stat.size,
        });
      } catch (error) {
        if (error.code === 'ENOSPC') {
          return res.status(507).json({ error: 'Insufficient storage space' });
        }
        res.status(500).json({ error: 'Failed to upload file', message: error.message });
      }
    });


    this.app.post('/api/set-working-dir', (req, res) => {
      const { path: selectedPath } = req.body;
      
      // Validate the path
      const validation = this.validatePath(selectedPath);
      if (!validation.valid) {
        return res.status(403).json({ 
          error: validation.error,
          message: 'Cannot set working directory outside the allowed area' 
        });
      }
      
      const validatedPath = validation.path;
      
      try {
        if (!fs.existsSync(validatedPath)) {
          return res.status(404).json({ error: 'Directory does not exist' });
        }
        
        const stats = fs.statSync(validatedPath);
        if (!stats.isDirectory()) {
          return res.status(400).json({ error: 'Path is not a directory' });
        }
        
        this.selectedWorkingDir = validatedPath;
        res.json({ 
          success: true, 
          workingDir: this.selectedWorkingDir 
        });
      } catch (error) {
        res.status(500).json({ 
          error: 'Failed to set working directory',
          message: error.message 
        });
      }
    });

    this.app.post('/api/folders/select', (req, res) => {
      try {
        const { path: selectedPath } = req.body;
        
        // Validate the path
        const validation = this.validatePath(selectedPath);
        if (!validation.valid) {
          return res.status(403).json({ 
            error: validation.error,
            message: 'Cannot select directory outside the allowed area' 
          });
        }
        
        const validatedPath = validation.path;
        
        // Verify the path exists and is a directory
        if (!fs.existsSync(validatedPath) || !fs.statSync(validatedPath).isDirectory()) {
          return res.status(400).json({ 
            error: 'Invalid directory path' 
          });
        }
        
        // Store the selected working directory
        this.selectedWorkingDir = validatedPath;
        
        res.json({ 
          success: true,
          workingDir: this.selectedWorkingDir
        });
      } catch (error) {
        res.status(500).json({ 
          error: 'Failed to set working directory',
          message: error.message 
        });
      }
    });

    this.app.post('/api/close-session', (req, res) => {
      try {
        // Clear the selected working directory
        this.selectedWorkingDir = null;
        
        res.json({ 
          success: true,
          message: 'Working directory cleared'
        });
      } catch (error) {
        res.status(500).json({ 
          error: 'Failed to clear working directory',
          message: error.message 
        });
      }
    });

    this.app.get('/', (req, res) => {
      if (global.__SEA_MODE__) {
        this._sendSeaAsset(res, 'public/index.html');
      } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
      }
    });

    // Body-parser error handler (4-arg, must be registered AFTER routes).
    // express.json() rejects oversized/malformed bodies via next(err) BEFORE
    // the route runs; without this, Express's default handler returns HTML,
    // which the JSON API clients can't parse. We key on err.type — the marker
    // body-parser stamps on its own errors — so unrelated next(err) calls are
    // left to the default handler.
    this.app.use((err, req, res, next) => {
      if (res.headersSent || !err || !err.type) return next(err);
      if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body too large' });
      }
      if (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported'
          || err.type === 'charset.unsupported' || err.type === 'entity.verify.failed') {
        return res.status(err.status || err.statusCode || 400).json({ error: 'Invalid request body' });
      }
      return next(err);
    });
  }

  /**
   * Serve a static asset from the SEA blob. Returns true if sent, false if not found.
   */
  _sendSeaAsset(res, assetKey) {
    try {
      const sea = require('node:sea');
      const assetKeys = sea.getAssetKeys();
      if (!assetKeys.includes(assetKey)) return false;

      const data = Buffer.from(sea.getRawAsset(assetKey));
      const ext = path.extname(assetKey).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2'
      };
      res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      res.send(data);
      return true;
    } catch {
      return false;
    }
  }

  async start() {
    // Run session loading and command discovery in parallel
    await Promise.all([
      this._sessionsLoaded,
      this.claudeBridge._commandReady,
      this.codexBridge._commandReady,
      this.copilotBridge._commandReady,
      this.geminiBridge._commandReady,
      this.terminalBridge._commandReady,
    ]);

    // Search-backend startup gate (ADR-0018). Hard-error with actionable
    // guidance if neither system rg nor the @vscode/ripgrep bundled
    // binary is usable, instead of letting the broken state surface
    // later as cryptic "0 matches" UI behaviour. Recovering with a
    // degraded "search disabled" mode is an explicit non-goal for v1 —
    // the file-browser feature treats search as load-bearing.
    search.requireBackendAtStartup();

    // STT model is pulled on startup (in the worker thread, off the event loop —
    // the earlier "eager load hung the terminal" theory was disproven; the hang
    // was a Bun/node-pty bug, not STT CPU load). The mic feature stays disabled
    // on the client until the model is `ready`. Self-gates: a disabled/under-test
    // engine no-ops without downloading. An external endpoint inits cheaply.
    this._ensureSttModel();

    // Sticky-note (Gemma) model is also pulled on startup so it is `ready` by the
    // time an AI tab opens. Self-gates: disabled / under-test / Bun → no-op (the
    // engine never loads node-llama-cpp under Bun, which would crash it). Loads in
    // its own worker thread, so the ~806MB pull never blocks the event loop.
    this._ensureStickyNoteEngine();

    let server;
    let wsHost; // the server the WebSocket server attaches to (TLS server in HTTPS mode)

    if (this.useHttps) {
      let cert, key;
      if (this.certFile && this.keyFile) {
        // User-provided certs
        cert = fs.readFileSync(this.certFile);
        key = fs.readFileSync(this.keyFile);
      } else {
        // Auto-generate self-signed cert for LAN use.
        // Note: a self-signed cert is not a trusted "secure context", so on a LAN IP the
        // browser warns and the PWA can't be installed. For an installable trusted origin
        // use --tunnel (public cert, no admin) or access the app on http://localhost (a
        // secure context with no cert needed).
        const { ensureCert } = require('./utils/self-signed-cert');
        const certInfo = ensureCert();
        cert = certInfo.cert;
        key = certInfo.key;
        const action = certInfo.generated ? 'Generated' : 'Using cached';
        console.log(`\n[HTTPS] ${action} self-signed certificate`);
        if (certInfo.ips.length > 0) {
          console.log(`        Covers: localhost, ${certInfo.ips.join(', ')}`);
        }
        console.log(`        Cached at: ${certInfo.certPath}`);
        console.log('        Browsers will show a security warning on first visit.');
        console.log('        For a trusted, installable origin use \x1b[1m--tunnel\x1b[0m.');
      }

      // The real TLS app server. The WebSocket server attaches HERE so a wss://
      // upgrade arrives over an encrypted TLSSocket (req.socket.encrypted stays
      // true for the secure-context / voice checks).
      const tlsServer = https.createServer({ cert, key }, this.app);

      // Build the https redirect target from the SAME host:port the client
      // reached. The Host header is client-controlled, so accept ONLY a bare
      // hostname[:port] (or [ipv6][:port]) — reject userinfo (`@`), paths, and
      // control chars to prevent an open redirect to an external origin
      // (e.g. Host: user:pass@evil.com). Fall back to localhost otherwise.
      const redirectLocation = (req) => {
        const raw = String(req.headers.host || '');
        const validHost = /^[A-Za-z0-9.-]+(?::\d+)?$/.test(raw)
          || /^\[[0-9a-fA-F:]+\](?::\d+)?$/.test(raw);
        const hostname = validHost ? raw.replace(/:\d+$/, '') : 'localhost';
        const port = req.socket.localPort || this.port;
        // req.url is parser-validated (no CR/LF in a valid request target).
        return `https://${hostname}:${port}${req.url}`.replace(/[\r\n]/g, '');
      };

      // Plaintext HTTP on the SAME port -> redirect to https. A user who reaches
      // http://host:PORT is auto-upgraded instead of getting an opaque
      // TLS-handshake error. 307 keeps the method and is not cached as permanent
      // (switching the port back to http mode later isn't poisoned by a stale 301).
      const httpRedirectServer = http.createServer((req, res) => {
        const location = redirectLocation(req);
        res.writeHead(307, { Location: location, 'Content-Type': 'text/plain' });
        res.end(`Redirecting to ${location}\n`);
      });
      // A plaintext ws:// upgrade to the TLS port: answer with the same redirect
      // (written raw — an upgrade has no res object) instead of an abrupt RST.
      httpRedirectServer.on('upgrade', (req, socket) => {
        const location = redirectLocation(req);
        try {
          socket.end(
            'HTTP/1.1 307 Temporary Redirect\r\n' +
            `Location: ${location}\r\n` +
            'Connection: close\r\n\r\n'
          );
        } catch (_) { try { socket.destroy(); } catch (__) { /* ignore */ } }
      });

      // Front both with a 1-byte sniffer: a TLS ClientHello starts with 0x16
      // (handshake record); anything else is plaintext HTTP. One listening port
      // therefore serves both — http:// and https:// to PORT both work.
      this._proxySockets = new Set();
      server = net.createServer((socket) => {
        this._proxySockets.add(socket);
        socket.once('close', () => this._proxySockets.delete(socket));
        // Pre-handoff guards: drop a connection that errors or sends no data
        // (port scanner / slowloris) before we know which server owns it. Both
        // are cleared the moment we route, so the target server's own lifecycle
        // and timeouts take over cleanly.
        const sniffTimer = setTimeout(() => { try { socket.destroy(); } catch (_) { /* ignore */ } }, 10000);
        const onSniffError = () => {
          clearTimeout(sniffTimer);
          try { socket.destroy(); } catch (_) { /* ignore */ }
        };
        socket.on('error', onSniffError);
        socket.once('readable', () => {
          clearTimeout(sniffTimer);
          socket.removeListener('error', onSniffError);
          const chunk = socket.read(1);
          if (!chunk) { socket.destroy(); return; }
          socket.unshift(chunk);
          const target = chunk[0] === 0x16 ? tlsServer : httpRedirectServer;
          target.emit('connection', socket);
        });
      });

      this._tlsServer = tlsServer;
      this._httpRedirectServer = httpRedirectServer;
      wsHost = tlsServer;
      console.log('        http:// requests on this port auto-upgrade to https.');
    } else {
      server = http.createServer(this.app);
      this._tlsServer = null;
      this._httpRedirectServer = null;
      wsHost = server;
    }

    this.wss = new WebSocket.Server({
      server: wsHost,
      maxPayload: 8 * 1024 * 1024,
      // Compression disabled — binary frames already send with compress:false,
      // and JSON control messages are small/infrequent. Saves ~300KB per connection
      // in zlib context allocation and eliminates thread pool contention.
      perMessageDeflate: false,
      verifyClient: (info) => {
        if (!this.noAuth && this.auth) {
          const url = new URL(info.req.url, 'ws://localhost');
          const token = url.searchParams.get('token');
          // Parity with the HTTP auth middleware: accept the bearer token via the
          // Authorization header too, so a reverse proxy / mesh sidecar that injects
          // `Authorization: Bearer <token>` on the WS upgrade authenticates the socket.
          const header = info.req.headers && info.req.headers['authorization'];
          return token === this.auth || header === `Bearer ${this.auth}`;
        }
        return true;
      }
    });

    this.wss.on('connection', (ws, req) => {
      this.handleWebSocketConnection(ws, req);
    });

    // WS keepalive: DERP relays (mesh mode) drop idle sockets; a server ping
    // every 15s keeps long-lived terminal connections alive and reaps dead ones.
    this._wsKeepalive = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.readyState === WebSocket.OPEN) { try { ws.ping(); } catch (_) {} }
      }
    }, 15000);
    if (this._wsKeepalive.unref) this._wsKeepalive.unref();
    this.wss.on('close', () => clearInterval(this._wsKeepalive));

    return new Promise((resolve, reject) => {
      const onListen = (err) => {
        if (err) {
          reject(err);
        } else {
          this.server = server;
          // Now listening — hold the OS awake for the server's lifetime
          // (Windows only; no-op elsewhere; never throws).
          this.keepaliveManager.start();
          resolve(server);
        }
      };
      // bindHost null → all interfaces (default). Mesh pins 127.0.0.1.
      if (this.bindHost) server.listen(this.port, this.bindHost, onListen);
      else server.listen(this.port, onListen);
    });
  }

  handleWebSocketConnection(ws, req) {
    const wsId = uuidv4(); // Unique ID for this WebSocket connection
    const url = new URL(req.url, `ws://localhost`);
    const claudeSessionId = url.searchParams.get('sessionId');
    
    if (this.dev) {
      console.log(`New WebSocket connection: ${wsId}`);
      if (claudeSessionId) {
        console.log(`Joining Claude session: ${claudeSessionId}`);
      }
    }

    // Store WebSocket connection info
    const wsInfo = {
      id: wsId,
      ws,
      claudeSessionId: null,
      created: new Date(),
      secure: !!req.connection.encrypted
    };
    this.webSocketConnections.set(wsId, wsInfo);

    ws.on('message', (message, isBinary) => {
      // Inbound BINARY frames are voice audio (client mic). Handle them BEFORE
      // the JSON guard below: they legitimately exceed 1 MiB (up to 3.84 MB of
      // 120 s PCM) and must not be killed by the text-frame guard. They are
      // still bounded (oversize -> 1009; bad/short header -> 1003) so this does
      // not reopen the event-loop-DoS hole the JSON guard closes.
      if (isBinary) {
        // ws delivers a Buffer when un-fragmented and a Buffer[] when the frame
        // arrived in multiple WS continuation fragments. Normalize first, then
        // classify on the normalized buffer (never on `message.length`, which is
        // the fragment COUNT for an array).
        const buf = normalizeBinaryMessage(message);
        const verdict = classifyVoiceFrame(buf);
        if (verdict.action === 'oversize') {
          try {
            this.sendToWebSocket(ws, {
              type: 'error',
              code: 'message_too_large',
              message: `Binary voice frame exceeds ${MAX_VOICE_BINARY_FRAME_BYTES} bytes`,
              received_bytes: buf.length,
              limit_bytes: MAX_VOICE_BINARY_FRAME_BYTES,
            });
          } catch (_) { /* socket may be half-closed */ }
          try { ws.close(1009, 'message_too_large'); } catch (_) {}
          return;
        }
        if (verdict.action === 'unsupported') {
          try { ws.close(1003, 'unsupported binary'); } catch (_) {}
          return;
        }
        this.handleVoiceBinary(wsId, verdict.pcm);
        return;
      }
      // HOT-08: application-layer size guard, runs BEFORE JSON.parse.
      // Buffer.byteLength handles both string and Buffer message types.
      // On oversize, send a marker error frame and close with WS-standard
      // 1009 ("message too big"). A buggy or malicious client repeatedly
      // sending 8 MB frames at 10 Hz would otherwise stall the event loop
      // for ~400 ms/s (per HOT-03 memo).
      const byteLen = Buffer.byteLength(message);
      if (byteLen > MAX_WS_MESSAGE_BYTES) {
        try {
          this.sendToWebSocket(ws, {
            type: 'error',
            code: 'message_too_large',
            message: `WebSocket message exceeds ${MAX_WS_MESSAGE_BYTES} bytes`,
            received_bytes: byteLen,
            limit_bytes: MAX_WS_MESSAGE_BYTES,
          });
        } catch (_) { /* socket may be already half-closed */ }
        try { ws.close(1009, 'message_too_large'); } catch (_) {}
        return;
      }
      try {
        const data = JSON.parse(message);
        if (data.type === 'input') {
          // Input gets highest priority via nextTick — runs before
          // output flush timers (setTimeout/setImmediate) in the event loop
          process.nextTick(() => {
            this.handleMessage(wsId, data).catch(error => {
              if (this.dev) console.error('Error handling input:', error);
            });
          });
        } else {
          this.handleMessage(wsId, data).catch(error => {
            if (this.dev) console.error('Error handling message:', error);
            this.sendToWebSocket(ws, {
              type: 'error',
              message: 'Failed to process message'
            });
          });
        }
      } catch (error) {
        if (this.dev) {
          console.error('Error parsing message:', error);
        }
        this.sendToWebSocket(ws, {
          type: 'error',
          message: 'Failed to process message'
        });
      }
    });

    ws.on('close', () => {
      if (this.dev) {
        console.log(`WebSocket connection closed: ${wsId}`);
      }
      this.cleanupWebSocketConnection(wsId);
    });

    ws.on('error', (error) => {
      if (this.dev) {
        console.error(`WebSocket error for connection ${wsId}:`, error);
      }
      this.cleanupWebSocketConnection(wsId);
    });

    // Send initial connection message
    this.sendToWebSocket(ws, {
      type: 'connected',
      connectionId: wsId
    });

    // If sessionId provided, auto-join that session
    if (claudeSessionId && this.claudeSessions.has(claudeSessionId)) {
      this.joinClaudeSession(wsId, claudeSessionId);
    }
  }

  async handleMessage(wsId, data) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    switch (data.type) {
      case 'create_session':
        await this.createAndJoinSession(wsId, data.name, data.workingDir);
        break;

      case 'join_session':
        await this.joinClaudeSession(wsId, data.sessionId);
        break;

      case 'leave_session':
        await this.leaveClaudeSession(wsId);
        break;

      case 'start_claude':
        await this.startToolSession(wsId, 'claude', this.claudeBridge, data.options || {}, data.cols, data.rows);
        break;
      case 'start_codex':
        await this.startToolSession(wsId, 'codex', this.codexBridge, data.options || {}, data.cols, data.rows);
        break;
      case 'start_copilot':
        await this.startToolSession(wsId, 'copilot', this.copilotBridge, data.options || {}, data.cols, data.rows);
        break;
      case 'start_gemini':
        await this.startToolSession(wsId, 'gemini', this.geminiBridge, data.options || {}, data.cols, data.rows);
        break;
      case 'start_terminal':
        await this.startToolSession(wsId, 'terminal', this.terminalBridge, data.options || {}, data.cols, data.rows);
        break;
      
      case 'input':
        if (data.data && data.data.length > 256 * 1024) {
          data.data = data.data.slice(0, 256 * 1024);
        }
        if (wsInfo.claudeSessionId) {
          // Verify the session exists and the WebSocket is part of it
          const session = this.claudeSessions.get(wsInfo.claudeSessionId);
          if (session && session.connections.has(wsId)) {
            // Only send if an agent is running in this session
            if (session.active && session.agent) {
              try {
                const inputBridge = this.getBridgeForAgent(session.agent);
                if (inputBridge) {
                  inputBridge.sendInput(wsInfo.claudeSessionId, data.data).catch(error => {
                    if (this.dev) console.error(`Input write failed for session ${wsInfo.claudeSessionId}:`, error.message);
                  });
                }
              } catch (error) {
                if (this.dev) {
                  console.error(`Failed to send input to session ${wsInfo.claudeSessionId}:`, error.message);
                }
                this.sendToWebSocket(wsInfo.ws, {
                  type: 'error',
                  message: 'Agent is not running in this session. Please start an agent first.'
                });
              }
            } else {
              this.sendToWebSocket(wsInfo.ws, {
                type: 'info',
                message: 'No agent is running. Choose an option to start.'
              });
            }
          }
        }
        break;
      
      case 'set_priority':
        if (data.sessions && Array.isArray(data.sessions)) {
          for (const entry of data.sessions) {
            const prioSession = this.claudeSessions.get(entry.sessionId);
            if (prioSession) {
              const wasBg = prioSession.priority === 'background';
              prioSession.priority = entry.priority;
              if (entry.priority === 'foreground') {
                this._foregroundSessionId = entry.sessionId;
                // Background -> foreground: refresh the note so a peek is current.
                if (wasBg) this.stickyNoteSummarizer.focus(entry.sessionId);
              }
              // Flush pending output immediately on background → foreground transition
              if (wasBg && entry.priority === 'foreground' &&
                  prioSession._pendingChunks && prioSession._pendingChunks.length > 0) {
                if (prioSession._outputFlushTimer) {
                  clearTimeout(prioSession._outputFlushTimer);
                  prioSession._outputFlushTimer = null;
                }
                this._flushSessionOutput(entry.sessionId);
              }
            }
          }
        }
        break;

      case 'flow_control':
        if (data.action === 'pause') {
          wsInfo._flowPaused = true;
        } else if (data.action === 'resume') {
          wsInfo._flowPaused = false;
          // Flush any pending output immediately on resume
          if (wsInfo.claudeSessionId) {
            const fcSession = this.claudeSessions.get(wsInfo.claudeSessionId);
            if (!fcSession) break; // Session was deleted
            if (fcSession._pendingChunks && fcSession._pendingChunks.length > 0) {
              this._flushSessionOutput(wsInfo.claudeSessionId);
            }
          }
        }
        break;

      case 'resize':
        if (wsInfo.claudeSessionId) {
          // Verify the session exists and the WebSocket is part of it
          const session = this.claudeSessions.get(wsInfo.claudeSessionId);
          if (session && session.connections.has(wsId)) {
            // Keep the summariser's headless terminal width in sync.
            if (this.stickyNoteSummarizer.isEnabled(wsInfo.claudeSessionId)) {
              this.stickyNoteSummarizer.resize(wsInfo.claudeSessionId, data.cols, data.rows);
            }
            // Only resize if an agent is actually running
            if (session.active && session.agent) {
              try {
                const resizeBridge = this.getBridgeForAgent(session.agent);
                if (resizeBridge) {
                  await resizeBridge.resize(wsInfo.claudeSessionId, data.cols, data.rows);
                }
              } catch (error) {
                if (this.dev) {
                  console.log(`Resize ignored - agent not active in session ${wsInfo.claudeSessionId}`);
                }
              }
            }
          }
        }
        break;
      
      case 'stop':
        if (wsInfo.claudeSessionId) {
          const stopSession = this.claudeSessions.get(wsInfo.claudeSessionId);
          if (!stopSession) break; // Session was deleted
          await this.stopToolSession(wsInfo.claudeSessionId);
        }
        break;

      case 'ping':
        this.sendToWebSocket(wsInfo.ws, { type: 'pong' });
        break;

      case 'restart_server':
        if (!this.supervised) {
          this.sendToWebSocket(wsInfo.ws, {
            type: 'error',
            message: 'Server is not running in supervised mode. Restart manually.'
          });
        } else if (this.restartManager) {
          const result = await this.restartManager.initiateRestart('user_requested');
          if (result === 'rate_limited') {
            this.sendToWebSocket(wsInfo.ws, {
              type: 'error',
              message: 'Restart was requested too recently. Please wait a few minutes.'
            });
          }
        }
        break;

      case 'get_usage':
        this.handleGetUsage(wsInfo);
        break;

      case 'image_upload':
        await this.handleImageUpload(wsId, data);
        break;

      case 'voice_upload':
        await this.handleVoiceUpload(wsId, data);
        break;

      case 'voice_download_model':
        await this.handleVoiceDownloadModel(wsId);
        break;

      case 'voice_status':
        this.sendToWebSocket(wsInfo.ws, {
          type: 'voice_status',
          status: this.sttEngine.getStatus(),
          voiceInput: {
            localStatus: this.sttEngine.getStatus(),
            localEnabled: !!(this.sttEngine._enabled && !this.sttEngine._sttEndpoint),
            cloudAvailable: true,
          },
          progress: this.sttEngine.getDownloadProgress(),
        });
        break;

      case 'set_sticky_notes':
        this._handleSetStickyNotes(wsId, data);
        break;

      case 'set_sticky_active':
        this._handleSetStickyActive(wsId, data);
        break;

      case 'set_tab_name':
        this._handleSetTabName(wsId, data);
        break;

      case 'sticky_notes_status':
        this.sendToWebSocket(wsInfo.ws, {
          type: 'sticky_notes_status',
          status: this.stickyNoteEngine.getStatus(),
          progress: this.stickyNoteEngine.getDownloadProgress(),
        });
        break;

      case 'start_vscode_tunnel':
        await this.handleStartVSCodeTunnel(wsId, data);
        break;

      case 'stop_vscode_tunnel':
        await this.handleStopVSCodeTunnel(wsId, data);
        break;

      case 'vscode_tunnel_status':
        await this.handleVSCodeTunnelStatus(wsId);
        break;

      case 'app_tunnel_status': {
        const wsInfo = this.webSocketConnections.get(wsId);
        const status = this.tunnelManager ? this.tunnelManager.getStatus() : { running: false, publicUrl: null };
        if (wsInfo && wsInfo.ws.readyState === WebSocket.OPEN) {
          wsInfo.ws.send(JSON.stringify({ type: 'app_tunnel_status', ...status }));
        }
        break;
      }

      case 'open_install_terminal': {
        const installInfo = this.installAdvisor.getInstallInfo(data.toolId);
        if (!installInfo) {
          this.sendToWebSocket(wsInfo.ws, { type: 'error', message: `Unknown tool: ${data.toolId}` });
          break;
        }
        // Find the preferred install command
        const method = installInfo.methods.find(m => m.id === (data.method || 'npm')) || installInfo.methods[0];
        const command = method && method.command;

        // Start terminal session first
        await this.startToolSession(wsId, 'terminal', this.terminalBridge, {}, data.cols, data.rows);

        if (command) {
          // Wait for shell to initialize, then pre-type (not execute) the command
          setTimeout(() => {
            const session = this.claudeSessions.get(wsInfo.claudeSessionId);
            if (session && session.active && session.agent === 'terminal') {
              this.terminalBridge.sendInput(wsInfo.claudeSessionId, command).catch(() => {});
            }
          }, 800);
        }
        break;
      }

      default:
        if (this.dev) {
          console.log(`Unknown message type: ${data.type}`);
        }
    }
  }

  async createAndJoinSession(wsId, name, workingDir) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    // DISK-03: refuse new sessions when the circuit breaker is open.
    // Existing sessions continue to function read-only-ish (output
    // buffer is bounded; we just can't durably persist new state).
    if (this._diskFull) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        code: 'disk_full',
        message: 'Cannot create new session — local disk is full. Delete some sessions or free disk space.'
      });
      return;
    }

    // Validate working directory if provided
    let validWorkingDir = this.baseFolder;
    if (workingDir) {
      const validation = this.validatePath(workingDir);
      if (!validation.valid) {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'Cannot create session with working directory outside the allowed area'
        });
        return;
      }
      validWorkingDir = validation.path;
    } else if (this.selectedWorkingDir) {
      validWorkingDir = this.selectedWorkingDir;
    }

    // Create new Claude session
    const sessionId = uuidv4();
    const session = {
      id: sessionId,
      name: name || `Session ${new Date().toLocaleString()}`,
      created: new Date(),
      lastActivity: new Date(),
      active: false,
      workingDir: validWorkingDir,
      connections: new Set([wsId]),
      outputBuffer: new CircularBuffer(1000),
      priority: 'foreground',
      sessionStartTime: null, // Will be set when Claude starts
      sessionUsage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalCost: 0,
        models: {}
      },
      maxBufferSize: 1000,
      // Sticky-note (local-LLM summary) state. Enabled by default for AI tabs;
      // a client can opt out via set_sticky_notes. autoTitle/nameIsUserSet drive
      // auto tab titling without clobbering a manual rename.
      stickyNote: null,
      autoTitle: null,
      nameIsUserSet: false,
      stickyNotesEnabled: this._stickyNotesEnabledGlobally
    };
    
    this.claudeSessions.set(sessionId, session);
    this._pushEvictionEntry(sessionId); // PROC-04
    wsInfo.claudeSessionId = sessionId;
    this.sessionStore.markDirty();

    // Save sessions after creating new one
    this.saveSessionsToDisk();
    
    this.sendToWebSocket(wsInfo.ws, {
      type: 'session_created',
      sessionId,
      sessionName: session.name,
      workingDir: session.workingDir
    });
  }

  async joinClaudeSession(wsId, claudeSessionId) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    const session = this.claudeSessions.get(claudeSessionId);
    if (!session) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Session not found'
      });
      return;
    }

    // Leave current session only if switching to a DIFFERENT one.
    // Same-session re-joins (post-reconnect auto-rejoin, in-app same-tab
    // click) used to emit a spurious `session_left` followed immediately
    // by `session_joined`, which causes the client to briefly null
    // currentClaudeSessionId, clear the terminal, and flicker the tab
    // status to "disconnected" — only to be restored ms later. Skipping
    // the leave makes the re-join silent and idempotent.
    if (wsInfo.claudeSessionId && wsInfo.claudeSessionId !== claudeSessionId) {
      await this.leaveClaudeSession(wsId);
    }

    // Join new session
    wsInfo.claudeSessionId = claudeSessionId;
    session.connections.add(wsId);
    session.lastActivity = new Date();
    this._pushEvictionEntry(claudeSessionId); // PROC-04
    session.lastAccessed = Date.now();

    // Send session info and replay buffer. Prefer a live rendered tail, but
    // never block the join on a slow drain — fall back to the stored snapshot.
    let renderedSnapshot = session.renderedSnapshot || null;
    if (session._ctlTranscript) {
      renderedSnapshot = (await this._peekWithTimeout(session._ctlTranscript, 200, 300)) || renderedSnapshot;
    }
    this.sendToWebSocket(wsInfo.ws, {
      type: 'session_joined',
      sessionId: claudeSessionId,
      sessionName: session.name,
      workingDir: session.workingDir,
      active: session.active,
      wasActive: session.wasActive || false,
      agent: session.agent || null,
      outputBuffer: session.outputBuffer.slice(-200), // Send last 200 lines
      renderedSnapshot, // rendered last screen so idle/empty-buffer joins repaint
      stickyNote: session.stickyNote || null,
      autoTitle: session.nameIsUserSet ? null : (session.autoTitle || null),
      stickyNotesEnabled: session.stickyNotesEnabled !== false,
      // Deliver the engine status on every join so the toolbar toggle reliably
      // appears once the model is ready (the broadcast-on-init can race a late
      // joiner; this never misses).
      stickyNotesStatus: this.stickyNoteEngine.getStatus()
    });

    if (this.dev) {
      console.log(`WebSocket ${wsId} joined Claude session ${claudeSessionId}`);
    }
  }

  async leaveClaudeSession(wsId) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) return;

    const leftSessionId = wsInfo.claudeSessionId;

    const session = this.claudeSessions.get(leftSessionId);
    if (session) {
      session.connections.delete(wsId);
      session.lastActivity = new Date();
      this._pushEvictionEntry(leftSessionId); // PROC-04
    }

    wsInfo.claudeSessionId = null;

    this.sendToWebSocket(wsInfo.ws, {
      type: 'session_left',
      sessionId: leftSessionId
    });
  }

  // Artifact sub-resources (images/css/fonts the artifact HTML references inside
  // the sandboxed iframe) cannot set an Authorization header or inherit the
  // page's ?token=, so artifact <base href> embeds a scoped, per-session token in
  // the asset PATH as /api/artifact/<sessionId>/asset/_auth/<token>/<relpath>.
  // This parses only that scoped token form; bearer auth is never accepted from
  // any URL path.
  _artifactAssetAuthFromPath(req) {
    const p = req && typeof req.path === 'string' ? req.path : '';
    const m = /^\/api\/artifact\/([^/]+)\/asset\/_auth\/([^/]+)(?:\/|$)/.exec(p);
    if (!m) return null;
    try {
      return {
        sessionId: decodeURIComponent(m[1]),
        token: decodeURIComponent(m[2]),
      };
    } catch (_) {
      return null;
    }
  }

  getBridgeForAgent(agentType) {
    const bridges = {
      claude: this.claudeBridge,
      codex: this.codexBridge,
      copilot: this.copilotBridge,
      gemini: this.geminiBridge,
      terminal: this.terminalBridge
    };
    return bridges[agentType] || null;
  }

  // Return the bridge that currently owns a live PTY for `sessionId`, or null.
  // Uses msSinceLastOutput (null when the session is absent/inactive) so we
  // don't reach into a bridge's private session map.
  _bridgeForSession(sessionId) {
    const bridges = [
      this.claudeBridge, this.terminalBridge,
      this.codexBridge, this.copilotBridge, this.geminiBridge,
    ];
    for (const bridge of bridges) {
      if (bridge && typeof bridge.msSinceLastOutput === 'function'
          && bridge.msSinceLastOutput(sessionId) !== null) {
        return bridge;
      }
    }
    return null;
  }

  // Artifact-push hook (wired only when AIORDIE_ARTIFACT_PUSH is enabled). Inject
  // panel feedback into the idle CLI as a NEW turn. Returns true only if it
  // actually wrote to the PTY (the caller then consumes the queued prompts).
  //
  // Idle gate (ADR-0035 hardening / C-P0-6): the transcript turn-state is the
  // PRIMARY gate — a quiet PTY is exactly the pending-menu case, so PTY-quiet
  // alone is unsafe. When a JSONL binding EXISTS, the transcript is authoritative:
  // inject ONLY on idle_at_prompt; decline on awaiting_input / working AND on
  // unknown (a transient read failure on a bound session must NOT fall back to the
  // unsafe PTY-quiet heuristic — that is exactly the menu-injection race this gate
  // closes). Only when there is NO binding (raw claude.exe whose slug doesn't
  // resolve) do we degrade to the original PTY-quiet-only behavior. Read fresh
  // per push (human-paced, so the cost is negligible) to avoid stale-state
  // injection.
  async _pushArtifactFeedbackToAgent(sessionId, text) {
    if (!text || typeof text !== 'string') return false;
    const bridge = this._bridgeForSession(sessionId);
    if (!bridge) return false;

    const binding = this._stickyJsonl && this._stickyJsonl.get(sessionId);
    if (binding && binding.file) {
      const turn = await this._artifactTurnState(binding);
      // Bound session: transcript is the sole authority. Anything but a proven
      // idle-at-prompt declines (awaiting_input / working / unknown).
      return (turn && turn.state === 'idle_at_prompt')
        ? this._writeArtifactPush(bridge, sessionId, text)
        : false;
    }

    // No JSONL binding: degrade to the original PTY-quiet-only heuristic — decline
    // while the PTY emitted output within the quiet window (likely mid-render).
    const quietMs = bridge.msSinceLastOutput(sessionId);
    if (quietMs === null || quietMs < this._artifactPushQuietMs) return false;
    return this._writeArtifactPush(bridge, sessionId, text);
  }

  // Sanitize + bracketed-paste-wrap the human text and write it to the PTY. Pure
  // helper split out so both idle-gate branches share it. Returns true on write.
  async _writeArtifactPush(bridge, sessionId, text) {
    const payload = buildArtifactPushPayload(text);
    if (!payload) return false;
    try {
      await bridge.sendInput(sessionId, payload);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Structured-approval routing (contract §5 / C-P1-4): when a panel action is an
  // approve/reject/choose that answers a pending user-facing menu (ExitPlanMode /
  // AskUserQuestion / permission), deliver it through the control-plane respond
  // path instead of the drain. _controlRespond itself checks detectAwaiting and
  // returns PRECONDITION_FAILED when nothing is pending, so we route only when a
  // menu is genuinely up; otherwise the action falls back to the /await drain.
  async _routeArtifactApproval(sessionId, action) {
    if (!this.claudeSessions || !this.claudeSessions.has(sessionId)) return false;
    const verb = action && action.action;
    const opts = { sessionId };
    if (verb === 'approve') opts.choice = 'accept';
    else if (verb === 'reject') opts.choice = 'reject';
    else if (verb === 'choose') { if (action.value == null) return false; opts.optionValue = action.value; }
    else return false;
    try {
      const result = await this._controlRespond(opts);
      return !!(result && result.delivered && !result.error);
    } catch (_) {
      return false;
    }
  }

  // Fresh transcript turn-state for the artifact push gate. Never cached: a safety
  // gate must not act on a stale idle_at_prompt (an intervening turn could have
  // started). The bounded tail read is cheap and only runs on a human-paced push.
  async _artifactTurnState(binding) {
    if (!binding || !binding.file) return { state: 'unknown' };
    try {
      return (await detectTurnState(binding.file)) || { state: 'unknown' };
    } catch (_) {
      return { state: 'unknown' };
    }
  }

  _buildControlDeps() {
    return {
      sessions: this.claudeSessions,
      eventBus: this.controlEventBus,
      getMeshPeers: () => this.meshManager ? this.meshManager.getStatus().peers : [],
      getStatusSignal: (id) => this._controlStatusSignal(id),
      readTail: async (id, lines) => this._controlReadTail(id, lines),
      createSession: async (opts) => this._controlCreateSession(opts),
      stopSession: async (id, mode, idempotencyKey) => this._controlStopSession(id, mode, idempotencyKey),
      sendMessage: async (opts) => this._controlSendMessage(opts),
      sendKeys: async (opts) => this._controlSendKeys(opts),
      respond: async (opts) => this._controlRespond(opts),
      snapshot: async () => this._controlSnapshot(),
      capabilities: () => this._controlCapabilities(),
    };
  }

  /**
   * F15: an ATOMIC batch snapshot for O(1) reconnect after a cursor gap. Returns
   * every session's full derived status PLUS the event cursor, such that the
   * controller can resume the long-poll from exactly that cursor with zero LOST
   * events. Atomicity rule: capture the cursor FIRST, then build the statuses. Any
   * event that fires while the statuses are being read has seq > cursor and is
   * therefore redelivered on resume — so the worst case is a harmless duplicate
   * (an edge already reflected in the snapshot AND replayed), never a loss.
   *
   * Reconnect protocol (documented in ADR-0032): on a `gap`/`overflow`/`restart`
   * marker from /events, call GET /snapshot, reconcile each session from the
   * returned statuses, then resume the long-poll from `snapshot.cursor`.
   */
  async _controlSnapshot() {
    const cursor = this.controlEventBus ? this.controlEventBus.headCursor() : { epoch: null, seq: 0 };
    const ids = Array.from(this.claudeSessions.keys());
    const sessions = await Promise.all(ids.map(async (id) => {
      const session = this.claudeSessions.get(id);
      if (!session) return null;
      const status = await this._controlDerivedStatus(id);
      return {
        sessionId: id,
        name: session.name,
        agent: session.agent || null,
        workingDir: session.workingDir,
        lifecycle: status ? status.lifecycle : 'unknown',
        interactionState: status ? status.interactionState : 'unknown',
        canAcceptInput: status ? !!status.canAcceptInput : false,
        confidence: status ? status.confidence : 'low',
        lastTurnEndedAt: status && typeof status.lastTurnEndedAt === 'number' ? status.lastTurnEndedAt : null,
        awaiting: (status && status.awaiting) || null,
        sessionStateSeq: this._controlSessionSeqFor(id),
        bound: !!(this._stickyJsonl && this._stickyJsonl.has(id)),
        lastActivity: session.lastActivity || null,
      };
    }));
    return { sessions: sessions.filter(Boolean), cursor, capturedAt: Date.now() };
  }

  /**
   * F19: the cross-repo capability contract. The github-router fleet client reads
   * this ONCE per instance and fails closed (or degrades explicitly) when a needed
   * capability is absent — so a newer client talking to an older ai-or-die never
   * silently believes a permission mode was set or a confirmation is available.
   */
  _controlCapabilities() {
    return {
      capabilities: [
        'permission_mode',     // F10 create_session(permissionMode), validated + conflict-rejecting
        'agent_args',          // F10 create_session(agentArgs[])
        'turn_binding',        // ADR-0026 JSONL turn detection (bound claude)
        'events_cursor',       // F22 cursor-based /events long-poll (epoch:seq, strictly-after)
        'events_retention',    // F15 per-session event ring + overflow gap
        'session_state_seq',   // monotonic per-session state seq surfaced in status/message responses
      ],
      controlVersion: String(CONTROL_CONTRACT_VERSION),
      // Additive extras (the fleet client ignores unknown keys; kept for human/debug + future clients):
      permissionModes: VALID_PERMISSION_MODES,
      events: CONTROL_EVENT_KINDS,
      limits: {
        eventsPerSession: this.controlEventBus ? this.controlEventBus.maxEventsPerSession : null,
        maxReadLines: 2000,
        eventsLongPollMaxMs: 60000,
      },
    };
  }

  /**
   * F16: a per-session STEERING MUTEX — a logical-command queue distinct from the
   * byte-level writeQueue. Two DISTINCT concurrent steering ops (e.g. two
   * send_message, or a send_message + a respond) to the SAME session would each
   * enqueue their bytes separately on the writeQueue and could interleave at the
   * message boundary (text1, text2, \r, \r). This queue serialises the whole op so
   * one completes before the next begins. (The retry-double-submit case is already
   * covered by idempotency + writeQueue; this closes the concurrent-distinct-ops
   * interleave.) Idempotency stays OUTSIDE this lock, so a same-key retry
   * short-circuits to the cached result without ever entering the critical section.
   */
  // NON-REENTRANT: fn() must not call _controlSteeringLock for the same session (would deadlock). All current callers (sendMessage/sendKeys/respond) do a single bridge op - verified no nested acquire.
  _controlSteeringLock(sessionId, fn) {
    if (!this._steeringQueues) this._steeringQueues = new Map();
    const prev = this._steeringQueues.get(sessionId) || Promise.resolve();
    // Run after the previous op settles (success OR failure — a failed op must not
    // wedge the queue). The returned promise carries the real result/rejection.
    const run = prev.then(() => fn(), () => fn());
    // The stored tail is failure-guarded so the chain never rejection-propagates.
    const tail = run.then(() => {}, () => {});
    this._steeringQueues.set(sessionId, tail);
    // Drop the queue entry once drained, so it doesn't leak per dead session.
    tail.then(() => {
      if (this._steeringQueues.get(sessionId) === tail) this._steeringQueues.delete(sessionId);
    });
    return run;
  }


  async _controlStatusSignal(id) {
    const session = this.claudeSessions.get(id);
    if (!session) return {};
    const hadOutput = !!(session.outputBuffer && session.outputBuffer.size && session.outputBuffer.size > 0);
    let renderedTail = '';
    if (session._ctlTranscript) {
      // Wide enough to capture a full approval/question modal header (claude's
      // ExitPlanMode modal is ~8 rows tall, so an 8-row snapshot clips the
      // "Would you like to proceed?" line that awaitingFromScreen keys on).
      // deriveStatus applies the busy-footer regex to only the last few rows, so
      // a wide window does not cause false-busy from stale scrollback.
      try { renderedTail = await session._ctlTranscript.snapshot(20); } catch (_) { renderedTail = ''; }
    } else if (session.outputBuffer) {
      renderedTail = session.outputBuffer.slice(-6).join('\n');
    }
    const b = this._stickyJsonl.get(id);
    const jsonl = b ? {
      bound: true,
      endsOnAssistant: !!b.lastEndsOnAssistant,
      growing: !!b.lastGrowing,
      lastTurnEndedAt: b.lastTurnEndedAt,
    } : undefined;
    if (jsonl && b.file) {
      const awaiting = await this._controlDetectAwaitingCached(b);
      if (awaiting) Object.assign(jsonl, awaiting);
    }
    return { hadOutput, jsonl, renderedTail, exit: session._lastExit || null };
  }

  async _controlDetectAwaitingCached(binding) {
    if (!binding || !binding.file) return null;
    const now = Date.now();
    if (binding._awaitingAt && now - binding._awaitingAt < 1000) return binding._awaiting || null;
    const awaiting = await detectAwaiting(binding.file);
    binding._awaiting = awaiting || null;
    binding._awaitingAt = now;
    return binding._awaiting;
  }

  async _controlDerivedStatus(id) {
    const session = this.claudeSessions.get(id);
    if (!session) return null;
    const signal = await this._controlStatusSignal(id);
    return deriveStatus({
      session: { ...session, hadOutput: signal.hadOutput },
      jsonl: signal.jsonl,
      renderedTail: signal.renderedTail,
      exit: signal.exit,
      // F12: coarse PTY-output recency feeds the UNBOUND busy/idle fallback. Only
      // consulted when there is no JSONL binding; bound claude returns earlier on
      // the authoritative transcript turn state.
      lastOutputAt: typeof session._ctlLastOutputAt === 'number' ? session._ctlLastOutputAt : undefined,
      now: Date.now(),
    });
  }

  _controlSessionSeqFor(sessionId) {
    if (!this._controlSessionSeq) this._controlSessionSeq = new Map();
    return this._controlSessionSeq.get(sessionId) || 0;
  }

  _controlBumpSessionSeq(sessionId) {
    if (!this._controlSessionSeq) this._controlSessionSeq = new Map();
    const next = (this._controlSessionSeq.get(sessionId) || 0) + 1;
    this._controlSessionSeq.set(sessionId, next);
    return next;
  }

  _controlAppendStateEvent(sessionId, kind, detail) {
    if (!this.controlEventBus) return;
    const withSeq = kind === 'turn_ended' || kind === 'became_busy' || kind === 'became_idle' || kind === 'waiting_input';
    const eventDetail = detail ? { ...detail } : {};
    if (withSeq) eventDetail.sessionStateSeq = this._controlBumpSessionSeq(sessionId);
    this.controlEventBus.append(sessionId, kind, Object.keys(eventDetail).length ? eventDetail : undefined);
  }

  async _controlEmitInteractionTransition(sessionId) {
    const status = await this._controlDerivedStatus(sessionId);
    if (!status || !status.interactionState) return status;
    const binding = this._stickyJsonl && this._stickyJsonl.get(sessionId);
    // F12: bound sessions debounce the edge on their JSONL binding (authoritative
    // turn state); UNBOUND sessions have no binding, so they debounce on the
    // session object instead — otherwise every poll would re-emit the same coarse
    // PTY-recency edge. We only ever emit became_busy / became_idle here; a real
    // turn_ended is emitted exclusively by the JSONL turn detector (bound only),
    // never faked from the coarse unbound signal (review caveat).
    const stateHolder = binding || this.claudeSessions.get(sessionId);
    const previous = stateHolder ? stateHolder._lastInteractionState : undefined;
    if (previous === status.interactionState) return status;
    if (stateHolder) stateHolder._lastInteractionState = status.interactionState;

    const kind = this._controlEventKindForInteractionState(status.interactionState);
    if (kind) this._controlAppendStateEvent(sessionId, kind, { interactionState: status.interactionState, confidence: status.confidence });
    return status;
  }

  _controlEventKindForInteractionState(interactionState) {
    if (interactionState === 'busy') return 'became_busy';
    if (interactionState === 'idle') return 'became_idle';
    if (interactionState === 'waiting_input') return 'waiting_input';
    return null;
  }

  // F12: record PTY-output recency and drive the COARSE busy/idle edges for
  // UNBOUND active sessions (claude launched inside a `terminal` PTY, or a
  // bound claude whose JSONL sidecar hasn't attached yet). Bound claude returns
  // early — its authoritative turn_ended/became_busy come from the JSONL turn
  // detector, so this coarse path is a no-op there and never competes.
  //
  // Two edges:
  //   - rising  → emit became_busy promptly on the first chunk after quiet
  //               (debounced inside _controlEmitInteractionTransition);
  //   - falling → a LARGE quiet debounce timer; when no further output arrives
  //               within the window, re-derive (now quiet → idle) and emit
  //               became_idle. Reset on every chunk so a streaming turn never
  //               flaps to idle (review caveat).
  // We NEVER emit turn_ended from here — callers key on became_idle for coarse
  // completion; the honest fix for unbound is NO_TURN_BINDING, not a fake turn.
  _controlRecordPtyOutput(sessionId) {
    const session = this.claudeSessions.get(sessionId);
    if (!session) return;
    session._ctlLastOutputAt = Date.now();
    // Bound sessions get authoritative turn detection — skip the coarse path.
    // (Presence in _stickyJsonl == bound: _controlStatusSignal hardcodes bound:true
    // for any entry, and _controlIsTurnAgent keys 'bound' on the same has() check.)
    if (this._stickyJsonl && this._stickyJsonl.has(sessionId)) return;
    // Rising edge: emit became_busy only when NOT already busy. On a fast-streaming
    // PTY (thousands of chunks/sec) this avoids flooding the microtask queue with a
    // _controlDerivedStatus (snapshot + regex) per chunk — event-loop starvation.
    // While already busy, a chunk just refreshes recency above and re-arms the idle
    // timer below; that timer drives the eventual flip back to idle.
    if (session._lastInteractionState !== 'busy' && typeof this._controlEmitInteractionTransition === 'function') {
      Promise.resolve(this._controlEmitInteractionTransition(sessionId)).catch(() => {});
    }
    // Falling edge: re-arm the quiet-debounce timer.
    if (session._ctlIdleTimer) clearTimeout(session._ctlIdleTimer);
    const debounceMs = DEFAULT_UNBOUND_QUIET_MS + 500; // > the recency window so the re-derive reads quiet
    session._ctlIdleTimer = setTimeout(() => {
      session._ctlIdleTimer = null;
      if (typeof this._controlEmitInteractionTransition === 'function') {
        Promise.resolve(this._controlEmitInteractionTransition(sessionId)).catch(() => {});
      }
    }, debounceMs);
    if (session._ctlIdleTimer && session._ctlIdleTimer.unref) session._ctlIdleTimer.unref();
  }

  /**
   * F13: did a NEW activity edge (became_busy / waiting_input) appear AFTER the
   * pre-send cursor? Positive evidence that THIS send started something, as
   * opposed to a lingering prior-turn busy whose edge predates the cursor. Used to
   * gate the unbound dropped-Enter reaper so a retry is only sent when no new edge
   * is observed. Falls back to a status-poll heuristic when no event bus / cursor
   * is available (keeps the legacy behaviour for callers without a bus).
   */
  async _controlAwaitActivityEdge(sessionId, preCursor, timeoutMs) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    if (this.controlEventBus && preCursor) {
      const filter = { sessionIds: [sessionId], kinds: ['became_busy', 'waiting_input'] };
      for (;;) {
        const remaining = Math.max(0, deadline - Date.now());
        const out = await this.controlEventBus.waitFor(preCursor, Math.min(remaining, 600), filter);
        if (out && out.events && out.events.length) return true;
        if (Date.now() >= deadline) return false;
      }
    }
    // No bus / cursor: poll derived status for a visible busy/waiting edge. Clamp
    // each sleep to the remaining budget so a short deadline isn't overshot.
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(600, Math.max(0, deadline - Date.now()))));
      const s = await this._controlDerivedStatus(sessionId);
      if (s && (s.interactionState === 'busy' || s.interactionState === 'waiting_input')) return true;
    }
    return false;
  }

  async _controlReadTail(id, lines) {
    const s = this.claudeSessions.get(id);
    if (!s) return { text: '', truncated: false, source: 'none' };
    // For PTY/TUI agent sessions, return the RENDERED screen (replayed through
    // @xterm/headless) rather than the raw repaint stream, so a reader sees what
    // a human would — not interleaved cursor-move/clear escape sequences.
    if (s._ctlTranscript) {
      try {
        const text = await s._ctlTranscript.snapshot(lines);
        return { text, truncated: false, source: 'rendered' };
      } catch (_) { /* fall back to the raw buffer */ }
    }
    const arr = s.outputBuffer ? s.outputBuffer.slice(-lines) : [];
    return {
      text: arr.join('\n'),
      truncated: (s.outputBuffer && s.outputBuffer.size ? s.outputBuffer.size > lines : false),
      source: 'buffer'
    };
  }

  async _controlCreateSession(opts = {}) {
    return this._controlWithIdempotency('create', opts.idempotencyKey, async () => {
      const { name, workingDir } = opts;
      const sessionId = uuidv4();

      // Validate working directory if provided
      let validWorkingDir = this.baseFolder;
      if (workingDir) {
        const validation = this.validatePath(workingDir);
        if (!validation.valid) {
          const err = new Error('Cannot create session with working directory outside the allowed area');
          err.code = 'INVALID_WORKDIR';
          throw err;
        }
        validWorkingDir = validation.path;
      } else if (this.selectedWorkingDir) {
        validWorkingDir = this.selectedWorkingDir;
      }

      // F10: validate permissionMode/agentArgs UP FRONT (before allocating the
      // session) through the bridge's canonical translation layer, so a bad mode
      // or a conflicting agentArgs flag fails the create with INVALID_ARGUMENT
      // rather than spawning an ambiguous agent. claude's ClaudeBridge.buildArgs
      // validates + rejects; terminal/codex BaseBridge.buildArgs ignores both.
      if (opts.start) {
        const agentForValidation = opts.agent || 'claude';
        const vbridge = this.getBridgeForAgent(agentForValidation);
        if (vbridge && typeof vbridge.buildArgs === 'function') {
          try {
            vbridge.buildArgs({
              dangerouslySkipPermissions: !!opts.dangerouslySkipPermissions,
              permissionMode: opts.permissionMode,
              agentArgs: opts.agentArgs,
            });
          } catch (e) {
            throw this._controlError('INVALID_ARGUMENT', (e && e.message) || 'invalid launch arguments', 400);
          }
        }
      }

      // opts.start spawns the agent headlessly via _controlStartAgent (below).
      const session = {
        id: sessionId,
        name: name || `Session ${new Date().toLocaleString()}`,
        created: new Date(),
        lastActivity: new Date(),
        active: false,
        agent: null, // 'claude' | 'codex' when started
        workingDir: validWorkingDir,
        connections: new Set(),
        outputBuffer: new CircularBuffer(1000),
        priority: 'foreground',
        sessionStartTime: null,
        sessionUsage: {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          totalCost: 0,
          models: {}
        },
        maxBufferSize: 1000
      };

      this.claudeSessions.set(sessionId, session);
      if (typeof this._pushEvictionEntry === 'function') this._pushEvictionEntry(sessionId);
      this.sessionStore.markDirty();
      this.saveSessionsToDisk();
      if (this.controlEventBus) this.controlEventBus.append(sessionId, 'session_created');
      // Headless start: spawn the agent over a PTY with NO WebSocket when
      // requested (the fleet create_session(start:true) path). The agent gets a
      // deterministic JSONL bind sidecar (turn detection) + the artifact tool
      // env-trio so a github-router-claude can drive the review loop.
      let lifecycle = 'created';
      if (opts.start) {
        const agent = opts.agent || 'claude';
        try {
          await this._controlStartAgent(sessionId, agent, {
            cols: opts.cols, rows: opts.rows,
            dangerouslySkipPermissions: !!opts.dangerouslySkipPermissions,
            permissionMode: opts.permissionMode,
            agentArgs: opts.agentArgs,
          });
        } catch (e) {
          lifecycle = 'exited';
          return { sessionId, lifecycle, name: session.name, agent: null, ready: false, bound: false, blocker: { kind: 'start_error', message: (e && e.message) || 'start failed' }, startError: e && e.message };
        }
        // F17: readiness barrier — don't report success the moment the PTY spawns.
        // Wait (bounded) until the agent is actually driveable (claude: JSONL-bound +
        // prompt-ready), or surface a concrete blocker (trust modal / binding pending).
        const readyTimeoutMs = this._controlClampInt(opts.readyTimeoutMs, 12000, 0, 30000);
        const state = await this._controlAwaitReady(sessionId, readyTimeoutMs);
        lifecycle = session.active ? (state.ready ? 'running' : 'starting') : 'exited';
        return {
          sessionId,
          lifecycle,
          name: session.name,
          agent: session.agent || null,
          ready: state.ready,
          bound: state.bound,
          ...(state.blocker ? { blocker: state.blocker } : {}),
        };
      }
      return { sessionId, lifecycle, name: session.name, agent: session.agent || null, ready: false, bound: false };
    });
  }

  // claude.exe boots slowly; ClaudeBridge's single-shot trust-accept Enter can
  // fire before claude is interactive, leaving the folder-trust modal up. For a
  // HEADLESS session (no human to click) re-send Enter while the rendered screen
  // still shows the modal, until it clears. Watches the rendered TranscriptBuffer
  // so it stops the moment trust is accepted (and never submits into the composer).
  _controlReapTrustPrompt(sessionId) {
    const bridge0 = (() => { const s = this.claudeSessions.get(sessionId); return s ? this.getBridgeForAgent(s.agent) : null; })();
    if (!bridge0) return;
    let tries = 0, sawModal = false;
    const tick = async () => {
      const s = this.claudeSessions.get(sessionId);
      if (!s || !s.active || !s._ctlTranscript || tries > 14) return;
      tries++;
      let screen = '';
      try { screen = await s._ctlTranscript.snapshot(40); } catch (_) { /* ignore */ }
      const onModal = TRUST_PROMPT_REGEX.test(screen);
      if (onModal) {
        sawModal = true;
        try { await bridge0.sendInput(sessionId, '\r'); } catch (_) { /* pty may be gone */ }
        setTimeout(tick, 1500);
      } else if (!sawModal && tries < 8) {
        setTimeout(tick, 1500); // modal not up yet (claude still booting) — keep watching
      }
      // modal seen then cleared, or never appeared after the watch window -> stop
    };
    setTimeout(tick, 1500);
  }

  // Artifact-review env trio for a spawned claude session. Injected whenever the
  // server can serve /api/artifact — that's when auth is set OR auth is disabled
  // (noAuth leaves the routes public, server.js:1179). Without it the in-tab
  // agent's artifact_* tools stay dark and the viewer never opens. Token is the
  // real bearer, or a 'noauth' sentinel under --disable-auth (the routes ignore
  // it). Returns {} when the server is closed (auth required but unset), so a
  // misconfigured instance never points the agent at routes it can't reach.
  _artifactEnvForSession(sessionId) {
    if (!this.auth && !this.noAuth) return {};
    return {
      AIORDIE_BASE_URL: `${this.useHttps ? 'https' : 'http'}://127.0.0.1:${this.port}`,
      AIORDIE_TOKEN: this.auth || 'noauth',
      AIORDIE_SESSION_ID: sessionId,
      // Loopback self-signed cert: tell github-router's artifact client to relax
      // TLS verification for this instance (it fails-closed for non-loopback).
      AIORDIE_INSECURE_TLS: this.useHttps ? '1' : '0',
    };
  }

  // Read a transcript's rendered tail, but never block longer than `ms` — a
  // wedged xterm drain must not stall a join or strand a dispose. Resolves null
  // on timeout/error so callers fall back to the stored snapshot.
  _peekWithTimeout(t, lines, ms) {
    return Promise.race([
      Promise.resolve().then(() => t.peek(lines)).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), ms)),
    ]);
  }

  // Capture the last rendered screen, then ALWAYS dispose — so a refresh
  // repaints an exited session, without leaking the buffer if peek hangs.
  _persistSnapshotAndDispose(s) {
    const t = s._ctlTranscript;
    if (!t) return;
    s._ctlTranscript = null;
    this._peekWithTimeout(t, 200, 1000)
      .then((snap) => { if (snap) s.renderedSnapshot = snap; })
      .finally(() => { try { t.dispose(); } catch (_) { /* already disposed */ } });
  }

  // Headless agent spawn (no WebSocket): reuses the same bridge.startSession +
  async _controlStartAgent(sessionId, toolName, opts = {}) {
    const session = this.claudeSessions.get(sessionId);
    if (!session) throw this._controlError('SESSION_NOT_FOUND', 'Unknown session', 404);
    const bridge = this.getBridgeForAgent(toolName);
    if (!bridge) throw this._controlError('INVALID_ARGUMENT', `Unknown agent '${toolName}'`, 400);
    if (session.active) return;
    if (bridge._commandReady) { try { await bridge._commandReady; } catch (_) { /* fall through */ } }
    if (typeof bridge.isAvailable === 'function' && !bridge.isAvailable()) {
      throw this._controlError('PRECONDITION_FAILED', `${toolName} is not available on this instance`, 409);
    }
    const cols = opts.cols || 100;
    const rows = opts.rows || 30;

    const extraEnv = {};
    // F6: non-interactive env hardening for CONTROL-spawned PTYs only (interactive
    // WebSocket terminals keep their pager UX). A headless fleet shell has no human
    // to press 'q', so a paging git command (log/diff/branch → less) would hang the
    // PTY until someone sends 'q'. Disable every common pager + interactive prompt:
    //   - GIT_PAGER / PAGER / GH_PAGER / DELTA_PAGER / MANPAGER / AWS_PAGER / SYSTEMD_PAGER
    //     route paged output straight to stdout (cat / empty = no pager).
    //   - LESS=FRX makes any residual `less` exit immediately on a short page.
    //   - GIT_TERMINAL_PROMPT=0 turns a credential prompt into an immediate git
    //     FAILURE (fail-fast) instead of a silent hang — intended; the driver sees a
    //     structural error rather than a stuck session.
    extraEnv.GIT_PAGER = 'cat';
    extraEnv.PAGER = 'cat';
    extraEnv.GH_PAGER = 'cat';
    extraEnv.DELTA_PAGER = 'cat';
    extraEnv.MANPAGER = 'cat';
    extraEnv.AWS_PAGER = '';
    extraEnv.SYSTEMD_PAGER = '';
    extraEnv.LESS = 'FRX';
    extraEnv.GIT_TERMINAL_PROMPT = '0';
    try {
      const sidecar = this._prepareClaudeBindSidecar(sessionId, session);
      if (sidecar) extraEnv.AIORDIE_CLAUDE_BIND = sidecar; // deterministic JSONL turn detection (ADR-0026)
    } catch (_) { /* sidecar best-effort */ }
    // So a github-router-claude spawned here can drive the artifact-review loop
    // (works standalone and under --disable-auth; see _artifactEnvForSession).
    Object.assign(extraEnv, this._artifactEnvForSession(sessionId));

    try { session._ctlTranscript = new TranscriptBuffer({ cols, rows }); } catch (_) { session._ctlTranscript = null; }
    session.active = true;
    session.agent = toolName;
    this.activityBroadcastTimestamps.set(sessionId, Date.now());
    try {
      await bridge.startSession(sessionId, {
        workingDir: session.workingDir,
        cols, rows,
        dangerouslySkipPermissions: !!opts.dangerouslySkipPermissions,
        // F10: claude permission mode + caller passthrough flags (claude only;
        // terminal/codex bridges ignore these in BaseBridge.buildArgs).
        permissionMode: opts.permissionMode,
        agentArgs: opts.agentArgs,
        onOutput: (data) => {
          const s = this.claudeSessions.get(sessionId);
          if (!s) return;
          s.outputBuffer.push(data);
          try { if (s._ctlTranscript) s._ctlTranscript.write(data); } catch (_) { /* isolate */ }
          // F12: record PTY-output recency + drive coarse busy/idle edges for
          // UNBOUND sessions (no-op for bound claude — the JSONL turn detector is
          // authoritative there).
          try { this._controlRecordPtyOutput(sessionId); } catch (_) { /* isolate */ }
          this.sessionStore.markDirty();
          try { if (this.stickyNoteSummarizer && this.stickyNoteSummarizer.isEnabled(sessionId)) this.stickyNoteSummarizer.feed(sessionId, data); } catch (_) { /* isolate */ }
        },
        onExit: (code, signal) => {
          const s = this.claudeSessions.get(sessionId);
          if (s) {
            if (typeof this._flushAndClearOutputTimer === 'function') this._flushAndClearOutputTimer(s, sessionId);
            s.active = false;
            s.agent = null;
            s._lastExit = { code, signal };
            this.sessionStore.markDirty();
            // Persist the last rendered screen before disposing so a refresh
            // repaints an idle/exited session instead of blank (always disposes).
            this._persistSnapshotAndDispose(s);
            // F12: stop the coarse idle-debounce timer for unbound sessions.
            try { if (s._ctlIdleTimer) { clearTimeout(s._ctlIdleTimer); s._ctlIdleTimer = null; } } catch (_) { /* isolate */ }
          }
          try { this.stickyNoteSummarizer && this.stickyNoteSummarizer.flushExit(sessionId); } catch (_) { /* isolate */ }
          if (this.controlEventBus) this.controlEventBus.append(sessionId, 'exited', { code, signal });
          this.broadcastToSession(sessionId, { type: 'exit', code, signal });
        },
        onError: (error) => {
          const s = this.claudeSessions.get(sessionId);
          if (s) { s.active = false; s.agent = null; this.sessionStore.markDirty(); }
          this.broadcastToSession(sessionId, { type: 'error', message: error.message });
        },
        extraEnv,
      });
      session.lastActivity = new Date();
      if (typeof this._pushEvictionEntry === 'function') this._pushEvictionEntry(sessionId);
      if (!session.sessionStartTime) session.sessionStartTime = new Date();
      this.sessionStore.markDirty();
      if (this.controlEventBus) this.controlEventBus.append(sessionId, 'became_busy');
      session.cols = cols; session.rows = rows;
      try { this._maybeStartStickyNotes(sessionId, toolName, cols, rows); } catch (_) { /* isolate */ }
      if (toolName === 'claude') this._controlReapTrustPrompt(sessionId);
    } catch (error) {
      session.active = false; session.agent = null;
      this.activityBroadcastTimestamps.delete(sessionId);
      throw this._controlError('UPSTREAM_ERROR', `Failed to start ${toolName}: ${error.message}`, 500);
    }
  }

  async _controlStopSession(id, mode, idempotencyKey) {
    return this._controlWithIdempotency(id, idempotencyKey, async () => {
      const session = this.claudeSessions.get(id);
      const bridge = session && this.getBridgeForAgent(session.agent);
      if (bridge && session.active) {
        await this.stopToolSession(id, mode);
        // Record a clean exit so session_status reports 'exited' immediately:
        // deriveStatus needs an exit marker, and the PTY's own onExit can lag the
        // synchronous stop (and stopToolSession may clear session.agent, which
        // would otherwise make a stopped session look like a never-started one).
        session._lastExit = session._lastExit || { code: 0, signal: null };
      }
      return { stopped: true, lifecycle: 'exited' };
    });
  }

  async _controlSendMessage(opts = {}) {
    const { sessionId, message, idempotencyKey, awaitMs } = opts;
    const session = this.claudeSessions.get(sessionId);
    if (!session) throw this._controlError('SESSION_NOT_FOUND', 'Unknown session', 404);

    return this._controlWithIdempotency(sessionId, idempotencyKey, async () => {
      const bridge = this._controlInputBridge(sessionId, session);
      const timeoutMs = this._controlClampInt(awaitMs, 120000, 0, 180000);
      const text = message == null ? '' : String(message);
      // F1/F18: classify the agent's turn capability up front.
      //   'terminal' — a shell / non-claude agent: NO turn model, so confirmation is
      //                N/A (return honest delivery, never a false negative).
      //   'unbound'  — claude expected but its JSONL turn-binding hasn't attached yet
      //                (cold-boot race): we cannot prove submission/turn, so we run the
      //                legacy dropped-Enter reaper but never claim a confirmed turn.
      //   'bound'    — claude with a live JSONL binding: confirm the SPECIFIC message
      //                submitted (a new matching user transcript entry) + its turn end.
      const turnClass = this._controlIsTurnAgent(sessionId, session);
      const binding = this._stickyJsonl && this._stickyJsonl.get(sessionId);
      // One shared deadline so submission + turn detection together honour awaitMs.
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(0, deadline - Date.now());

      // F16: DELIVERY + SUBMISSION run under the per-session steering mutex so two
      // concurrent DISTINCT steering ops on this session cannot interleave bytes
      // (text1, text2, \r, \r). preSize/preCursor are captured INSIDE the lock,
      // immediately before the bytes, so they bracket exactly THIS op's send. The
      // possibly-long turn-completion await runs AFTER the lock releases, so it
      // never blocks another command (e.g. a `respond`) on this session.
      const phase = await this._controlSteeringLock(sessionId, async () => {
        // Capture the transcript size BEFORE sending so F18 only matches a user
        // entry produced by THIS message, not a pre-existing one.
        let preSize = null;
        if (turnClass === 'bound' && binding && binding.file) {
          try { const stp = await this._statQuiet(binding.file); preSize = stp ? stp.size : null; } catch (_) { preSize = null; }
        }
        // F13: capture the event-bus cursor BEFORE sending so the unbound reaper
        // can distinguish a NEW activity edge (caused by THIS send) from a
        // lingering prior-turn busy.
        const preCursor = this.controlEventBus ? this.controlEventBus.headCursor() : null;

        if (text.includes('\n')) {
          await bridge.sendInput(sessionId, `\x1b[200~${text}\x1b[201~`);
        } else {
          await bridge.sendInput(sessionId, text);
        }
        await bridge.sendInput(sessionId, '\r');

        if (turnClass === 'terminal') return { terminal: true };

        let submission = 'unconfirmed';
        if (turnClass === 'bound' && timeoutMs > 0) {
          // F18: prove THIS message reached the composer by matching a new user
          // entry in the transcript. Supersedes the busy-edge guesswork.
          let submitted = await this._controlAwaitSubmission(binding, preSize, text, Math.min(remaining(), 4000));
          if (!submitted && remaining() > 0) {
            // Cold-boot Ink composer can drop the submit Enter; re-send ONCE (a stray
            // Enter on an already-submitted composer is a no-op in claude), then re-check.
            try { await bridge.sendInput(sessionId, '\r'); } catch (_) { /* pty may have exited */ }
            submitted = await this._controlAwaitSubmission(binding, preSize, text, Math.min(remaining(), 4000));
          }
          submission = submitted ? 'submitted' : 'unconfirmed';
        } else if (timeoutMs > 0) {
          // Unbound cold-boot reaper (F13). No transcript to match against, so gate
          // the dropped-Enter re-send on a NEW activity edge AFTER the pre-send
          // cursor (became_busy / waiting_input — F12 emits became_busy from PTY
          // recency even for unbound sessions), not on a lingering prior busy. The
          // writeQueue + _controlWithIdempotency keep the retry duplicate-safe.
          const started = await this._controlAwaitActivityEdge(sessionId, preCursor, Math.min(remaining(), 2400));
          if (!started) { try { await bridge.sendInput(sessionId, '\r'); } catch (_) { /* pty may have exited */ } }
          submission = 'no_turn_binding';
        }
        return { terminal: false, submission, preSize };
      });

      // ---- terminal / non-turn agent: honest delivery, no turn semantics (F1) ----
      if (phase.terminal) {
        const status = await this._controlDerivedStatus(sessionId);
        return {
          messageId: uuidv4(),
          delivered: true,
          confirmed: true,            // delivery-confirmed; a shell has no turn to await
          confirmation: 'delivered',
          delivery: { status: 'delivered' },
          submission: { status: 'not_applicable' },
          turn: { status: 'not_applicable' },
          confidence: 'low',
          interactionState: status ? status.interactionState : 'unknown',
          sessionStateSeq: this._controlSessionSeqFor(sessionId),
          duplicated: false,
        };
      }

      const submission = phase.submission;
      const preSize = phase.preSize;

      // Turn completion (bound only) — CONTENT-BASED and tied to THIS message, run
      // OUTSIDE the steering lock so a long turn doesn't block other commands. Watch
      // the transcript from preSize for an assistant reply that settles AFTER our
      // user entry (endsOnAssistant). Race-free vs a pre-send event cursor, which
      // could miscount a lingering PRIOR turn's turn_ended (a prior turn's
      // settle). A pending tool/permission prompt yields a tool-only assistant
      // block (no settled text) → turnCompleted stays false → reported as
      // submitted-but-awaiting, not a false confirmation.
      let turnCompleted = false;
      if (turnClass === 'bound' && submission === 'submitted' && timeoutMs > 0) {
        turnCompleted = await this._controlAwaitTurnComplete(binding, preSize, remaining());
      }

      const status = await this._controlDerivedStatus(sessionId);
      const awaiting = (!turnCompleted && status && status.awaiting) ? status.awaiting : null;
      const confirmed = turnClass === 'bound' && submission === 'submitted' && turnCompleted;
      const confirmationTimedOut = turnClass === 'bound' && submission === 'submitted' && !turnCompleted && timeoutMs > 0;
      // The github-router fleet MCP tool maps confirmed=false to an MCP isError today;
      // F9 will switch it to delivery-only. ai-or-die returns honest, structured
      // delivery/submission/turn statuses + idempotency so retries never re-type.
      return {
        messageId: uuidv4(),
        delivered: true,
        confirmed,
        confirmation: confirmed ? 'turn_completed' : (submission === 'submitted' ? 'submitted' : (turnClass === 'bound' ? 'unconfirmed' : 'no_turn_binding')),
        confirmationTimedOut,
        delivery: { status: 'delivered' },
        submission: { status: submission },
        turn: { status: turnCompleted ? 'completed' : (submission === 'submitted' ? 'pending' : 'not_applicable'), ...(awaiting ? { awaiting } : {}) },
        confidence: turnClass === 'bound' ? 'high' : 'medium',
        interactionState: status ? status.interactionState : 'unknown',
        sessionStateSeq: this._controlSessionSeqFor(sessionId),
        duplicated: false,
      };
    });
  }

  /**
   * Classify a session's turn-detection capability (F1/F18):
   *   'terminal' — non-claude agent (a shell has no turn model).
   *   'unbound'  — claude whose JSONL turn-binding hasn't attached yet (cold-boot).
   *   'bound'    — claude with a live JSONL binding (deterministic turn detection).
   */
  _controlIsTurnAgent(sessionId, session) {
    if (!session || session.agent !== 'claude') return 'terminal';
    return (this._stickyJsonl && this._stickyJsonl.has(sessionId)) ? 'bound' : 'unbound';
  }

  /** Normalise text for tolerant message↔transcript matching (F18). */
  _controlNormalizeForMatch(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 64);
  }

  /**
   * Whether a transcript user-entry text corresponds to the sent message (F18).
   * The transcript text may be clipped/prose-cleaned, so match by prefix
   * containment in either direction rather than strict equality.
   */
  _controlUserEntryMatches(wantNorm, userText) {
    const got = this._controlNormalizeForMatch(userText);
    if (!got || !wantNorm) return false;
    return got.startsWith(wantNorm) || wantNorm.startsWith(got) || got.includes(wantNorm);
  }

  /**
   * Poll the transcript for a NEW user entry (after preSize) matching the sent
   * message — positive proof that the message reached claude's composer (F18).
   * Returns true on match, false on timeout. An empty message is treated as
   * submitted (nothing to match).
   */
  async _controlAwaitSubmission(binding, preSize, sentText, timeoutMs) {
    if (!binding || !binding.file || typeof preSize !== 'number') return false;
    const want = this._controlNormalizeForMatch(sentText);
    if (!want) return true;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      try {
        const { turns } = await StickyNoteJsonl.readNewTurns(binding.file, preSize);
        for (const t of turns) {
          if (t && t.role === 'user' && this._controlUserEntryMatches(want, t.text)) return true;
        }
      } catch (_) { /* transient read error — retry */ }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * Poll the transcript (from preSize) for the assistant reply that settles AFTER
   * the message's user entry — content-based turn completion tied to THIS message
   * (F18). Race-free vs an event cursor: a lingering prior turn cannot satisfy it
   * because endsOnAssistant() only returns true once an assistant turn follows the
   * last user turn (our message). A tool-only assistant block (pending permission)
   * has no settled text, so it does NOT count as completed. Returns false on timeout.
   */
  async _controlAwaitTurnComplete(binding, preSize, timeoutMs) {
    if (!binding || !binding.file || typeof preSize !== 'number') return false;
    const endsOnAssistant = require('./sticky-note-jsonl').endsOnAssistant;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      try {
        const { turns } = await StickyNoteJsonl.readNewTurns(binding.file, preSize);
        if (endsOnAssistant(turns)) return true;
      } catch (_) { /* transient read error — retry */ }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * F17: compute a control session's readiness for driving. Returns
   * { ready, bound, blocker? }. `bound` means a claude JSONL turn-binding is live
   * (deterministic turn detection available). `blocker` names a concrete reason a
   * session isn't ready yet (a startup modal, a pending binding, still starting).
   */
  async _controlReadinessState(sessionId) {
    const session = this.claudeSessions.get(sessionId);
    if (!session) return { ready: false, bound: false, blocker: { kind: 'gone', message: 'session not found' } };
    if (!session.active) return { ready: false, bound: false, blocker: { kind: 'inactive', message: 'session is not active' } };
    const isClaude = session.agent === 'claude';
    const bound = isClaude && !!(this._stickyJsonl && this._stickyJsonl.has(sessionId));
    // A folder-trust / onboarding modal on the rendered screen is a hard blocker —
    // the agent is not driveable until it clears.
    let blocker = null;
    if (session._ctlTranscript) {
      let screen = '';
      try { screen = await session._ctlTranscript.snapshot(40); } catch (_) { screen = ''; }
      if (TRUST_PROMPT_REGEX.test(screen)) {
        blocker = { kind: 'trust', message: 'folder-trust prompt is awaiting acceptance' };
      }
    }
    const hadOutput = !!(session.outputBuffer && session.outputBuffer.size && session.outputBuffer.size > 0);
    if (isClaude) {
      if (blocker) return { ready: false, bound, blocker };
      if (!bound) return { ready: false, bound: false, blocker: { kind: 'binding_pending', message: 'claude turn-binding not attached yet' } };
      if (!hadOutput) return { ready: false, bound: true, blocker: { kind: 'starting', message: 'no output yet' } };
      return { ready: true, bound: true };
    }
    // Non-turn agent (terminal / other): ready once active with output; no binding.
    if (blocker) return { ready: false, bound: false, blocker };
    if (!hadOutput) return { ready: false, bound: false, blocker: { kind: 'starting', message: 'no output yet' } };
    return { ready: true, bound: false };
  }

  /**
   * F17: bounded wait until a freshly-started control session is ready (or a hard
   * blocker like a trust modal appears, or the deadline passes). Lets the one-shot
   * create_session(start:true) return a truthful ready/bound/blocker instead of
   * succeeding the moment the PTY spawns.
   */
  async _controlAwaitReady(sessionId, timeoutMs) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let state = await this._controlReadinessState(sessionId);
    while (!state.ready && Date.now() < deadline) {
      // A trust/onboarding modal is terminal for this wait — surface it immediately
      // so the driver can respond() rather than block the whole readiness window.
      if (state.blocker && (state.blocker.kind === 'trust' || state.blocker.kind === 'inactive' || state.blocker.kind === 'gone')) break;
      await new Promise((r) => setTimeout(r, 250));
      state = await this._controlReadinessState(sessionId);
    }
    return state;
  }

  async _controlSendKeys(opts = {}) {
    const { sessionId, keys, idempotencyKey, raw } = opts;
    const session = this.claudeSessions.get(sessionId);
    if (!session) throw this._controlError('SESSION_NOT_FOUND', 'Unknown session', 404);

    return this._controlWithIdempotency(sessionId, idempotencyKey, async () => {
      return this._controlSteeringLock(sessionId, async () => {
        const bridge = this._controlInputBridge(sessionId, session);
        const data = this._controlKeyBytes(keys, raw === true);
        await bridge.sendInput(sessionId, data);
        return { keysId: uuidv4(), delivered: true, duplicated: false };
      });
    });
  }

  async _controlRespond(opts = {}) {
    const { sessionId, choice, optionValue, keys, idempotencyKey } = opts;
    const session = this.claudeSessions.get(sessionId);
    if (!session) throw this._controlError('SESSION_NOT_FOUND', 'Unknown session', 404);

    return this._controlWithIdempotency(sessionId, idempotencyKey, async () => {
      return this._controlSteeringLock(sessionId, async () => {
        const binding = this._stickyJsonl && this._stickyJsonl.get(sessionId);
        const awaiting = binding && binding.file ? await detectAwaiting(binding.file) : null;
        let awaitingKind = awaiting ? awaitingKindForPendingTool(awaiting.pendingUserFacingTool) : null;
        // Fallback: when the JSONL binding isn't available (e.g. a raw claude.exe
        // whose Windows project-slug doesn't resolve), derive the pending
        // interaction from the live rendered screen — the same signal status uses.
        if (!awaitingKind && session._ctlTranscript) {
          try {
            const screenAwait = awaitingFromScreen(await session._ctlTranscript.snapshot(20));
            if (screenAwait) awaitingKind = screenAwait.kind;
          } catch (_) { /* transcript unavailable */ }
        }
        let mappedKeys;

        if (keys !== undefined && keys !== null) {
          mappedKeys = String(keys);
        } else {
          if (!awaitingKind) {
            return { error: { code: 'PRECONDITION_FAILED', message: 'no pending interaction' } };
          }
          mappedKeys = this._controlMapResponseKeys(awaitingKind, {
            awaiting,
            choice,
            optionValue,
            agent: session.agent,
          });
          if (!mappedKeys) {
            return { error: { code: 'INVALID_ARGUMENT', message: 'could not map response to keystrokes' } };
          }
        }

        const bridge = this._controlInputBridge(sessionId, session);
        await bridge.sendInput(sessionId, mappedKeys);
        return {
          delivered: true,
          awaitingKind: awaitingKind || null,
          mappedKeys,
          duplicated: false,
        };
      });
    });
  }

  async _controlWithIdempotency(sessionId, idempotencyKey, fn) {
    if (!idempotencyKey) return fn();
    if (!this._controlIdempotency) this._controlIdempotency = new Map();
    const key = `${sessionId}:${idempotencyKey}`;
    if (this._controlIdempotency.has(key)) {
      const cached = this._controlIdempotency.get(key);
      const out = typeof cached.then === 'function' ? await cached : cached;
      return { ...out, duplicated: true };
    }

    const pending = Promise.resolve()
      .then(fn)
      .then((out) => {
        if (out && out.error) {
          this._controlIdempotency.delete(key);
          return out;
        }
        const cached = { ...out, duplicated: false };
        this._controlIdempotency.set(key, cached);
        this._controlTrimIdempotency();
        return cached;
      })
      .catch((err) => {
        this._controlIdempotency.delete(key);
        throw err;
      });
    this._controlIdempotency.set(key, pending);
    return pending;
  }

  _controlTrimIdempotency() {
    if (!this._controlIdempotency) return;
    while (this._controlIdempotency.size > 500) {
      this._controlIdempotency.delete(this._controlIdempotency.keys().next().value);
    }
  }

  _controlInputBridge(sessionId, session) {
    const bridge = session && this.getBridgeForAgent(session.agent);
    if (!session || !session.active || !bridge || typeof bridge.sendInput !== 'function') {
      throw this._controlError('PRECONDITION_FAILED', 'session is not accepting PTY input', 409);
    }
    return bridge;
  }

  _controlKeyBytes(keys, raw) {
    if (Array.isArray(keys)) return keys.map((k) => this._controlKeyBytes(k, raw)).join('');
    const value = keys == null ? '' : String(keys);
    if (raw) return value;
    const named = {
      enter: '\r',
      escape: '\x1b',
      esc: '\x1b',
      tab: '\t',
      'c-c': '\x03',
      'ctrl-c': '\x03',
      'c-d': '\x04',
      'ctrl-d': '\x04',
      up: '\x1b[A',
      down: '\x1b[B',
      right: '\x1b[C',
      left: '\x1b[D',
      space: ' ',
      backspace: '\x7f',
      // Shift+Tab (CSI Z, back-tab) — claude's permission-mode cycle. A driver
      // reads the current mode from claude's status-line and cycles to plan mode.
      'shift-tab': '\x1b[Z',
      's-tab': '\x1b[Z',
      backtab: '\x1b[Z',
      home: '\x1b[H',
      end: '\x1b[F',
      pageup: '\x1b[5~',
      pagedown: '\x1b[6~',
      delete: '\x1b[3~',
    };
    const key = value.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : value;
  }

  _controlMapResponseKeys(awaitingKind, opts = {}) {
    const choice = this._controlNormalizeChoice(opts.choice);
    const optionValue = opts.optionValue == null ? null : String(opts.optionValue);

    // BEST-EFFORT mapping for claude's NUMBERED approval modals (plan + tool/
    // permission), which select with the highlighted default + Enter and cancel
    // with Esc — a literal y/n is typed into the modal, not interpreted as a
    // choice. accept→Enter is proven live (plan_approval ExitPlanMode); reject→Esc
    // is claude's documented cancel. Callers can always pass exact `keys` bytes.
    if (awaitingKind === 'plan_approval') {
      if (choice === 'accept' || choice === 'yes' || choice === 'allow') return '\r';
      if (choice === 'reject' || choice === 'no' || choice === 'deny') return '\x1b';
      return null;
    }

    if (awaitingKind === 'tool_approval') {
      if (choice === 'yes' || choice === 'allow' || choice === 'accept') return '\r';
      if (choice === 'no' || choice === 'deny' || choice === 'reject') return '\x1b';
      return null;
    }

    // Folder-trust modal (F7): a numbered "1. Yes, proceed / 2. No, exit" list. Send
    // the EXPLICIT numbered choice, never a bare Enter — Enter can no-op mid-render or
    // land on a non-default option, whereas "1"/"2" deterministically pick yes/no.
    if (awaitingKind === 'trust_prompt') {
      if (choice === 'accept' || choice === 'yes' || choice === 'trust' || choice === 'allow') return '1\r';
      if (choice === 'reject' || choice === 'no' || choice === 'deny') return '2\r';
      return null;
    }

    if (awaitingKind === 'choice_question') {
      if (optionValue !== null) return `${optionValue}\r`;
      const options = (opts.awaiting && opts.awaiting.awaitingOptions) || [];
      const originalChoice = opts.choice == null ? '' : String(opts.choice);
      if (originalChoice) {
        const match = options.findIndex((o) => {
          if (!o) return false;
          return String(o.value) === originalChoice || String(o.label) === originalChoice;
        });
        if (match >= 0) return `${match + 1}\r`;
        return `${originalChoice}\r`;
      }
      return null;
    }

    return null;
  }

  _controlNormalizeChoice(choice) {
    return choice == null ? '' : String(choice).trim().toLowerCase();
  }

  _controlClampInt(v, def, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  }

  _controlError(code, message, statusCode) {
    const err = new Error(message);
    err.code = code;
    err.statusCode = statusCode;
    return err;
  }

  /**
   * Synchronously reap every PTY subtree across all bridges. For the crash / supervisor-
   * death paths where we are exiting and cannot await async teardown. Windows closes each
   * per-PTY kill-on-close job (terminates the shell + node/bun grandchildren); POSIX
   * process-group kills. Best-effort; never throws.
   */
  _reapAllPtySubtreesSync() {
    const bridges = [
      this.claudeBridge, this.codexBridge, this.copilotBridge,
      this.geminiBridge, this.terminalBridge,
    ];
    for (const b of bridges) {
      if (b && typeof b.killAllSubtreesSync === 'function') {
        try { b.killAllSubtreesSync(); } catch (_) { /* ignore */ }
      }
    }
  }

  async startToolSession(wsId, toolName, bridge, options, cols, rows) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) {
      console.warn(`startToolSession(${toolName}): wsInfo not found for wsId=${wsId}`);
      return;
    }

    console.log(`startToolSession(${toolName}): wsId=${wsId}, claudeSessionId=${wsInfo.claudeSessionId}`);

    if (!wsInfo.claudeSessionId) {
      console.warn(`startToolSession(${toolName}): no claudeSessionId on wsInfo`);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'No session joined. Please create or join a session first.'
      });
      return;
    }

    const session = this.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session) {
      console.error(`startToolSession(${toolName}): session ${wsInfo.claudeSessionId} not found (map size: ${this.claudeSessions.size})`);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Session not found. It may have been deleted. Please create a new session.'
      });
      return;
    }

    const sessionId = wsInfo.claudeSessionId;

    if (session.active) {
      if (session.agent === toolName) {
        // Idempotent: same tool already running — send success to requester.
        // Handles the race where both client auto-start and test helper
        // call startToolSession('terminal') near-simultaneously.
        console.log(`startToolSession(${toolName}): already running in session ${sessionId}, sending success`);
        this.sendToWebSocket(wsInfo.ws, {
          type: `${toolName}_started`,
          sessionId: sessionId,
          // Mirror the broadcast shape so the client always gets workingDir
          // from a started frame, even on the idempotent already-running
          // re-entry path. (Otherwise a client that joined post-start would
          // miss the resolver-chain prime.)
          workingDir: session.workingDir,
        });
        return;
      }
      console.warn(`startToolSession(${toolName}): session ${sessionId} already has agent '${session.agent}' running`);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `Cannot start ${toolName}: '${session.agent}' is already running`
      });
      return;
    }

    // Ensure async command discovery has finished before checking availability
    await bridge._commandReady;
    if (!bridge.isAvailable()) {
      console.warn(`startToolSession(${toolName}): bridge reports tool not available`);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `${toolName} is not available. Please ensure the ${toolName} CLI is installed and accessible on your PATH.`
      });
      return;
    }

    // Mark active BEFORE the async spawn to prevent TOCTOU races —
    // two concurrent start_terminal messages could both pass the
    // session.active check above and spawn duplicate PTY processes.
    session.active = true;
    session.agent = toolName;
    this.activityBroadcastTimestamps.set(sessionId, Date.now());

    try {
      console.log(`startToolSession(${toolName}): spawning in session ${sessionId}, workingDir=${session.workingDir}`);

      // Per ADR-0019: only the Terminal bridge parses OSC 7 → live CWD.
      // Claude/Codex/Copilot/Gemini bridges don't `chdir` their host
      // process; their session.liveCwd stays null. We pass the OSC 7
      // hooks only when starting a Terminal session so the other bridges
      // remain a true no-op.
      const terminalExtraEnv = {};
      if (toolName === 'terminal') {
        const sidecarPath = this._prepareClaudeBindSidecar(sessionId, session);
        if (sidecarPath) terminalExtraEnv.AIORDIE_CLAUDE_BIND = sidecarPath;
      }

      // Artifact-review parity for the manual (non-fleet) claude tab AND a
      // terminal tab where the user runs `github-router claude` themselves: both
      // get the env trio _controlStartAgent injects, so the in-tab agent's
      // artifact_* tools activate standalone — no control plane required. For a
      // terminal tab the trio rides the shell env and the github-router PROXY
      // (which serves the artifact_* MCP tools) inherits it; the proxy strips
      // AIORDIE_TOKEN only from the claude CHILD it spawns, so a nested re-invoke
      // still can't hijack. Per-tab sessionId keeps multiple terminal claudes
      // isolated. Injected when auth is set OR --disable-auth (routes are public
      // then), so the viewer works standalone.
      const claudeArtifactEnv = (toolName === 'claude' || toolName === 'terminal')
        ? this._artifactEnvForSession(sessionId) : {};

      // Rendered-screen buffer so a refresh/reconnect can repaint the last
      // screen even when the session is idle and the raw outputBuffer is empty
      // (manual-tab parity with the control path; mirrors 4523).
      try { session._ctlTranscript = new TranscriptBuffer({ cols: cols || 80, rows: rows || 24 }); } catch (_) { session._ctlTranscript = null; }

      const osc7Hooks = (toolName === 'terminal') ? {
        validatePath: (p) => this.validatePath(p),
        onCwdChange: (cwd, prev) => {
          // Mirror onto the session record so the find/repo-root endpoints
          // (which take session id → workingDir) can reach for liveCwd
          // without going through the bridge map.
          const s = this.claudeSessions.get(sessionId);
          if (s) {
            s.liveCwd = cwd;
            this.sessionStore.markDirty();
          }
          this.broadcastToSession(sessionId, {
            type: 'cwd_changed',
            sessionId,
            cwd,
            prev,
            source: 'osc7',
          });
        },
      } : {};

      await bridge.startSession(sessionId, {
        workingDir: session.workingDir,
        cols: cols || 80,
        rows: rows || 24,
        ...osc7Hooks,
        onOutput: (data) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (!currentSession) return;
          currentSession.outputBuffer.push(data);
          try { if (currentSession._ctlTranscript) currentSession._ctlTranscript.write(data); } catch (_) { /* isolate */ }
          this.sessionStore.markDirty();
          this._throttledOutputBroadcast(sessionId, data);
          // Tap for the local-LLM summariser (off the hot path: this only
          // buffers into a headless terminal + arms timers, never inference).
          // Isolated so a summariser/parser fault can never break the terminal
          // output pipeline.
          if (this.stickyNoteSummarizer.isEnabled(sessionId)) {
            try {
              this.stickyNoteSummarizer.feed(sessionId, data);
            } catch (e) {
              if (this.dev) console.error('[sticky-notes] feed error:', e && e.message);
            }
          }
          // Notify non-joined connections about activity (throttled to 1/sec)
          const now = Date.now();
          const lastBroadcast = this.activityBroadcastTimestamps.get(sessionId) || 0;
          if (now - lastBroadcast > 1000) {
            this.activityBroadcastTimestamps.set(sessionId, now);
            this.broadcastSessionActivity(sessionId, 'session_activity');
          }
        },
        onExit: (code, signal) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (currentSession) {
            this._flushAndClearOutputTimer(currentSession, sessionId);
            currentSession.active = false;
            currentSession.agent = null;
            currentSession._lastExit = { code, signal };
            this.sessionStore.markDirty();
            // Persist the last rendered screen before disposing so a later
            // refresh/join repaints an idle session instead of going blank.
            this._persistSnapshotAndDispose(currentSession);
          }
          // Final sticky-note flush to capture the "done" state, then stop.
          this.stickyNoteSummarizer.flushExit(sessionId);
          this.controlEventBus.append(sessionId, 'exited', { code, signal });
          this.broadcastToSession(sessionId, { type: 'exit', code, signal });
          this.activityBroadcastTimestamps.delete(sessionId);
          this.broadcastSessionActivity(sessionId, 'session_exit', { code, signal });
        },
        onError: (error) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (currentSession) {
            currentSession.active = false;
            currentSession.agent = null;
            this.sessionStore.markDirty();
          }
          this.activityBroadcastTimestamps.delete(sessionId);
          this.broadcastToSession(sessionId, { type: 'error', message: error.message });
          this.broadcastSessionActivity(sessionId, 'session_error');
        },
        ...options,
        extraEnv: {
          ...((options.extraEnv && typeof options.extraEnv === 'object') ? options.extraEnv : {}),
          ...terminalExtraEnv,
          ...claudeArtifactEnv,
        }
      });

      session.lastActivity = new Date();
      this._pushEvictionEntry(sessionId); // PROC-04
      if (!session.sessionStartTime) {
        session.sessionStartTime = new Date();
      }
      this.sessionStore.markDirty();

      this.broadcastToSession(sessionId, {
        type: `${toolName}_started`,
        sessionId: sessionId,
        // Carry workingDir on the started frame so the client's
        // resolver-chain `getWorkingDir()` callback has a deterministic
        // per-session signal without racing /api/sessions/list refresh.
        // Matches the shape of `session_created` and `session_joined`,
        // which already include this field. Architect-approved fix for
        // click-to-open failures where the cached claudeSessions array
        // lagged the user's first click after session start.
        // (Per ADR-0019, we do NOT also emit a synthesized cwd_changed
        // here — `liveCwd` must stay null for non-Terminal bridges.)
        workingDir: session.workingDir,
      });
      this.broadcastSessionActivity(sessionId, 'session_started', { agent: toolName });

      // Spin up the per-tab summariser for AI-agent AND terminal sessions
      // (no-op when the tab is opted out, or when node-llama-cpp is unavailable).
      session.cols = cols;
      session.rows = rows;
      this._maybeStartStickyNotes(sessionId, toolName, cols, rows);

    } catch (error) {
      // Roll back the early active flag set before spawn
      session.active = false;
      session.agent = null;
      this.activityBroadcastTimestamps.delete(sessionId);
      if (this.dev) {
        console.error(`Error starting ${toolName} in session ${wsInfo.claudeSessionId}:`, error);
      }
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `Failed to start ${toolName}: ${error.message}`
      });
    }
  }

  async stopToolSession(sessionId) {
    const session = this.claudeSessions.get(sessionId);
    if (!session || !session.active) return;

    // Capture agent type before stopSession — the onExit callback
    // may set session.agent to null during the await.
    const agentType = session.agent;
    const bridge = this.getBridgeForAgent(agentType);
    if (bridge) {
      await bridge.stopSession(sessionId);
    }

    this._flushAndClearOutputTimer(session, sessionId);
    session.active = false;
    session.agent = null;
    session.lastActivity = new Date();
    this._pushEvictionEntry(sessionId); // PROC-04
    this.sessionStore.markDirty();
    this.broadcastToSession(sessionId, { type: `${agentType}_stopped` });
    this.activityBroadcastTimestamps.delete(sessionId);
    this.broadcastSessionActivity(sessionId, 'session_stopped', { agent: agentType });
  }

  sendToWebSocket(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  _isLocalhostConnection(ws) {
    try {
      const addr = ws._socket && ws._socket.remoteAddress;
      if (!addr) return false;
      return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    } catch (_) {
      return false;
    }
  }

  broadcastToSession(claudeSessionId, data) {
    const session = this.claudeSessions.get(claudeSessionId);
    if (!session) return;

    session.connections.forEach(wsId => {
      const wsInfo = this.webSocketConnections.get(wsId);
      // Double-check that this WebSocket is actually part of this session
      if (wsInfo &&
          wsInfo.claudeSessionId === claudeSessionId &&
          wsInfo.ws.readyState === WebSocket.OPEN) {
        this.sendToWebSocket(wsInfo.ws, data);
      }
    });
  }

  broadcastToAll(data) {
    for (const [, wsInfo] of this.webSocketConnections) {
      if (wsInfo.ws.readyState === WebSocket.OPEN) {
        this.sendToWebSocket(wsInfo.ws, data);
      }
    }
  }

  // --- sticky-note (local-LLM session summary) wiring ----------------------

  _isAiAgent(toolName) {
    return toolName === 'claude' || toolName === 'codex' || toolName === 'copilot' || toolName === 'gemini';
  }

  // Which session kinds get a sticky note. AI-agent tabs AND plain terminals —
  // users frequently launch an AI CLI (claude/codex/…) inside a terminal tab, so
  // the summary is useful there too. Idle terminals never trigger inference (no
  // output → no flush), and a noisy terminal can be turned off per-tab.
  _isStickyEligible(toolName) {
    return this._isAiAgent(toolName) || toolName === 'terminal';
  }

  // Lazily download the model + spawn the worker on first need (deduped).
  _ensureStickyNoteEngine() {
    if (!this.stickyNoteEngine._enabled || this._stickyInitStarted) return;
    this._stickyInitStarted = true;
    this.stickyNoteEngine
      .initialize((progress) => {
        this.broadcastToAll({
          type: 'sticky_notes_model_progress',
          file: progress.file,
          downloaded: progress.downloaded,
          total: progress.total,
          percent: progress.percent,
        });
      })
      .then(() => {
        // One-time visibility into the inference backend. On CPU (no GPU — common
        // on Windows when the Vulkan/CUDA prebuilt is incompatible) summaries are
        // materially slower; the worker compensates with more threads + a generous
        // watchdog timeout, but a note can still take a couple of minutes.
        const rt = this.stickyNoteEngine.getRuntimeInfo && this.stickyNoteEngine.getRuntimeInfo();
        if (this.dev && rt) {
          if (rt.gpu) {
            console.log(`[sticky-notes] engine ready (GPU backend, ${rt.threads} threads)`);
          } else {
            console.log(
              `[sticky-notes] engine ready (CPU backend, ${rt.threads} threads) — ` +
                'summaries run on CPU and may take a couple of minutes; a Vulkan/CUDA driver would accelerate them'
            );
          }
        }
        this._broadcastStickyStatus();
      })
      .catch((err) => {
        // Allow a later AI-session start to retry after a transient failure
        // (download blip). A permanent failure (no binding) just fails fast.
        this._stickyInitStarted = false;
        if (this.dev) console.error('[sticky-notes] init failed:', err.message);
        this._broadcastStickyStatus();
      });
  }

  _broadcastStickyStatus() {
    this.broadcastToAll({
      type: 'sticky_notes_status',
      status: this.stickyNoteEngine.getStatus(),
      progress: this.stickyNoteEngine.getDownloadProgress(),
    });
  }

  // Begin summarising a session if the feature is enabled for it (AI-agent tabs
  // and plain terminals — see _isStickyEligible).
  _maybeStartStickyNotes(sessionId, toolName, cols, rows) {
    const session = this.claudeSessions.get(sessionId);
    if (!session) return;
    if (!this._isStickyEligible(toolName)) return;
    // A control/fleet claude session with a bind sidecar ALWAYS needs the model-free
    // JSONL turn-binding pump (fleet await_turn / readiness depend on it) — even if
    // this tab opted out of sticky-note summarisation or the engine is unavailable.
    const bindingNeeded = toolName === 'claude' && !!session.claudeBindSidecar;
    if (session.stickyNotesEnabled === false && !bindingNeeded) return;
    // The model-free binding/turn pump is a CONTROL-PLANE invariant and runs
    // independently of the OPTIONAL summariser. Enable the LLM summariser only when
    // it is wanted (not opted out) AND its engine is available; always start the poll.
    if (session.stickyNotesEnabled !== false && this.stickyNoteEngine._enabled) {
      // Start buffering output now — cheap (a pure-JS headless terminal), never
      // inference. The summariser buffers and produces its first note once ready.
      this.stickyNoteSummarizer.enable(sessionId, {
        cols: cols || 80,
        rows: rows || 24,
        note: session.stickyNote || null,
        rev: (session.stickyNote && session.stickyNote.rev) || 0,
      });
      this._ensureStickyNoteEngine();
    }
    this._startStickyJsonlPoll();
  }

  // Poll each summarising tab for a claude JSONL transcript at its cwd; when found,
  // tail it and feed clean conversation turns to the summariser (JSONL mode). Tabs
  // without a JSONL (plain shells) keep using the rendered-output scrape fallback.
  _startStickyJsonlPoll() {
    if (this._stickyJsonlPoll) return;
    this._stickyJsonlPoll = setInterval(() => {
      this._pollStickyJsonl().catch((e) => {
        if (this.dev) console.error('[sticky-notes] jsonl poll error:', e && e.message);
      });
    }, 2000);
    if (this._stickyJsonlPoll.unref) this._stickyJsonlPoll.unref();
  }

  async _pollStickyJsonl() {
    // NOT gated on the sticky-note engine: the model-free binding + turn detection
    // below must run for control/fleet claude sessions even when the summariser is
    // disabled (--no-sticky-notes) or its model is unavailable. The LLM note
    // inference inside _pumpStickyJsonl stays independently gated.
    // Lock so a slow sweep (many old session files) can't overlap the next tick
    // and double-feed the same turns into pendingText.
    if (this._pollingStickyJsonl) return;
    this._pollingStickyJsonl = true;
    try {
      for (const [sessionId, session] of this.claudeSessions) {
        if (!session.active) continue;
        if (!this._isStickyEligible(session.agent)) continue;
        // Pump when summarising (UI note cards) OR when this is a claude session
        // with a bind sidecar (control/fleet turn-binding) — the latter needs
        // binding + turn events regardless of the summariser, and a per-tab
        // summarisation opt-out must NOT defeat control-plane turn-binding.
        const bindingNeeded = session.agent === 'claude' && !!session.claudeBindSidecar;
        if (session.stickyNotesEnabled === false && !bindingNeeded) continue;
        const summarising = this.stickyNoteSummarizer.isEnabled(sessionId);
        if (!summarising && !bindingNeeded) continue;
        const cwd = session.liveCwd || session.workingDir;
        if (!cwd) continue;
        try {
          await this._pumpStickyJsonl(sessionId, cwd);
        } catch (e) {
          if (this.dev) console.error('[sticky-notes] jsonl pump error:', e && e.message);
        }
      }
    } finally {
      this._pollingStickyJsonl = false;
    }
  }

  async _pumpStickyJsonl(sessionId, cwd) {
    let binding = this._stickyJsonl.get(sessionId);
    binding && (binding._ticks = (binding._ticks || 0) + 1);
    const session = this.claudeSessions.get(sessionId);
    const emitTransition = async () => {
      if (typeof this._controlEmitInteractionTransition === 'function') {
        await this._controlEmitInteractionTransition(sessionId);
      }
    };

    // DETERMINISTIC SIDECAR BINDING (terminal tabs launched via github-router).
    // ai-or-die set AIORDIE_CLAUDE_BIND=<sidecar> on the shell; github-router's
    // SessionStart/SessionEnd hook writes the ACTIVE claude session id +
    // transcript path there on every startup / resume / clear / compact. When a
    // sidecar exists it is AUTHORITATIVE: bind directly to that transcript by
    // exact path and skip the cwd+mtime inference entirely. Survives in-session
    // /resume, /clear and exit→relaunch, and works even when liveCwd is null
    // (cmd.exe / no OSC 7) — the case the inference path gets wrong.
    const sidecar = session ? await this._readClaudeBindSidecar(session) : null;
    if (sidecar) {
      session._sidecarSeen = true;
      // A SessionEnd record is intentionally NOT acted on: an in-session /resume
      // or /clear writes end-then-start, and the following start drives the
      // rebind; a terminal end (logout / prompt_input_exit) means claude exited,
      // and the PTY onExit flips session.active=false so _pollStickyJsonl stops
      // pumping this tab. So we keep the current binding (note frozen at its last
      // state) and only (re)bind on a start with a NEW claude session id.
      if (
        sidecar.event !== 'end' &&
        sidecar.claudeSessionId &&
        sidecar.transcriptPath &&
        (!binding ||
          binding.claudeSessionId !== sidecar.claudeSessionId ||
          // While still pending, follow a transcriptPath that drifts under the same
          // session id (e.g. a corrected path) so a wrong initial path can't strand
          // the binding forever. A promoted binding's path is stable, so this never
          // churns it.
          (binding.transcriptPending && binding.pendingTranscriptPath !== sidecar.transcriptPath))
      ) {
        const stp = await this._statQuiet(sidecar.transcriptPath);
        // Bind on the sidecar's IDENTITY immediately — even before the transcript
        // file exists. Claude Code does not create the .jsonl until the session's
        // FIRST turn, so a fresh idle fleet session has a sidecar (claudeSessionId
        // known) but no transcript yet. Binding now makes the session report
        // bound:true (the F17 readiness barrier and session_status key off presence
        // in _stickyJsonl); the tail below promotes to the real file once it lands.
        this._bindStickyJsonl(sessionId, {
          file: stp ? sidecar.transcriptPath : null,
          pendingTranscriptPath: sidecar.transcriptPath,
          sessionId: sidecar.claudeSessionId,
          mtimeMs: stp ? stp.mtimeMs : 0,
          size: stp ? stp.size : 0,
        });
        binding = this._stickyJsonl.get(sessionId);
        session.claudePinnedSessionId = sidecar.claudeSessionId;
        this.sessionStore.markDirty();
      }
      // Pinned tabs never run the mtime inference / resume-follow below.
    } else if (session && session._sidecarSeen) {
      // Previously sidecar-managed but the file is momentarily absent/unreadable
      // → keep the current binding; do NOT fall back to mtime inference (which
      // could grab a stranger session). Wait for the next sidecar write.
    } else if (!binding || binding._ticks % 5 === 0) {
      // INFERENCE FALLBACK (no sidecar — e.g. claude launched without
      // github-router). Periodically (or while unbound) reconcile the binding. A
      // tab STAYS on its bound session while that file is alive and not owned by
      // another tab; it only moves to a newer unowned session once its own has
      // gone quiet (an in-session /resume) — so a third, unrelated session can't
      // steal an active tab. agent-*.jsonl is excluded by findActiveSessions.
      const candidates = await StickyNoteJsonl.findActiveSessions(cwd, { projectsDir: this._stickyProjectsDir });
      const ownedByOthers = this._ownedClaudeSessions(sessionId);
      // Only (re)bind to a session being ACTIVELY written (recent mtime). A fresh
      // tab must NOT adopt a stale pre-existing session in the same project — that
      // would surface the old session's title/note on a tab that never ran it. An
      // already-bound session stays bound even when idle (currentValid below).
      const STICKY_BIND_RECENCY_MS = 60 * 1000;
      const freshlyActive = (c) => c.mtimeMs >= Date.now() - STICKY_BIND_RECENCY_MS;
      // The tab's own previously-bound claude session (persisted) is exempt from
      // the recency gate, so a restart / lost binding can re-resume an idle-but-
      // live session. A FRESH tab has no own-session, so it still won't adopt a
      // stale stranger session in the project.
      const ownClaudeSession = session && session.stickyClaudeSessionId;
      const eligible = (c) => !ownedByOthers.has(c.sessionId) && (freshlyActive(c) || c.sessionId === ownClaudeSession);
      const currentValid =
        binding &&
        candidates.some((c) => c.file === binding.file) &&
        !ownedByOthers.has(binding.claudeSessionId);
      if (!currentValid) {
        // Unbound, or the bound file vanished / is a subagent log / is now owned
        // by another tab → (re)bind to the newest eligible session.
        const pick = candidates.find(eligible) || null;
        if (pick) {
          this._bindStickyJsonl(sessionId, pick);
          binding = this._stickyJsonl.get(sessionId);
        } else {
          if (binding) this._stickyJsonl.delete(sessionId);
          return; // no actively-written transcript → scrape fallback / nothing to show
        }
      } else if ((binding.idleTicks || 0) >= this._stickyResumeIdleTicks) {
        // Bound file has been quiet — follow an in-session /resume to a newer
        // actively-written unowned session if one appeared.
        const newer = candidates.find(
          (c) =>
            c.file !== binding.file &&
            !ownedByOthers.has(c.sessionId) &&
            freshlyActive(c) &&
            c.mtimeMs > (binding.boundMtimeMs || 0)
        );
        if (newer) {
          this._bindStickyJsonl(sessionId, newer);
          binding = this._stickyJsonl.get(sessionId);
        }
      }
    }
    if (!binding) return;

    // Promote a pending (identity-only) sidecar binding to a full tail once the
    // transcript file appears (claude writes the .jsonl on its first turn). Until
    // then the session stays bound (bound:true for readiness/status) but has nothing
    // to tail — do NOT unbind for the missing file.
    if (binding.transcriptPending || !binding.file) {
      const ptp = binding.pendingTranscriptPath;
      const pst = ptp ? await this._statQuiet(ptp) : null;
      if (!pst) { await emitTransition(); return; } // transcript still absent → stay identity-bound
      // The transcript is brand-new (claude created it AFTER we bound), so ALL of it
      // is post-bind content. Tail AND turn-detect from byte 0 so the very first turn
      // is never skipped — there is no pre-bind history to skip here (unlike a normal
      // bind to a pre-existing transcript, which deliberately starts "from now").
      binding.file = ptp;
      binding.transcriptPending = false;
      binding.boundMtimeMs = pst.mtimeMs || 0;
      binding.offset = 0;
      binding.turnOffset = 0;
    }

    const st = await this._statQuiet(binding.file);
    if (!st) { this._stickyJsonl.delete(sessionId); return; } // file gone → unbind (note kept)
    if (binding._awaitingSize !== st.size) {
      binding._awaitingAt = 0;
      binding._awaitingSize = st.size;
    }
    // File shrank (truncated / rotated / recreated under the same name) → our
    // offsets point past the end. Drop the binding so the next poll re-resolves
    // and re-binds from scratch rather than freezing forever.
    if (st.size < (binding.offset || 0) || st.size < (binding.titleOffset || 0)) {
      this._stickyJsonl.delete(sessionId);
      return;
    }

    // --- TITLE TAIL — ALWAYS (cheap, no model). Keeps the tab title fresh from
    // claude's own ai-title even when note summarisation is paused (collapsed).
    // Also drives idleTicks/boundMtimeMs so the binder tracks file activity
    // regardless of whether we're summarising. ---
    if (st.size > (binding.titleOffset || 0)) {
      const tr = await StickyNoteJsonl.readNewAiTitle(binding.file, binding.titleOffset || 0);
      if (tr.offset > (binding.titleOffset || 0)) {
        binding.titleOffset = tr.offset;
        binding.idleTicks = 0;
        binding.boundMtimeMs = st.mtimeMs;
        if (tr.aiTitle && tr.aiTitle !== binding.lastTitle) {
          binding.lastTitle = tr.aiTitle;
          this._applyAiTitle(sessionId, tr.aiTitle);
        }
      } else {
        binding.idleTicks = (binding.idleTicks || 0) + 1; // new bytes, no complete line yet
      }
    } else {
      binding.idleTicks = (binding.idleTicks || 0) + 1; // quiet → eligible to follow /resume
    }

    // --- TURN-BOUNDARY DETECTION — ALWAYS (cheap; no model). Decoupled from the
    // UI expand-gate so headless / fleet-spawned claude sessions (no WebSocket
    // viewer ever expands their card) still emit turn_ended / became_busy /
    // became_idle and keep lastGrowing/lastEndsOnAssistant fresh — the signals the
    // control plane's await_turn + send_message confirmation depend on (F14). Uses
    // its OWN turnOffset so it never advances the note summariser's horizon
    // (binding.offset); the summariser below keeps its independent, expand-gated
    // catch-up read. ---
    if (typeof binding.turnOffset !== 'number') binding.turnOffset = st.size; // start "from now": no replay of pre-bind history
    if (st.size < binding.turnOffset) binding.turnOffset = st.size; // truncated/rotated
    if (st.size > binding.turnOffset) {
      const td = await StickyNoteJsonl.readNewTurns(binding.file, binding.turnOffset);
      if (td.offset > binding.turnOffset) {
        binding.turnOffset = td.offset;
        const ends = require('./sticky-note-jsonl').endsOnAssistant(td.turns);
        binding.lastGrowing = (td.turns.length > 0 && !ends);
        if (ends && !binding.lastEndsOnAssistant) {
          if (typeof this._controlAppendStateEvent === 'function') {
            this._controlAppendStateEvent(sessionId, 'turn_ended');
          } else if (this.controlEventBus) {
            this.controlEventBus.append(sessionId, 'turn_ended');
          }
          binding.lastTurnEndedAt = Date.now();
        }
        binding.lastEndsOnAssistant = ends;
      }
    }

    // --- NOTE INFERENCE — ONLY while a viewer has the card EXPANDED. Collapsed
    // tabs freeze the note at their horizon (binding.offset); on re-expand the
    // next poll resumes from there in a single bounded catch-up read. Turn
    // detection above already ran unconditionally, so collapsing a tab no longer
    // blinds the control plane to turn boundaries. ---
    // NOTE INFERENCE — ONLY while a viewer has the card EXPANDED. A control/fleet
    // session pumped purely for binding + turn detection has no expanded viewer and
    // stops here; even if it didn't, feedTurns() no-ops for a session the summariser
    // never enabled, so the model is never fed for a non-summarised session.
    if (!this._isStickyExpandedActive(sessionId)) {
      await emitTransition();
      return;
    }
    if (st.size <= binding.offset) {
      await emitTransition();
      return;
    }
    const { turns, offset } = await StickyNoteJsonl.readNewTurns(binding.file, binding.offset);
    if (offset <= binding.offset) {
      await emitTransition();
      return; // no complete new line for the note yet
    }
    binding.offset = offset;
    this._claudeOffsets.set(binding.claudeSessionId, offset); // resume continues from here
    await emitTransition();
    const text = StickyNoteJsonl.formatTurns(turns);
    if (!text) return;
    this.stickyNoteSummarizer.feedTurns(sessionId, text, binding.lastTitle);
  }

  /** True when ≥1 connected client has this tab's card expanded. */
  _isStickyExpandedActive(sessionId) {
    const set = this._stickyActive.get(sessionId);
    return !!(set && set.size > 0);
  }

  /** Apply claude's ai-title to the tab (no inference) and broadcast it. */
  _applyAiTitle(sessionId, aiTitle) {
    const session = this.claudeSessions.get(sessionId);
    if (!session || session.nameIsUserSet) return; // a manual rename pins the name
    const title = String(aiTitle || '').trim().slice(0, 80);
    if (!title || title === session.autoTitle) return;
    session.autoTitle = title;
    this.sessionStore.markDirty();
    this.broadcastToSession(sessionId, {
      type: 'sticky_note_update',
      sessionId,
      stickyNote: session.stickyNote || null,
      autoTitle: title,
    });
  }

  /** Claude sessionIds currently bound by OTHER tabs (ownership set). */
  _ownedClaudeSessions(exceptSessionId) {
    const owned = new Set();
    for (const [sid, b] of this._stickyJsonl) {
      if (sid !== exceptSessionId && b && b.claudeSessionId) owned.add(b.claudeSessionId);
    }
    // Also reserve every OTHER tab's pinned (sidecar) claude session, so an
    // unpinned tab's inference fallback can never adopt a pinned tab's session
    // even in the window before that tab has finished binding.
    for (const [sid, s] of this.claudeSessions) {
      if (sid !== exceptSessionId && s && s.claudePinnedSessionId) owned.add(s.claudePinnedSessionId);
    }
    return owned;
  }

  /** Absolute path to this server's per-tab claude-bind sidecar directory. */
  _claudeBindSidecarDir() {
    const base = (this.sessionStore && this.sessionStore.storageDir) || path.join(os.homedir(), '.ai-or-die');
    return path.join(base, 'claude-bindings');
  }

  /**
   * Allocate (and record on the session) the per-tab sidecar path that
   * github-router's SessionStart/SessionEnd hook writes the active claude
   * session id + transcript path into. Returns the absolute path, or null on
   * failure (the tab then degrades to the inference fallback). Best-effort mkdir.
   */
  _prepareClaudeBindSidecar(sessionId, session) {
    try {
      const dir = this._claudeBindSidecarDir();
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* best-effort */ }
      const file = path.join(dir, `${sessionId}.json`);
      // Clear any stale sidecar from a previous run/launch so this fresh terminal
      // start waits for github-router's next SessionStart write instead of binding
      // to a dead session's transcript. (Runs before any github-router launch in
      // this shell, so it can't race the hook.)
      try { fs.unlinkSync(file); } catch (_) { /* none / best-effort */ }
      if (session) {
        session.claudeBindSidecar = file;
        session._sidecarSeen = false;
      }
      return file;
    } catch (_) {
      return null;
    }
  }

  /**
   * Read + parse the tab's sidecar (written atomically by github-router's hook).
   * Returns the parsed record `{claudeSessionId, transcriptPath, cwd, event,
   * source?, reason?}` or null (no file / unreadable / malformed). The file is
   * tiny, so we re-read every tick (no mtime cache: a SessionEnd→SessionStart
   * rewrite on /resume can land in the same mtime tick, and a cache keyed on
   * mtime would then serve the stale record and never rebind). Never throws — any
   * error yields null so the poll is unaffected.
   */
  async _readClaudeBindSidecar(session) {
    if (!session || !session.claudeBindSidecar) return null;
    let raw;
    try {
      raw = await fs.promises.readFile(session.claudeBindSidecar, 'utf8');
    } catch (_) {
      return null; // no sidecar yet (claude not launched via github-router, or pending)
    }
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || typeof obj.claudeSessionId !== 'string') return null;
      return obj;
    } catch (_) {
      return null; // mid-write / malformed → skip this tick
    }
  }

  /** Best-effort: delete a tab's sidecar file (on session close). */
  _removeClaudeBindSidecar(session) {
    const file = session && session.claudeBindSidecar;
    if (!file) return;
    try { fs.unlinkSync(file); } catch (_) { /* already gone / best-effort */ }
  }

  /**
   * Startup sweep: remove orphan sidecar files (`<sessionId>.json`) whose tab is
   * no longer in the active session set. Best-effort, bounded, never fatal.
   */
  _sweepClaudeBindSidecars() {
    try {
      const dir = this._claudeBindSidecarDir();
      let entries;
      try { entries = fs.readdirSync(dir); } catch (_) { return; } // no dir → nothing to sweep
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const sid = name.slice(0, -'.json'.length);
        if (this.claudeSessions.has(sid)) continue; // live tab → keep
        try { fs.unlinkSync(path.join(dir, name)); } catch (_) { /* best-effort */ }
      }
    } catch (_) { /* never fatal */ }
  }


  /**
   * Bind a tab to a claude transcript and resume its durable note. Binds near the
   * end of the file so the first summary uses recent context, not the whole
   * (possibly huge) history; the accumulated state comes from `_claudeNotes`.
   */
  _bindStickyJsonl(sessionId, chosen) {
    const claudeSessionId = chosen.sessionId;
    const INITIAL_WINDOW = 24 * 1024;
    // A pending (identity-only) bind has no transcript file yet — claude creates
    // the .jsonl on its first turn. Stay bound; the pump promotes it (computing the
    // real offset) once the file appears.
    const transcriptPending = !chosen.file;
    // Resume from the last consumed offset if we've seen this session before
    // (avoids re-summarising the recent window); else start near the end.
    const cached = this._claudeOffsets.get(claudeSessionId);
    const offset = transcriptPending
      ? 0
      : (typeof cached === 'number' && cached <= (chosen.size || 0)
        ? cached
        : Math.max(0, (chosen.size || 0) - INITIAL_WINDOW));
    this._stickyJsonl.set(sessionId, {
      file: chosen.file || null,
      pendingTranscriptPath: chosen.pendingTranscriptPath || chosen.file || null,
      transcriptPending,
      offset,
      titleOffset: 0, // ai-title tail walks the whole file from the start
      lastTitle: null,
      claudeSessionId,
      boundMtimeMs: chosen.mtimeMs || 0,
      idleTicks: 0,
      _ticks: 0,
    });
    const prior = this._claudeNotes.get(claudeSessionId) || null;
    // Seed the summariser with the resumed note + rev, record the bound session,
    // and drop any turns accumulated for the PREVIOUS session.
    this.stickyNoteSummarizer.onRebind(sessionId, {
      claudeSessionId,
      note: prior,
      rev: prior ? prior.rev : undefined,
    });
    const session = this.claudeSessions.get(sessionId);
    if (!session) return;
    session.stickyClaudeSessionId = claudeSessionId; // persisted → cross-restart resume
    session.stickyNote = prior ? { ...prior } : null;
    this.sessionStore.markDirty();
    // Reflect the resumed (or cleared) note on the card immediately.
    this.broadcastToSession(sessionId, {
      type: 'sticky_note_update',
      sessionId,
      stickyNote: session.stickyNote,
      autoTitle: session.nameIsUserSet ? null : (prior && prior.title) || session.autoTitle || null,
    });
  }

  /** Keep only the most-recently-updated notes so the durable store stays bounded. */
  _capClaudeNotes() {
    if (this._claudeNotes.size > this._claudeNotesCap) {
      const entries = [...this._claudeNotes.entries()].sort(
        (a, b) => new Date(b[1].updatedAt || 0) - new Date(a[1].updatedAt || 0)
      );
      this._claudeNotes = new Map(entries.slice(0, this._claudeNotesCap));
    }
    // Bound the resume-offset cache too: keep offsets only for sessions we still
    // track a note for, or are currently bound to.
    if (this._claudeOffsets && this._claudeOffsets.size > this._claudeNotesCap) {
      const keep = new Set(this._claudeNotes.keys());
      for (const b of this._stickyJsonl.values()) if (b && b.claudeSessionId) keep.add(b.claudeSessionId);
      for (const k of [...this._claudeOffsets.keys()]) if (!keep.has(k)) this._claudeOffsets.delete(k);
    }
  }

  async _statQuiet(file) {
    try {
      return await fs.promises.stat(file);
    } catch {
      return null;
    }
  }

  // Merge a model delta ({goal,done,remaining,update}) onto a previous note,
  // refining goal/done/remaining (keeping prior values when the small model
  // returns an empty field) and prepending the one `update` to the append-only
  // log (skip empty / exact-duplicate-of-last, cap 25).
  _mergeStickyNote(prev, delta, autoTitle, rev) {
    prev = prev || {};
    const now = new Date().toISOString();
    const updates = Array.isArray(prev.updates) ? prev.updates.slice() : [];
    const upd = (delta.update || '').trim();
    if (upd && !(updates[0] && updates[0].text === upd)) {
      updates.unshift({ text: upd, at: now });
      if (updates.length > 25) updates.length = 25;
    }
    return {
      title: autoTitle || prev.title || '',
      goal: delta.goal || prev.goal || '',
      done: (delta.done && delta.done.length) ? delta.done : (prev.done || []),
      remaining: (delta.remaining && delta.remaining.length) ? delta.remaining : (prev.remaining || []),
      updates,
      rev: typeof rev === 'number' ? rev : (prev.rev || 0) + 1,
      updatedAt: now,
      status: 'idle',
      error: null,
    };
  }

  // Persist + broadcast a freshly generated note (called by the summariser).
  // The note is INCREMENTAL: goal/done/remaining are refined each turn, and the
  // single `update` is prepended to an append-only Updates log (newest first).
  _onStickyNoteResult(sessionId, payload) {
    const session = this.claudeSessions.get(sessionId);
    if (!session) return;
    if (session.stickyNotesEnabled === false) return; // opted out mid-flight
    const delta = payload.note; // { goal, done[], remaining[], update }
    const curBinding = this._stickyJsonl.get(sessionId);
    // Stale-binding result: the tab rebound to (or closed off) a DIFFERENT claude
    // session while this inference ran, so the result describes the OUTGOING
    // session. Don't touch the current session's UI, but still persist it under
    // the outgoing session's id so that session's note resumes losslessly later.
    if (
      payload.claudeSessionId &&
      (!curBinding || curBinding.claudeSessionId !== payload.claudeSessionId)
    ) {
      const old = this._claudeNotes.get(payload.claudeSessionId) || null;
      this._claudeNotes.set(payload.claudeSessionId, this._mergeStickyNote(old, delta, payload.autoTitle));
      this._capClaudeNotes();
      return;
    }
    // Defensive: never let an older/stale result clobber a newer note.
    const incomingRev = payload.rev || 0;
    if (session.stickyNote && incomingRev <= (session.stickyNote.rev || 0)) return;

    session.stickyNote = this._mergeStickyNote(session.stickyNote, delta, payload.autoTitle, payload.rev);
    if (!session.nameIsUserSet && payload.autoTitle) {
      session.autoTitle = payload.autoTitle;
    }
    // Mirror into the durable per-claude-session store so the note resumes when
    // the tab closes/reopens or the session is resumed elsewhere.
    if (curBinding && curBinding.claudeSessionId) {
      this._claudeNotes.set(curBinding.claudeSessionId, session.stickyNote);
      this._capClaudeNotes();
    }
    this.sessionStore.markDirty();
    this.broadcastToSession(sessionId, {
      type: 'sticky_note_update',
      sessionId,
      stickyNote: session.stickyNote,
      autoTitle: session.nameIsUserSet ? null : session.autoTitle,
    });
  }

  _handleSetStickyNotes(wsId, data) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;
    const sessionId = data.sessionId || wsInfo.claudeSessionId;
    const session = this.claudeSessions.get(sessionId);
    if (!session) return;
    // Only a socket that belongs to the session may change it (mirrors resize).
    if (!session.connections.has(wsId)) return;
    const enabled = data.enabled !== false;
    session.stickyNotesEnabled = enabled;
    this.sessionStore.markDirty();
    if (enabled) {
      if (session.active && this._isStickyEligible(session.agent)) {
        this._maybeStartStickyNotes(sessionId, session.agent, session.cols, session.rows);
      }
    } else {
      this.stickyNoteSummarizer.disable(sessionId);
      this._stickyJsonl.delete(sessionId);
    }
  }

  /**
   * A client reports whether it currently has a tab's sticky-note card EXPANDED.
   * Expanded viewers are reference-counted per session; note summarisation runs
   * only while the count is > 0 (the cheap ai-title tail runs regardless).
   */
  _handleSetStickyActive(wsId, data) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;
    const sessionId = data && data.sessionId;
    if (!sessionId) return;
    const active = data.active === true;
    const set = this._stickyActive.get(sessionId);
    if (active) {
      const session = this.claudeSessions.get(sessionId);
      if (!session) return;
      // The socket must belong to the session — accept membership via either the
      // connection set OR the socket's currently-joined session, so a reconnect
      // (where the new wsId may not be in `connections` yet) isn't dropped.
      const belongs =
        wsInfo.claudeSessionId === sessionId ||
        (session.connections && session.connections.has(wsId));
      if (!belongs) return;
      if (set) set.add(wsId);
      else this._stickyActive.set(sessionId, new Set([wsId]));
    } else if (set) {
      set.delete(wsId);
      if (!set.size) this._stickyActive.delete(sessionId);
    }
  }

  /** Drop a disconnected socket from every expanded-viewer set (no leaked leases). */
  _clearStickyActiveForWs(wsId) {
    for (const [sessionId, set] of this._stickyActive) {
      if (set.delete(wsId) && !set.size) this._stickyActive.delete(sessionId);
    }
  }

  _handleSetTabName(wsId, data) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;
    const sessionId = data.sessionId || wsInfo.claudeSessionId;
    const session = this.claudeSessions.get(sessionId);
    if (!session) return;
    if (!session.connections.has(wsId)) return;
    // Only pin the name (blocking auto-titles) when a real name is provided.
    if (typeof data.name === 'string' && data.name.trim()) {
      session.name = data.name.trim();
      session.nameIsUserSet = true;
      this.sessionStore.markDirty();
    }
  }

  // Sends a lightweight event to all WebSocket connections that are NOT joined
  // to the specified session. This enables clients to track activity in background
  // sessions for notification purposes without receiving full terminal output.
  broadcastSessionActivity(sessionId, eventType, extraData = {}) {
    const session = this.claudeSessions.get(sessionId);
    const sessionName = session ? session.name : '';
    this.webSocketConnections.forEach((wsInfo, wsId) => {
      if (wsInfo.claudeSessionId === sessionId) return;
      if (wsInfo.ws.readyState !== WebSocket.OPEN) return;
      this.sendToWebSocket(wsInfo.ws, { type: eventType, sessionId, sessionName, ...extraData });
    });
  }

  // Coalesces output into 16ms windows to reduce WebSocket send frequency.
  // During heavy output (~500 PTY batches/sec), this reduces sends to ~60/sec,
  // freeing the event loop for input message processing.
  // Flushes immediately when pending output exceeds MAX_COALESCE_BYTES to
  // bound event loop blocking and provide yield points for input processing.
  _throttledOutputBroadcast(sessionId, data) {
    const session = this.claudeSessions.get(sessionId);
    if (!session) return;

    if (!session._pendingChunks) {
      session._pendingChunks = [];
      session._pendingBytes = 0;
    }
    session._pendingChunks.push(data);
    session._pendingBytes += data.length;

    // Select coalescing parameters based on session priority
    const isForeground = session.priority !== 'background';
    const maxBytes = isForeground ? MAX_COALESCE_BYTES_FG : MAX_COALESCE_BYTES_BG;
    const coalesceMs = isForeground ? COALESCE_MS_FG : COALESCE_MS_BG;

    // Cap: flush immediately when buffer exceeds threshold.
    // Input priority is handled by process.nextTick in the message handler —
    // keystrokes jump ahead of pending I/O callbacks naturally without needing
    // to defer flushes here (deferring causes output accumulation during bursts).
    if (session._pendingBytes > maxBytes) {
      if (session._outputFlushTimer) {
        clearTimeout(session._outputFlushTimer);
        session._outputFlushTimer = null;
      }
      this._flushSessionOutput(sessionId);
      return;
    }

    if (!session._outputFlushTimer) {
      session._outputFlushTimer = setTimeout(() => {
        session._outputFlushTimer = null;
        this._flushSessionOutput(sessionId);
      }, coalesceMs);
      if (session._outputFlushTimer.unref) {
        session._outputFlushTimer.unref();
      }
    }
  }

  _flushSessionOutput(sessionId) {
    const session = this.claudeSessions.get(sessionId);
    if (!session || !session._pendingChunks || session._pendingChunks.length === 0) return;
    if (session._flushing) return; // Prevent concurrent flush
    session._flushing = true;

    try {
      const pending = session._pendingChunks.join('');
      session._pendingChunks = [];
      session._pendingBytes = 0;

      // Skip broadcast if no clients connected (idle session)
      if (session.connections.size === 0) return;

      // Strip focus-tracking sequences server-side so clients can use
      // the zero-copy Uint8Array write path (no string decode needed)
      const cleaned = pending.replace(/\x1b\[\[?[IO]/g, '');

      // Send terminal output as binary WebSocket frames — skips JSON
      // serialization/escaping and avoids zlib thread pool contention
      const binaryMsg = Buffer.from(cleaned, 'utf-8');
      session.connections.forEach(wsId => {
        const wsInfo = this.webSocketConnections.get(wsId);
        if (wsInfo &&
            wsInfo.claudeSessionId === sessionId &&
            wsInfo.ws.readyState === WebSocket.OPEN) {
          // Flow control: skip clients that signaled pause
          if (wsInfo._flowPaused) {
            return; // Frame dropped for this client; circular buffer retains data for reconnection replay
          }
          // Backpressure: skip clients that can't consume fast enough
          const bpLimit = session.priority === 'background' ? BACKPRESSURE_LIMIT_BG : BACKPRESSURE_LIMIT_FG;
          if (wsInfo.ws.bufferedAmount > bpLimit) {
            return;
          }
          wsInfo.ws.send(binaryMsg, { binary: true, compress: false });
        }
      });
    } finally {
      session._flushing = false;
    }
  }

  _flushAndClearOutputTimer(session, sessionId) {
    if (session._outputFlushTimer) {
      clearTimeout(session._outputFlushTimer);
      session._outputFlushTimer = null;
    }
    if (session._pendingChunks && session._pendingChunks.length > 0) {
      this._flushSessionOutput(sessionId);
    }
  }

  /**
   * Sweep stale inactive sessions older than 7 days. Extracted from the
   * setInterval body for testability — pre-fix this method did NOT tear
   * down the PTY process via bridge.stopSession, so an evicted session
   * whose `active` flag was stale (PTY exited but flag never updated, or
   * mid-flight teardown) would orphan its node-pty wrapper. With the
   * listener-disposal fix in base-bridge.js this also leaked the onData/
   * onExit closures + their dataBuffer refs — a slow EMFILE bleed on
   * long-running production servers.
   *
   * Idempotent and safe to invoke from tests directly.
   * @returns {Promise<number>} count of sessions evicted
   */
  async _evictStaleSessions() {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let evictedCount = 0;

    // PROC-04: lazy-tombstone min-heap sweep. Pop the oldest entry;
    // if its lastActivity no longer matches the source-of-truth Map,
    // treat as a tombstone and continue. If the top is fresh, the
    // heap invariant says every other entry is fresh too — early exit
    // in O(log n) instead of O(n). See docs/audits/proc-04-sublinear-eviction.md.
    //
    // PROC-04 fix-up: at most one self-healing rebuild per sweep. If the
    // first pass exhausts the heap while the Map still has entries,
    // some sessions are missing from the heap (e.g. direct
    // `claudeSessions.set(...)` from tests or any future code path that
    // bypassed `_pushEvictionEntry`). Rebuild O(n) and run pass 2.
    // Zero overhead in the hot path — the rebuild only fires when the
    // heap is observably under-covering the Map.
    let didOneTimeRebuild = false;

    for (let pass = 0; pass < 2; pass++) {
      let popsThisSweep = 0;
      const popBudget = 4 * (this.claudeSessions.size + 1) + 1024;

      while (this._evictionHeap.size > 0 && popsThisSweep < popBudget) {
        const top = this._evictionHeap.peek();
        const session = top ? this.claudeSessions.get(top.id) : null;

        if (!session) {
          // Session deleted between the push and this pop — tombstone.
          this._evictionHeap.pop();
          popsThisSweep++;
          continue;
        }

        const currentLA = new Date(session.lastActivity || session.created).getTime();
        if (currentLA !== top.lastActivity) {
          // lastActivity was bumped after this entry was pushed —
          // tombstone (a fresher entry exists deeper in the heap).
          this._evictionHeap.pop();
          popsThisSweep++;
          continue;
        }

        if (currentLA >= sevenDaysAgo) {
          // Top is the genuinely-oldest current entry AND it's fresh.
          // Heap invariant: every other entry is at least as fresh.
          // We may have to rebuild if tombstones have ballooned the heap.
          this._maybeRebuildEvictionHeap();
          return evictedCount;
        }

        // Top is stale by time. Check the other two eviction predicates.
        const connections = session.connections;
        const connCount = connections && typeof connections.size === 'number' ? connections.size : 0;
        if (session.active || connCount !== 0) {
          // In use — pop the entry. A future bump of lastActivity will
          // re-push a current entry. If the session truly stays pinned
          // and silent forever, it stays out of the heap, matching the
          // pre-PROC-04 loop's behaviour (which also skipped it).
          this._evictionHeap.pop();
          popsThisSweep++;
          continue;
        }

        // Evict.
        this._evictionHeap.pop();
        popsThisSweep++;

        // Drive PTY teardown for the evicted session. stopSession is
        // idempotent — if the bridge already lost the session (PTY exited
        // by itself, hadn't been started, etc.) the call is a cheap no-op.
        // The bridge owns the FD-leak prevention (listener disposal); calling
        // it on eviction is the only chance a hung/zombie PTY gets to be
        // cleaned up before its parent session disappears from claudeSessions.
        const bridge = this.getBridgeForAgent(session.agent);
        if (bridge && typeof bridge.stopSession === 'function') {
          try {
            await bridge.stopSession(top.id);
          } catch (err) {
            console.warn(`Eviction stopSession failed for ${top.id}: ${err && err.message}`);
          }
        }

        // Same per-session cleanup contract as the DELETE handler:
        // tear down any orphan fs-watch SSE BEFORE removing the parent session
        // entry, otherwise the chokidar watcher leaks (PR #99 regression). The
        // voice-upload rate-limit history lives on the session object and is
        // dropped with it below.
        try { this._cleanupFsWatchSession(top.id, 'session_evicted'); } catch (_) { /* ignore */ }
        try { this.stickyNoteSummarizer.cancel(top.id); } catch (_) { /* ignore */ }
        try { this._stickyJsonl.delete(top.id); } catch (_) { /* ignore */ }
        if (this._foregroundSessionId === top.id) this._foregroundSessionId = null;
        this.claudeSessions.delete(top.id);
        this.controlEventBus.append(top.id, 'session_deleted');
        this.activityBroadcastTimestamps.delete(top.id);
        try { this.sessionStore.markDirty(); } catch (_) { /* ignore */ }
        evictedCount++;
      }

      // Pass-end: if the heap is drained but the Map still has entries,
      // some sessions never made it into the heap. Rebuild and run pass 2.
      if (
        !didOneTimeRebuild &&
        this._evictionHeap.size === 0 &&
        this.claudeSessions.size > 0
      ) {
        this._rebuildEvictionHeapNow();
        didOneTimeRebuild = true;
        continue;
      }
      break;
    }

    this._maybeRebuildEvictionHeap();
    return evictedCount;
  }

  /**
   * PROC-04: push a {id, lastActivity} entry into the eviction heap.
   * Call AFTER `claudeSessions.set(...)` for new sessions, and AFTER
   * any `session.lastActivity = new Date()` mutation. Reading
   * `session.lastActivity` inside this helper avoids storing it twice
   * at call sites; the lazy-tombstone protocol handles the case where
   * a later bump invalidates this entry.
   */
  _pushEvictionEntry(sessionId) {
    const session = this.claudeSessions.get(sessionId);
    if (!session) return;
    const la = session.lastActivity || session.created;
    const ts = la instanceof Date ? la.getTime() : new Date(la).getTime();
    if (!Number.isFinite(ts)) return;
    this._evictionHeap.push({ id: sessionId, lastActivity: ts });
  }

  /**
   * PROC-04: rebuild the heap from a fresh snapshot of claudeSessions
   * when tombstones outnumber live entries 2:1. Bounds heap-size growth
   * under sustained activity bursts (e.g. 100 messages/sec for an hour
   * is 360 K pushes — without rebuild, every pop would walk past
   * tombstones forever). Cheap when sessions are few (< 100); only
   * matters for the long-running large-N case.
   */
  _maybeRebuildEvictionHeap() {
    const live = this.claudeSessions.size;
    if (live <= 100) return;
    if (this._evictionHeap.size <= 2 * live) return;
    this._rebuildEvictionHeapNow();
  }

  /**
   * PROC-04 fix-up: unconditional heap rebuild from the current Map.
   * Used both as the implementation of `_maybeRebuildEvictionHeap` (when
   * the tombstone-bound trigger fires) and as the safety-net repair at
   * the start of every sweep (when heap.size < live, indicating some
   * Map entry never made it into the heap — e.g. direct
   * `claudeSessions.set(...)` from a test that didn't go through
   * `_pushEvictionEntry`). O(n) via Floyd's heapify.
   */
  _rebuildEvictionHeapNow() {
    const fresh = [];
    for (const [id, session] of this.claudeSessions) {
      if (!session) continue;
      const la = session.lastActivity || session.created;
      const ts = la instanceof Date ? la.getTime() : new Date(la).getTime();
      if (!Number.isFinite(ts)) continue;
      fresh.push({ id, lastActivity: ts });
    }
    this._evictionHeap.rebuild(fresh);
  }

  /**
   * Centralized cleanup for a session's fs-watch SSE entry. Idempotent —
   * safe to call from session-delete, eviction-sweep, server-close, and
   * the SSE replace path without double-closing.
   *
   * Background: PR #99 introduced _fsWatchSessions but only cleared
   * entries via the SSE req.on('close') path. If the client never
   * disconnected (browser tab kept open, network black-holed, etc.) and
   * the session was deleted server-side, the chokidar watcher leaked —
   * each carrying ~10 inotify watches plus an open TCP connection.
   * After weeks of uptime on Windows-primary production this exhausted
   * the per-process FD limit (EMFILE) and the server stopped accepting
   * new connections, so a browser refresh appeared to hang.
   *
   * @param {string} sessionId
   * @param {string} reason — diagnostic tag for logs ('session_deleted',
   *                          'session_evicted', 'server_close', 'replaced',
   *                          'session_missing', etc.)
   * @returns {boolean} true if an entry existed and cleanup ran; false otherwise.
   */
  _cleanupFsWatchSession(sessionId, reason) {
    if (!this._fsWatchSessions) return false;
    const entry = this._fsWatchSessions.get(sessionId);
    if (!entry) return false;

    // Delete BEFORE invoking entry.cleanup so re-entrant calls (cleanup
    // may itself trigger req.on('close') → cleanup again synchronously
    // on some Node versions) find no entry and bail out.
    this._fsWatchSessions.delete(sessionId);
    console.warn('[fs-watch-cleanup]', { sessionId: sessionId, reason: reason });

    if (typeof entry.cleanup === 'function') {
      // Preferred path: the SSE route's own cleanup handles end-event +
      // res.end + watcher.close + per-IP decrement in one place.
      try {
        entry.cleanup(reason);
      } catch (_) {
        // If the route's cleanup throws before fully tearing down (e.g.
        // a non-thenable .close(), an exception during res.end), run
        // the manual fallback so the watcher/FD doesn't leak. The map
        // entry is already gone, so no caller can reach this entry
        // again — this is our only recovery path.
        this._teardownFsWatchEntryFallback(entry);
      }
    } else {
      // Manual fallback for entries that don't carry a cleanup fn
      // (defensive — e.g. tests that hand-inject map entries).
      this._teardownFsWatchEntryFallback(entry);
    }
    return true;
  }

  /**
   * Best-effort teardown of a fs-watch entry. Used by
   * _cleanupFsWatchSession when the route-level cleanup is missing OR
   * has thrown. Every step is independently try/catch-wrapped so one
   * failure doesn't block the others.
   */
  _teardownFsWatchEntryFallback(entry) {
    if (!entry) return;
    if (entry.timer) { try { clearTimeout(entry.timer); } catch (_) { /* ignore */ } }
    if (entry.watcher && typeof entry.watcher.close === 'function') {
      try {
        const p = entry.watcher.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) { /* ignore */ }
    }
    if (entry.res && !entry.res.writableEnded) {
      try { entry.res.end(); } catch (_) { /* ignore */ }
    }
    if (entry.ip && this._activeWatchersByIp) {
      try {
        const c = this._activeWatchersByIp.get(entry.ip) || 0;
        if (c <= 1) this._activeWatchersByIp.delete(entry.ip);
        else this._activeWatchersByIp.set(entry.ip, c - 1);
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Snapshot of leak-relevant resources at one point in time.
   *
   * Powers `GET /api/diagnostics` (on-demand) and the 5-minute diagnostics
   * heartbeat log (continuous, for post-incident grep). Counts + sizes only —
   * no paths, no usernames, no session content — safe to expose unauthenticated.
   *
   * Use this to spot which resource is growing when the server eventually
   * goes unresponsive. Heap growing → memory leak. fd_count growing → FD
   * exhaustion. active_handles growing → unclosed timers/listeners.
   * fs_watch_sessions or voice_upload_counts growing → session-cleanup gap.
   *
   * Cross-platform: fd_count is Linux-only (reads /proc/self/fd). null on
   * macOS/Windows — those platforms use lsof / Process Explorer respectively
   * for FD inspection.
   */
  _collectDiagnostics() {
    const mem = process.memoryUsage();
    const handles = (process._getActiveHandles && process._getActiveHandles()) || [];
    const requests = (process._getActiveRequests && process._getActiveRequests()) || [];
    let fdCount = null;
    try {
      if (process.platform === 'linux') {
        fdCount = fs.readdirSync('/proc/self/fd').length;
      }
    } catch (_) { /* ignore — /proc may be unavailable in sandboxes */ }
    return {
      uptime_seconds: Math.round(process.uptime()),
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        rss_mb: +(mem.rss / 1048576).toFixed(1),
        heap_used_mb: +(mem.heapUsed / 1048576).toFixed(1),
        heap_total_mb: +(mem.heapTotal / 1048576).toFixed(1),
        external_mb: +(mem.external / 1048576).toFixed(1),
        array_buffers_mb: +((mem.arrayBuffers || 0) / 1048576).toFixed(1),
      },
      process: {
        active_handles: handles.length,
        active_requests: requests.length,
        fd_count: fdCount,
      },
      sessions: {
        total: this.claudeSessions.size,
        ws_connections: this.webSocketConnections.size,
        fs_watch_sessions: (this._fsWatchSessions && this._fsWatchSessions.size) || 0,
        voice_upload_counts: Array.from(this.claudeSessions.values())
          .filter(s => s._voiceUploadTimestamps && s._voiceUploadTimestamps.length).length,
        activity_broadcast_timestamps: (this.activityBroadcastTimestamps && this.activityBroadcastTimestamps.size) || 0,
      },
      // Deterministic-shutdown guard status. On win32, job_guard_active reflects whether
      // the supervisor established the kill-on-close Job Object (false ⇒ degraded:
      // EDR/CLM/koffi unavailable ⇒ best-effort taskkill teardown). null off win32 (the
      // job mechanism is Windows-only; POSIX uses process-group teardown). See
      // docs/specs/process-shutdown.md.
      process_guard: {
        job_guard_active: process.platform === 'win32' ? (process.env.AOD_JOB_GUARD === '1') : null,
        supervised: !!this.supervised,
      },
      // DISK-02/03: cached disk usage sample (60 s TTL, never blocks the
      // event loop). Populated by _sampleDiskUsage() — see method
      // comment for the time-budget contract.
      disk: this._buildDiagnosticsDiskBlock(),
    };
  }

  /**
   * DISK-03: build the `disk` block for diagnostics, combining the
   * cached _diskUsageCache sample with quota state + circuit breaker
   * status.
   */
  _buildDiagnosticsDiskBlock() {
    const sample = this._diskUsageCache || { stale: true, note: 'no sample yet' };
    const totalMb = this._diskQuotaMb;
    let usedPct = null;
    if (totalMb && typeof sample.ai_or_die_dir_bytes === 'number') {
      usedPct = +((sample.ai_or_die_dir_bytes / (totalMb * 1024 * 1024)) * 100).toFixed(2);
    }
    return {
      ...sample,
      quota_total_mb: totalMb,
      quota_used_pct: usedPct,
      circuit_breaker_open: !!this._diskFull,
      circuit_breaker_since: this._diskFullSince,
      // DISK-04b: drift-watch counter for SessionStore save failures.
      // Increments monotonically on every saveSessions() failure (rename
      // race regression, ENOSPC, EBUSY, EACCES, EIO, etc.). Decoupled
      // from log-line format so soak harness gates can watch for
      // non-zero delta without stderr-grep coupling. Should remain at 0
      // under sustained load post-DISK-04 fix.
      save_failure_count: (this.sessionStore && this.sessionStore._saveFailureCount) || 0,
    };
  }

  /**
   * DISK-02/03: sample disk usage under ~/.ai-or-die/ and
   * ~/.claude/projects/ with a strict time budget. Caches the result
   * for 60 s. NEVER blocks the event loop: each directory walk is
   * yield-friendly (async readdir) and aborts after `budgetMs`.
   *
   * Returns the cached result (which is also stored on
   * this._diskUsageCache for the diagnostics endpoint to pick up).
   */
  async _sampleDiskUsage(budgetMs = 50) {
    const now = Date.now();
    if (this._diskUsageCache && (now - this._diskUsageCacheAt < 60 * 1000)) {
      return this._diskUsageCache;
    }
    const deadline = now + budgetMs;
    const sample = { sampled_at: new Date(now).toISOString() };

    // Sample ~/.ai-or-die/ (sessions.json + .crash + future content).
    try {
      const sessionsDir = this.sessionStore && this.sessionStore.storageDir;
      if (sessionsDir) {
        // Exclude the local-model cache (~/.ai-or-die/models): a one-time
        // intentional download (STT ~670MB, sticky-notes ~800MB) is NOT the
        // runaway session-data growth this quota is meant to bound. Counting
        // it would trip the disk-full breaker and block session creation.
        const modelsPath = require('path').join(sessionsDir, 'models');
        const r = await this._dirSizeWithBudget(sessionsDir, deadline, new Set([modelsPath]));
        sample.ai_or_die_dir_bytes = r.bytes;
        sample.ai_or_die_dir_files = r.files;
        sample.ai_or_die_dir_stale = r.timedOut || false;
      }
    } catch (_) { /* ignore */ }

    // Sample ~/.claude/projects/ (the JSONL corpus we read).
    try {
      const projectsDir = this.usageReader && this.usageReader.claudeProjectsPath;
      if (projectsDir) {
        const r = await this._dirSizeWithBudget(projectsDir, deadline);
        sample.claude_projects_bytes = r.bytes;
        sample.claude_projects_files = r.files;
        sample.claude_projects_stale = r.timedOut || false;
      }
    } catch (_) { /* ignore */ }

    this._diskUsageCache = sample;
    this._diskUsageCacheAt = now;

    // DISK-03: quota-pressure detection. Open the circuit breaker at
    // 90% of quota; let _maybeExitDiskFull close it at 80% (hysteresis).
    const pct = this._diskUsagePercentOfQuota();
    if (pct !== null && pct >= 90 && !this._diskFull) {
      this._enterDiskFull({
        source: 'quota',
        op: 'sample',
        quota_used_pct: pct,
      });
    } else if (this._diskFull) {
      this._maybeExitDiskFull();
    }

    return sample;
  }

  /**
   * Async recursive directory size with a wall-clock deadline. Returns
   * { bytes, files, timedOut } and never throws. On deadline, returns
   * partial counts and timedOut: true.
   */
  async _dirSizeWithBudget(dir, deadline, excludePaths) {
    const fsP = require('fs').promises;
    let bytes = 0;
    let files = 0;
    const queue = [dir];
    while (queue.length > 0) {
      if (Date.now() > deadline) {
        return { bytes, files, timedOut: true };
      }
      const cur = queue.shift();
      let entries;
      try {
        entries = await fsP.readdir(cur, { withFileTypes: true });
      } catch (_) { continue; }
      for (const ent of entries) {
        if (Date.now() > deadline) {
          return { bytes, files, timedOut: true };
        }
        const p = require('path').join(cur, ent.name);
        if (ent.isDirectory()) {
          if (!(excludePaths && excludePaths.has(p))) queue.push(p);
        } else if (ent.isFile()) {
          try {
            const st = await fsP.stat(p);
            bytes += st.size;
            files++;
          } catch (_) { /* racy unlink */ }
        }
      }
    }
    return { bytes, files, timedOut: false };
  }

  /**
   * DISK-02: opt-in compaction sweep wired from setupAutoSave.
   * Composes UsageReader#compactStale() and a usage-cache refresh.
   */
  async _diskCompactionSweep() {
    if (!this.usageReader || typeof this.usageReader.compactStale !== 'function') return;
    const result = await this.usageReader.compactStale();
    if (result && (result.compacted.length > 0 || result.errors.length > 0)) {
      console.log('[disk-compact]', JSON.stringify({
        scanned: result.scanned,
        compacted_count: result.compacted.length,
        compacted_bytes_in: result.compacted.reduce((s, c) => s + (c.bytesIn || 0), 0),
        compacted_bytes_out: result.compacted.reduce((s, c) => s + (c.bytesOut || 0), 0),
        errors: result.errors.length,
      }));
    }
    // Invalidate disk-usage cache so the next diagnostics tick reports fresh numbers.
    this._diskUsageCacheAt = 0;
    // Refresh in background (non-blocking).
    this._sampleDiskUsage(150).catch(() => {});
  }

  /**
   * DISK-02 (rides along): one-shot startup pruning of stale .crash
   * files. Always-on. Keeps the most recent crash file for inspection.
   */
  async _pruneCrashFilesOnce() {
    if (!this.sessionStore || !this.sessionStore.storageDir) return;
    const UsageReader = require('./usage-reader');
    try {
      const result = await UsageReader.pruneCrashFiles(this.sessionStore.storageDir);
      if (result && result.pruned && result.pruned.length > 0) {
        console.log('[disk-prune-crash]', JSON.stringify({
          pruned_count: result.pruned.length,
          kept_count: result.skipped.length,
        }));
      }
    } catch (_) { /* best effort */ }
  }

  cleanupWebSocketConnection(wsId) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    // Release any sticky-note "expanded viewer" leases this socket held, so a
    // dropped browser can't keep a session's note inference running forever.
    this._clearStickyActiveForWs(wsId);

    // Remove from Claude session if joined
    if (wsInfo.claudeSessionId) {
      const session = this.claudeSessions.get(wsInfo.claudeSessionId);
      if (session) {
        session.connections.delete(wsId);
        session.lastActivity = new Date();
        this._pushEvictionEntry(wsInfo.claudeSessionId); // PROC-04

        // Don't stop Claude if other connections exist
        if (session.connections.size === 0 && this.dev) {
          console.log(`No more connections to session ${wsInfo.claudeSessionId}`);
        }
      }
    }

    // PROC-03 defense-in-depth: explicitly drop the message/close/error
    // listeners attached in handleWebSocketConnection (lines ~2855-2898).
    // Today there is no observed leak — GC reclaims listeners once the
    // Map entry is dropped — but the explicit teardown mirrors the
    // `_ptyDisposables` pattern (base-bridge.js) and `_cleanupFsWatchSession`
    // (this file). Belt-and-suspenders against (a) future delayed callbacks
    // executing post-close, (b) future handler additions that forget
    // teardown, and (c) listener-closure GC pressure under reconnect storms.
    // See docs/audits/proc-ws-listener-cleanup.md.
    try {
      if (wsInfo.ws && typeof wsInfo.ws.removeAllListeners === 'function') {
        wsInfo.ws.removeAllListeners();
      }
    } catch (_) { /* cleanup must never throw — runs from inside ws.on('close')/('error') */ }

    this.webSocketConnections.delete(wsId);
  }

  // ── VS Code Tunnel Handlers ────────────────────────────────

  async handleStartVSCodeTunnel(wsId, data) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;
    if (!wsInfo.claudeSessionId) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'vscode_tunnel_error',
        message: 'Join a session first before starting a VS Code tunnel.',
      });
      return;
    }

    const sessionId = wsInfo.claudeSessionId;
    const session = this.claudeSessions.get(sessionId);
    if (!session) return;

    const workingDir = session.workingDir || this.selectedWorkingDir || this.baseFolder;
    const result = await this.vscodeTunnel.start(sessionId, workingDir);

    if (!result.success) {
      this.broadcastToSession(sessionId, {
        type: 'vscode_tunnel_error',
        error: result.error,
        message: result.message || result.error,
        ...(result.install ? { install: result.install } : {}),
      });
    }
    // Success events are emitted via onEvent callback → handleVSCodeTunnelEvent
  }

  async handleStopVSCodeTunnel(wsId, data) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) return;

    const sessionId = data.sessionId || wsInfo.claudeSessionId;
    await this.vscodeTunnel.stop(sessionId);
  }

  async handleVSCodeTunnelStatus(wsId) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) return;

    const status = this.vscodeTunnel.getStatus(wsInfo.claudeSessionId);
    this.sendToWebSocket(wsInfo.ws, {
      type: 'vscode_tunnel_status',
      ...status,
    });
  }

  /**
   * Callback from VSCodeTunnelManager — forward events to the session's connections.
   */
  handleVSCodeTunnelEvent(sessionId, event) {
    this.broadcastToSession(sessionId, event);
  }

  async close() {
    // Save sessions before closing. Guarded so a save error can't abort close()
    // before the teardown below (incl. the keep-awake release at the end) runs;
    // handleShutdown already persisted sessions on the signal path, and wraps
    // its own save the same way.
    try { await this.saveSessionsToDisk(true); } catch (_) { /* ignore */ }

    // Tear down the STT (sherpa-onnx) native worker. close() is the cleanup path
    // shared by the signal handler (handleShutdown -> close) AND direct close()
    // callers (e.g. the e2e test servers, which construct a ClaudeCodeWebServer
    // and call server.close()). Without this, a server that has loaded the STT
    // model leaks its worker thread past close() and keeps the process alive —
    // this hung the Windows e2e jobs once the model was cached/present. The
    // shutdown is cooperative (graceful message, no terminate()) so native
    // teardown can't abort the process, and idempotent (handleShutdown already
    // ran it on the signal path, so this is then a no-op). The sticky-note engine
    // is torn down by handleShutdown only: it is disabled in the e2e test
    // servers, and its teardown must precede close()'s session-output flush to
    // avoid re-triggering a summary, so it stays out of this shared path.
    try { await this.sttEngine.shutdown(); } catch (_) { /* ignore */ }

    // Clear all intervals
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    if (this.imageSweepInterval) {
      clearInterval(this.imageSweepInterval);
    }
    if (this.sessionEvictionInterval) {
      clearInterval(this.sessionEvictionInterval);
    }
    if (this.diagnosticsHeartbeatInterval) {
      clearInterval(this.diagnosticsHeartbeatInterval);
    }
    if (this.diskCompactInterval) {
      clearInterval(this.diskCompactInterval);
    }
    if (this._stickyJsonlPoll) {
      clearInterval(this._stickyJsonlPoll);
      this._stickyJsonlPoll = null;
    }
    if (this.diskUsageSampleInterval) {
      clearInterval(this.diskUsageSampleInterval);
    }

    // Stop memory monitoring to release the interval timer
    if (this.restartManager) {
      this.restartManager.stopMemoryMonitoring();
    }

    // Stop all VS Code tunnels
    try { await this.vscodeTunnel.stopAll(); } catch (_) { /* ignore */ }

    // Clean up temp images for all sessions
    for (const [, session] of this.claudeSessions) {
      this.cleanupSessionImages(session);
    }

    // Sweep stale generic-drop attachments across every known session
    // (file-browser.md §"Generic file drop" lifecycle). 24 h cutoff —
    // drops files left behind by previous sessions while preserving
    // anything the user just added before the shutdown.
    for (const [, session] of this.claudeSessions) {
      try { this._sweepAttachments(session.workingDir); } catch (_) { /* ignore */ }
    }

    if (this.wss) {
      // Terminate existing WebSocket clients so server.close() callback fires promptly
      // (wss.close() alone only stops new connections; open clients keep the HTTP server alive)
      for (const client of this.wss.clients) {
        try { client.terminate(); } catch (_) { /* ignore */ }
      }
      this.wss.close();
    }
    if (this.server) {
      this.server.close();
    }
    // In HTTPS mode `this.server` is the TLS-sniffing proxy that owns the
    // listening port; the TLS app server and the http->https redirect server sit
    // behind it. Sockets are handed to them via emit('connection'), bypassing
    // their internal connection tracking, so destroy the proxied sockets here
    // (and close the inner servers) to avoid keep-alive connections lingering.
    if (this._proxySockets) {
      for (const s of this._proxySockets) {
        try { s.destroy(); } catch (_) { /* ignore */ }
      }
      this._proxySockets.clear();
    }
    if (this._tlsServer) {
      try { this._tlsServer.close(); } catch (_) { /* ignore */ }
    }
    if (this._httpRedirectServer) {
      try { this._httpRedirectServer.close(); } catch (_) { /* ignore */ }
    }

    // Flush pending output and stop all sessions with a 5-second timeout
    const stopPromises = [];
    for (const [sessionId, session] of this.claudeSessions.entries()) {
      this._flushAndClearOutputTimer(session, sessionId);
      if (session.active) {
        const bridge = this.getBridgeForAgent(session.agent);
        if (bridge) {
          stopPromises.push(bridge.stopSession(sessionId));
        }
      }
    }
    const timeout = new Promise(resolve => setTimeout(resolve, 5000));
    await Promise.race([Promise.allSettled(stopPromises), timeout]);

    // Tear down every live fs-watch SSE (chokidar watcher + TCP conn +
    // per-IP counter). The Map is keyed by sessionId, so we snapshot the
    // keys before iterating — _cleanupFsWatchSession mutates the Map.
    if (this._fsWatchSessions) {
      for (const sid of Array.from(this._fsWatchSessions.keys())) {
        this._cleanupFsWatchSession(sid, 'server_close');
      }
    }

    // Release the Windows keep-awake assertion LAST. Held through the session
    // save + native-engine teardown above so an already-idle laptop cannot
    // sleep mid-flush (the exact data-loss window this feature prevents).
    // Idempotent and a no-op when keepalive was never started (non-win32 /
    // disabled / under test). The process.once('exit') hook + the force-exit
    // timer cover any path that skips close().
    try { this.keepaliveManager.releaseSync(); } catch (_) { /* ignore */ }

    // Clear all data
    this.claudeSessions.clear();
    this.webSocketConnections.clear();
  }

  async handleGetUsage(wsInfo) {
    try {
      // Get usage stats for the current Claude session window
      const currentSessionStats = await this.usageReader.getCurrentSessionStats();
      
      // Get burn rate calculations
      const burnRateData = await this.usageReader.calculateBurnRate(60);
      
      // Get overlapping sessions
      const overlappingSessions = await this.usageReader.detectOverlappingSessions();
      
      // Get 24h stats for additional context
      const dailyStats = await this.usageReader.getUsageStats(24);
      
      // Update analytics with current session data
      if (currentSessionStats && currentSessionStats.sessionStartTime) {
        // Start tracking this session in analytics
        this.usageAnalytics.startSession(
          currentSessionStats.sessionId,
          new Date(currentSessionStats.sessionStartTime)
        );
        
        // Add usage data to analytics
        if (currentSessionStats.totalTokens > 0) {
          this.usageAnalytics.addUsageData({
            tokens: currentSessionStats.totalTokens,
            inputTokens: currentSessionStats.inputTokens,
            outputTokens: currentSessionStats.outputTokens,
            cacheCreationTokens: currentSessionStats.cacheCreationTokens,
            cacheReadTokens: currentSessionStats.cacheReadTokens,
            cost: currentSessionStats.totalCost,
            model: Object.keys(currentSessionStats.models)[0] || 'unknown',
            sessionId: currentSessionStats.sessionId
          });
        }
      }
      
      // Get comprehensive analytics
      const analytics = this.usageAnalytics.getAnalytics();
      
      // Calculate session timer if we have a current session
      let sessionTimer = null;
      if (currentSessionStats && currentSessionStats.sessionStartTime) {
        // Session starts at the hour, not the exact minute
        const startTime = new Date(currentSessionStats.sessionStartTime);
        const now = new Date();
        const elapsedMs = now - startTime;
        
        // Calculate remaining time in session window (5 hours from first message)
        const sessionDurationMs = this.sessionDurationHours * 60 * 60 * 1000;
        const remainingMs = Math.max(0, sessionDurationMs - elapsedMs);
        
        const hours = Math.floor(elapsedMs / (1000 * 60 * 60));
        const minutes = Math.floor((elapsedMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((elapsedMs % (1000 * 60)) / 1000);
        
        const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
        const remainingMinutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
        
        sessionTimer = {
          startTime: currentSessionStats.sessionStartTime,
          elapsed: elapsedMs,
          remaining: remainingMs,
          formatted: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
          remainingFormatted: `${String(remainingHours).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}`,
          hours,
          minutes,
          seconds,
          remainingMs,
          sessionDurationHours: this.sessionDurationHours,
          sessionNumber: currentSessionStats.sessionNumber || 1, // Add session number
          isExpired: remainingMs === 0,
          burnRate: burnRateData.rate,
          burnRateConfidence: burnRateData.confidence,
          depletionTime: analytics.predictions.depletionTime,
          depletionConfidence: analytics.predictions.confidence
        };
      }
      
      this.sendToWebSocket(wsInfo.ws, {
        type: 'usage_update',
        sessionStats: currentSessionStats || {
          requests: 0,
          totalTokens: 0,
          totalCost: 0,
          message: 'No active Claude session'
        },
        dailyStats: dailyStats,
        sessionTimer: sessionTimer,
        analytics: analytics,
        burnRate: burnRateData,
        overlappingSessions: overlappingSessions.length,
        plan: this.usageAnalytics.currentPlan,
        limits: this.usageAnalytics.planLimits[this.usageAnalytics.currentPlan]
      });
      
    } catch (error) {
      console.error('Error getting usage stats:', error);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Failed to retrieve usage statistics'
      });
    }
  }

  async handleImageUpload(wsId, data) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    if (!wsInfo.claudeSessionId) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'image_upload_error',
        message: 'No session joined'
      });
      return;
    }

    const session = this.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'image_upload_error',
        message: 'Session not found'
      });
      return;
    }

    try {
      const result = await this._persistImageUpload(session, data);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'image_upload_complete',
        filePath: result.filePath,
        mimeType: data.mimeType,
        size: result.size
      });
    } catch (error) {
      if (!error.userMessage) console.error('Image upload error:', error);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'image_upload_error',
        message: error.userMessage || ('Failed to save image: ' + error.message)
      });
    }
  }

  // Shared image-persist core used by BOTH the WS image_upload path and the
  // HTTP POST /api/images/upload path. Images go over HTTP so a real photo's
  // base64 (up to ~5.5 MB) does not blow past the 1 MiB WS JSON guard
  // (MAX_WS_MESSAGE_BYTES), which would force-close the socket with 1009.
  // Throws an Error carrying `.status` (HTTP) + `.userMessage` on failure.
  async _persistImageUpload(session, data) {
    const fail = (status, userMessage) => {
      const e = new Error(userMessage); e.status = status; e.userMessage = userMessage; return e;
    };
    // Rate limit: max 5 image uploads per minute per session
    if (!session._imageUploadTimestamps) session._imageUploadTimestamps = [];
    const now = Date.now();
    session._imageUploadTimestamps = session._imageUploadTimestamps.filter(ts => now - ts < 60000);
    if (session._imageUploadTimestamps.length >= 5) {
      throw fail(429, 'Rate limit exceeded: maximum 5 image uploads per minute.');
    }
    session._imageUploadTimestamps.push(now);

    // FIFO cap: max 1000 temp images per session
    if (!session.tempImages) session.tempImages = [];
    while (session.tempImages.length >= 1000) {
      let oldestIdx = 0;
      for (let i = 1; i < session.tempImages.length; i++) {
        if (session.tempImages[i].created < session.tempImages[oldestIdx].created) oldestIdx = i;
      }
      const oldest = session.tempImages[oldestIdx];
      try { fs.unlinkSync(oldest.path); } catch { /* ignore */ }
      session.tempImages.splice(oldestIdx, 1);
    }

    // Validate base64 data, size, and MIME type
    if (!data.base64 || typeof data.base64 !== 'string') throw fail(400, 'Missing image data');
    if (data.base64.length > 5.5 * 1024 * 1024) throw fail(413, 'Image too large (max 4MB file size)');
    const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!allowedMimeTypes.includes(data.mimeType)) {
      throw fail(415, 'Unsupported image format. Allowed: PNG, JPEG, GIF, WebP');
    }

    const filePath = await this.saveImageToTemp(session, data);
    return { filePath, size: Buffer.byteLength(data.base64, 'base64') };
  }

  // Thin shim for the legacy base64-JSON voice_upload path. The 'Missing audio
  // data' guard must live HERE (the binary path has no data.audio); after the
  // binary-frame switch no live client emits this, but it is kept for
  // back-compat and shares the validation/transcribe core below.
  async handleVoiceUpload(wsId, data) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    if (!data.audio || typeof data.audio !== 'string') {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_transcription_error',
        message: 'Missing audio data'
      });
      return;
    }

    await this._processVoicePcm(wsId, Buffer.from(data.audio, 'base64'));
  }

  // Binary voice frame path. The ws dispatcher has already validated the 6-byte
  // header and sliced it off, so `pcmBuffer` is raw 16-bit PCM.
  async handleVoiceBinary(wsId, pcmBuffer) {
    await this._processVoicePcm(wsId, pcmBuffer);
  }

  // Shared voice core for both the base64 shim and the binary path. Check order
  // is cheapest/most-restrictive first; the rate limit stays BEFORE the isReady
  // gate (so it is enforced even when STT is unavailable), and the int16->float32
  // conversion is deferred to the STT worker (transcribePcm16) rather than run on
  // the event loop here.
  async _processVoicePcm(wsId, pcmBuffer) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    // Reject voice uploads over HTTP from non-localhost origins (defense-in-depth)
    if (!wsInfo.secure && !this._isLocalhostConnection(wsInfo.ws)) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_transcription_error',
        message: 'Voice input requires a secure connection (HTTPS). Restart with --https or --tunnel.'
      });
      return;
    }

    if (!wsInfo.claudeSessionId) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_transcription_error',
        message: 'No session joined'
      });
      return;
    }

    const session = this.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_transcription_error',
        message: 'Session not found'
      });
      return;
    }

    if (!session.active || !session.agent) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_transcription_error',
        message: 'No agent is running. Start an agent first.'
      });
      return;
    }

    // Rate limit: max 10 voice uploads per minute per session. State lives on the
    // session object (mirrors image uploads at saveImageToTemp) so it shares the
    // session's lifetime — GC'd on session delete/evict, and correctly survives a
    // WS reconnect (the budget must NOT reset when the socket drops).
    const now = Date.now();
    if (!session._voiceUploadTimestamps) session._voiceUploadTimestamps = [];
    session._voiceUploadTimestamps = session._voiceUploadTimestamps.filter(ts => now - ts < 60000);
    if (session._voiceUploadTimestamps.length >= 10) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_transcription_error',
        message: 'Rate limit exceeded: maximum 10 voice uploads per minute.'
      });
      return;
    }
    session._voiceUploadTimestamps.push(now);

    if (!this.sttEngine.isReady()) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_transcription_error',
        message: `Speech-to-text not ready (status: ${this.sttEngine.getStatus()})`
      });
      return;
    }

    try {
      // Max 120s of 16kHz 16-bit mono PCM = 3,840,000 bytes
      if (pcmBuffer.length > MAX_VOICE_PCM_BYTES) {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'voice_transcription_error',
          message: 'Audio too long (max 120 seconds)'
        });
        return;
      }

      if (pcmBuffer.length < 2) {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'voice_transcription_error',
          message: 'Audio too short'
        });
        return;
      }

      if (pcmBuffer.length % 2 !== 0) {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'voice_transcription_error',
          message: 'Invalid audio data: buffer length must be even (16-bit PCM samples)'
        });
        return;
      }

      // Raw int16 PCM -> the worker converts to Float32 off the event loop.
      const text = await this.sttEngine.transcribePcm16(pcmBuffer);

      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_transcription',
        text
      });
    } catch (error) {
      if (this.dev) console.error('Voice upload error:', error);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_transcription_error',
        message: error.message || 'Transcription failed'
      });
    }
  }

  /**
   * Idempotent, non-blocking init of the LOCAL STT model. Downloads + loads in
   * the worker thread (off the event loop), broadcasting progress + the final
   * status so every client can enable the mic the moment the model is `ready`.
   * Called on startup (pull-on-boot) and by the explicit voice_download_model
   * retry. Self-gates: a disabled / under-test engine no-ops (initialize returns
   * `unavailable` without downloading). An external endpoint inits cheaply.
   */
  _ensureSttModel() {
    const status = this.sttEngine.getStatus();
    if (status === 'ready' || status === 'downloading' || status === 'loading') return;
    this.sttEngine
      .initialize((progress) => {
        // Guard the percent math: a malformed/early progress event (fileCount 0,
        // missing fileIndex) must not emit NaN/Infinity (serialized as null),
        // which would break the client's 100%-based banner transitions.
        const fileCount = progress.fileCount > 0 ? progress.fileCount : 1;
        const fileIndex = Number.isFinite(progress.fileIndex) ? progress.fileIndex : 0;
        const fileProgress = progress.total > 0 ? progress.downloaded / progress.total : 0;
        let percent = Math.round(((fileIndex + fileProgress) / fileCount) * 100);
        if (!Number.isFinite(percent)) percent = 0;
        percent = Math.max(0, Math.min(100, percent));
        this.broadcastAll({ type: 'voice_model_progress', ...progress, percent });
      })
      .then(() => this._broadcastVoiceStatus())
      .catch((err) => {
        if (this.dev) console.error('[STT] Init failed:', err.message);
        this._broadcastVoiceStatus(err.message);
      });
  }

  /** Broadcast the current STT status so clients can enable/disable the mic. */
  _broadcastVoiceStatus(error) {
    const localStatus = this.sttEngine.getStatus();
    this.broadcastAll({
      type: 'voice_status',
      status: localStatus,
      voiceInput: {
        localStatus,
        localEnabled: !!(this.sttEngine._enabled && !this.sttEngine._sttEndpoint),
        cloudAvailable: true,
      },
      progress: this.sttEngine.getDownloadProgress(),
      ...(error ? { error } : {}),
    });
  }

  async handleVoiceDownloadModel(wsId) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    // Kick off (or no-op if already in flight / ready) the shared background init.
    this._ensureSttModel();

    // Immediate per-socket ack with the current status + progress.
    const localStatus = this.sttEngine.getStatus();
    this.sendToWebSocket(wsInfo.ws, {
      type: 'voice_status',
      status: localStatus,
      voiceInput: {
        localStatus,
        localEnabled: !!(this.sttEngine._enabled && !this.sttEngine._sttEndpoint),
        cloudAvailable: true,
      },
      progress: this.sttEngine.getDownloadProgress(),
    });
  }

  broadcastAll(data) {
    for (const [, wsInfo] of this.webSocketConnections) {
      if (wsInfo.ws.readyState === WebSocket.OPEN) {
        this.sendToWebSocket(wsInfo.ws, data);
      }
    }
  }

  async saveImageToTemp(session, data) {
    // Primary temp dir: .claude-images inside the session working directory
    let tempDir = path.join(session.workingDir, '.claude-images');
    try {
      fs.mkdirSync(tempDir, { recursive: true });
    } catch {
      // Fallback to OS temp directory
      tempDir = path.join(os.tmpdir(), 'claude-web-images', session.id);
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Verify resolved path doesn't escape via symlinks
    const resolvedTempDir = fs.realpathSync(tempDir);
    if (resolvedTempDir !== tempDir && !resolvedTempDir.startsWith(session.workingDir) && !resolvedTempDir.startsWith(os.tmpdir())) {
      throw new Error('Temp directory resolved to unexpected location');
    }

    // Auto-create .gitignore in tempDir
    const gitignorePath = path.join(tempDir, '.gitignore');
    try {
      await fs.promises.access(gitignorePath);
    } catch {
      await fs.promises.writeFile(gitignorePath, '*\n');
    }

    // Generate unique filename
    const ext = this.mimeToExtension(data.mimeType);
    const filename = `img-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const filePath = path.join(tempDir, filename);

    // Write the image file
    await fs.promises.writeFile(filePath, Buffer.from(data.base64, 'base64'));

    // Track the temp image
    if (!session.tempImages) {
      session.tempImages = [];
    }
    session.tempImages.push({
      path: filePath,
      size: Buffer.byteLength(data.base64, 'base64'),
      created: Date.now()
    });

    return filePath;
  }

  mimeToExtension(mimeType) {
    const map = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp'
    };
    return map[mimeType] || null;
  }

  cleanupSessionImages(session) {
    if (!session.tempImages || session.tempImages.length === 0) return;
    for (const img of session.tempImages) {
      try {
        if (fs.existsSync(img.path)) fs.unlinkSync(img.path);
      } catch { /* ignore */ }
    }
    session.tempImages = [];
    // Try to remove the .claude-images dir if empty
    const tempDir = path.join(session.workingDir, '.claude-images');
    try {
      const remaining = fs.readdirSync(tempDir);
      // Only remove if just .gitignore remains or empty
      if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === '.gitignore')) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }

  sweepOldTempImages() {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    for (const [, session] of this.claudeSessions) {
      if (!session.tempImages || session.tempImages.length === 0) continue;
      session.tempImages = session.tempImages.filter(img => {
        if (now - img.created > maxAge) {
          try { if (fs.existsSync(img.path)) fs.unlinkSync(img.path); } catch { /* ignore */ }
          return false;
        }
        return true;
      });
    }
  }

}

async function startServer(options) {
  const server = new ClaudeCodeWebServer(options);
  return await server.start();
}

module.exports = { startServer, ClaudeCodeWebServer };
