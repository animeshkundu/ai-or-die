const express = require('express');
const http = require('http');
const https = require('https');
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
const CircularBuffer = require('./utils/circular-buffer');
const RestartManager = require('./restart-manager');

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
    // Session duration in hours (default to 5 hours from first message)
    this.sessionDurationHours = parseFloat(process.env.CLAUDE_SESSION_HOURS || options.sessionHours || 5);
    
    this.app = express();
    this.claudeSessions = new Map(); // Persistent sessions (claude, codex, or agent)
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
    this.installAdvisor = new InstallAdvisor();
    this.sttEngine = new SttEngine({
      enabled: options.stt || !!options.sttEndpoint,
      sttEndpoint: options.sttEndpoint,
      modelsDir: options.sttModelDir,
      numThreads: options.sttThreads ? parseInt(options.sttThreads, 10) : undefined,
    });
    this._voiceUploadCounts = new Map();
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
        }
      }
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

    // Evict stale inactive sessions older than 7 days every 5 minutes
    this.sessionEvictionInterval = setInterval(() => {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const [id, session] of this.claudeSessions) {
        if (!session.active && session.connections.size === 0 && new Date(session.lastActivity || session.created).getTime() < sevenDaysAgo) {
          this.claudeSessions.delete(id);
          this.activityBroadcastTimestamps.delete(id);
          this.sessionStore.markDirty();
        }
      }
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
    // If the supervisor crashes, continue running standalone
    process.on('disconnect', () => {
      console.warn('IPC channel disconnected (supervisor may have crashed). Continuing standalone.');
      this.supervised = false;
    });
  }
  
  setTunnelManager(tm) {
    this.tunnelManager = tm;
  }

  async saveSessionsToDisk(force = false) {
    if (force) {
      this.sessionStore.markDirty();
    }
    await this.sessionStore.saveSessions(this.claudeSessions);
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
      process.exit(exitCode);
    }, 15000);
    forceExitTimer.unref();

    console.log(`\nGracefully shutting down (exit code: ${exitCode})...`);
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
      // .native throws ENOENT on non-existent paths (POSIX realpath
      // semantics). Try the laxer JS implementation, which may still
      // resolve the parent.
      try { return fs.realpathSync(resolved); } catch (__) { return resolved; }
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
      const resolvedBase = this._canonicalizePathSync(this.baseFolder);
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
   * Sum of bytes for all top-level files inside an attachments directory.
   * Top-level only — generic drop never creates subdirectories there, and
   * walking deep would let a user-side `ln -s /` symlink balloon the
   * computation. Robust to a missing directory (returns 0).
   */
  _attachmentDirBytes(attachmentsDir) {
    let total = 0;
    let entries;
    try {
      entries = fs.readdirSync(attachmentsDir, { withFileTypes: true });
    } catch (_) {
      return 0; // missing dir → 0 bytes used
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      try {
        const st = fs.statSync(path.join(attachmentsDir, ent.name));
        total += st.size;
      } catch (_) { /* file vanished mid-readdir — skip */ }
    }
    return total;
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
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const fp = path.join(dir, ent.name);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch (_) { /* tolerate races */ }
    }
  }



  setupExpress() {
    this.app.use(cors());
    this.app.use(express.json());
    
    // Serve manifest.json with correct MIME type
    this.app.get('/manifest.json', (req, res) => {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.setHeader('Cache-Control', 'no-cache');
      if (global.__SEA_MODE__) {
        this._sendSeaAsset(res, 'public/manifest.json');
      } else {
        res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
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

    // PWA Icon routes - generate ai-or-die brain/terminal icon dynamically
    const iconSizes = [16, 32, 144, 180, 192, 512];
    iconSizes.forEach(size => {
      this.app.get(`/icon-${size}.png`, (req, res) => {
        const s = size;
        const r = s * 0.1;
        const svg = `
          <svg width="${s}" height="${s}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
            <rect width="100" height="100" fill="#1a1a1a" rx="${r > 1 ? 10 : 0}"/>
            <path d="M50 18 C28 18 18 32 18 48 C18 58 24 66 32 70 L32 74 C32 78 36 80 40 78 L44 76"
                  fill="none" stroke="#ff6b00" stroke-width="3.5" stroke-linecap="round" opacity="0.6"/>
            <path d="M50 18 C72 18 82 32 82 48 C82 58 76 66 68 70 L68 74 C68 78 64 80 60 78 L56 76"
                  fill="none" stroke="#ff6b00" stroke-width="3.5" stroke-linecap="round" opacity="0.6"/>
            <circle cx="38" cy="38" r="3" fill="#ff6b00" opacity="0.5"/>
            <circle cx="62" cy="38" r="3" fill="#ff6b00" opacity="0.5"/>
            <circle cx="50" cy="28" r="2.5" fill="#ff6b00" opacity="0.4"/>
            <text x="50" y="62" text-anchor="middle" dominant-baseline="middle"
                  font-family="'JetBrains Mono',monospace" font-size="28" font-weight="700" fill="#ff6b00">
              &gt;_
            </text>
          </svg>
        `;
        const svgBuffer = Buffer.from(svg);
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.send(svgBuffer);
      });
    });

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
        const token = req.headers.authorization || req.query.token;
        if (token !== `Bearer ${this.auth}` && token !== this.auth) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
      });
    }

    // Commands API removed

    this.app.get('/api/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        claudeSessions: this.claudeSessions.size,
        activeConnections: this.webSocketConnections.size 
      });
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
      
      // Stop running process if active
      if (session.active) {
        const bridge = this.getBridgeForAgent(session.agent);
        if (bridge) {
          bridge.stopSession(sessionId);
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

      this.claudeSessions.delete(sessionId);
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
      const requestedPath = req.query.path || this.baseFolder;
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
            home: normalizePath(this.baseFolder),
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
      // (single-ES-per-session per ADR-0017). The displaced session
      // releases its slot in the per-IP counter so this fresh open
      // doesn't double-count.
      const existing = this._fsWatchSessions.get(sessionId);
      if (existing) {
        try { existing.send && existing.send({ type: 'end', reason: 'replaced' }); } catch (_) {}
        try { existing.cleanup && existing.cleanup('replaced'); } catch (_) {}
        // existing.cleanup already decrements the per-IP counter.
      }

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
      const debounceMs = parseInt(process.env.FS_WATCHER_DEBOUNCE_MS, 10) || 100;
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
      };
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
    this.app.post('/api/files/upload', express.json({ limit: '10mb' }), async (req, res) => {
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

    // Non-blocking STT init — downloads model if needed
    if (this.sttEngine._enabled || this.sttEngine._sttEndpoint) {
      this.sttEngine.initialize().catch(err => {
        if (this.dev) console.error('[STT] Init failed:', err.message);
      });
    }

    let server;

    if (this.useHttps) {
      let cert, key;
      if (this.certFile && this.keyFile) {
        // User-provided certs
        cert = fs.readFileSync(this.certFile);
        key = fs.readFileSync(this.keyFile);
      } else {
        // Auto-generate self-signed cert for LAN use
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
      }
      server = https.createServer({ cert, key }, this.app);
    } else {
      server = http.createServer(this.app);
    }

    this.wss = new WebSocket.Server({
      server,
      maxPayload: 8 * 1024 * 1024,
      // Compression disabled — binary frames already send with compress:false,
      // and JSON control messages are small/infrequent. Saves ~300KB per connection
      // in zlib context allocation and eliminates thread pool contention.
      perMessageDeflate: false,
      verifyClient: (info) => {
        if (!this.noAuth && this.auth) {
          const url = new URL(info.req.url, 'ws://localhost');
          const token = url.searchParams.get('token');
          return token === this.auth;
        }
        return true;
      }
    });

    this.wss.on('connection', (ws, req) => {
      this.handleWebSocketConnection(ws, req);
    });

    return new Promise((resolve, reject) => {
      server.listen(this.port, (err) => {
        if (err) {
          reject(err);
        } else {
          this.server = server;
          resolve(server);
        }
      });
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

    ws.on('message', (message) => {
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
          progress: this.sttEngine.getDownloadProgress(),
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
      maxBufferSize: 1000
    };
    
    this.claudeSessions.set(sessionId, session);
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
    session.lastAccessed = Date.now();

    // Send session info and replay buffer
    this.sendToWebSocket(wsInfo.ws, {
      type: 'session_joined',
      sessionId: claudeSessionId,
      sessionName: session.name,
      workingDir: session.workingDir,
      active: session.active,
      wasActive: session.wasActive || false,
      agent: session.agent || null,
      outputBuffer: session.outputBuffer.slice(-200) // Send last 200 lines
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
    }

    wsInfo.claudeSessionId = null;

    this.sendToWebSocket(wsInfo.ws, {
      type: 'session_left',
      sessionId: leftSessionId
    });
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
          this.sessionStore.markDirty();
          this._throttledOutputBroadcast(sessionId, data);
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
            this.sessionStore.markDirty();
          }
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
        ...options
      });

      session.lastActivity = new Date();
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

  cleanupWebSocketConnection(wsId) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    // Remove from Claude session if joined
    if (wsInfo.claudeSessionId) {
      const session = this.claudeSessions.get(wsInfo.claudeSessionId);
      if (session) {
        session.connections.delete(wsId);
        session.lastActivity = new Date();
        
        // Don't stop Claude if other connections exist
        if (session.connections.size === 0 && this.dev) {
          console.log(`No more connections to session ${wsInfo.claudeSessionId}`);
        }
      }
    }

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
    // Save sessions before closing
    await this.saveSessionsToDisk(true);

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
      // Rate limit: max 5 image uploads per minute per session
      if (!session._imageUploadTimestamps) {
        session._imageUploadTimestamps = [];
      }
      const now = Date.now();
      session._imageUploadTimestamps = session._imageUploadTimestamps.filter(
        ts => now - ts < 60000
      );
      if (session._imageUploadTimestamps.length >= 5) {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'image_upload_error',
          message: 'Rate limit exceeded: maximum 5 image uploads per minute.'
        });
        return;
      }
      session._imageUploadTimestamps.push(now);

      // FIFO cap: max 1000 temp images per session
      if (!session.tempImages) {
        session.tempImages = [];
      }
      while (session.tempImages.length >= 1000) {
        // Remove oldest by created date (O(n) scan instead of sort)
        let oldestIdx = 0;
        for (let i = 1; i < session.tempImages.length; i++) {
          if (session.tempImages[i].created < session.tempImages[oldestIdx].created) oldestIdx = i;
        }
        const oldest = session.tempImages[oldestIdx];
        try { fs.unlinkSync(oldest.path); } catch { /* ignore */ }
        session.tempImages.splice(oldestIdx, 1);
      }

      // Validate base64 data
      if (!data.base64 || typeof data.base64 !== 'string') {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'image_upload_error',
          message: 'Missing image data'
        });
        return;
      }
      if (data.base64.length > 5.5 * 1024 * 1024) {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'image_upload_error',
          message: 'Image too large (max 4MB file size)'
        });
        return;
      }

      // Validate MIME type
      const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      if (!allowedMimeTypes.includes(data.mimeType)) {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'image_upload_error',
          message: 'Unsupported image format. Allowed: PNG, JPEG, GIF, WebP'
        });
        return;
      }

      const filePath = await this.saveImageToTemp(session, data);

      this.sendToWebSocket(wsInfo.ws, {
        type: 'image_upload_complete',
        filePath: filePath,
        mimeType: data.mimeType,
        size: Buffer.byteLength(data.base64, 'base64')
      });
    } catch (error) {
      console.error('Image upload error:', error);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'image_upload_error',
        message: 'Failed to save image: ' + error.message
      });
    }
  }

  async handleVoiceUpload(wsId, data) {
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

    // Rate limit: max 10 voice uploads per minute per session (check early to prevent abuse)
    const sessionId = wsInfo.claudeSessionId;
    if (!this._voiceUploadCounts.has(sessionId)) {
      this._voiceUploadCounts.set(sessionId, []);
    }
    const timestamps = this._voiceUploadCounts.get(sessionId);
    const now = Date.now();
    const recent = timestamps.filter(ts => now - ts < 60000);
    this._voiceUploadCounts.set(sessionId, recent);
    if (recent.length >= 10) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_transcription_error',
        message: 'Rate limit exceeded: maximum 10 voice uploads per minute.'
      });
      return;
    }
    recent.push(now);

    if (!this.sttEngine.isReady()) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_transcription_error',
        message: `Speech-to-text not ready (status: ${this.sttEngine.getStatus()})`
      });
      return;
    }

    try {
      // Validate audio data
      if (!data.audio || typeof data.audio !== 'string') {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'voice_transcription_error',
          message: 'Missing audio data'
        });
        return;
      }

      const audioBuffer = Buffer.from(data.audio, 'base64');

      // Max 120s of 16kHz 16-bit mono PCM = 3,840,000 bytes
      if (audioBuffer.length > 3840000) {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'voice_transcription_error',
          message: 'Audio too long (max 120 seconds)'
        });
        return;
      }

      if (audioBuffer.length < 2) {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'voice_transcription_error',
          message: 'Audio too short'
        });
        return;
      }

      if (audioBuffer.length % 2 !== 0) {
        this.sendToWebSocket(wsInfo.ws, {
          type: 'voice_transcription_error',
          message: 'Invalid audio data: buffer length must be even (16-bit PCM samples)'
        });
        return;
      }


      // Convert Int16 PCM buffer to Float32Array for sherpa-onnx
      const float32 = this._int16ToFloat32(audioBuffer);

      const text = await this.sttEngine.transcribe(float32);

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

  async handleVoiceDownloadModel(wsId) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    const currentStatus = this.sttEngine.getStatus();

    if (currentStatus === 'ready') {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_status',
        status: 'ready',
        progress: null,
      });
      return;
    }

    // Already downloading or loading — return current status instead of re-initializing
    if (currentStatus === 'downloading' || currentStatus === 'loading') {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'voice_status',
        status: currentStatus,
        progress: this.sttEngine.getDownloadProgress(),
      });
      return;
    }

    // Trigger model download/init and broadcast progress with computed percent
    this.sttEngine.initialize((progress) => {
      const fileProgress = progress.total > 0 ? progress.downloaded / progress.total : 0;
      const overallPercent = Math.round(((progress.fileIndex + fileProgress) / progress.fileCount) * 100);
      this.broadcastAll({ type: 'voice_model_progress', ...progress, percent: overallPercent });
    }).then(() => {
      this.broadcastAll({
        type: 'voice_status',
        status: this.sttEngine.getStatus(),
        progress: null,
      });
    }).catch(err => {
      if (this.dev) console.error('[STT] Download failed:', err.message);
      this.broadcastAll({
        type: 'voice_status',
        status: 'unavailable',
        error: err.message,
      });
    });

    this.sendToWebSocket(wsInfo.ws, {
      type: 'voice_status',
      status: this.sttEngine.getStatus(),
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

  _int16ToFloat32(int16Buffer) {
    // Copy to ensure 2-byte alignment (Node.js Buffers may have odd byteOffset)
    const aligned = new Uint8Array(int16Buffer).buffer;
    const int16 = new Int16Array(aligned);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }
    return float32;
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
