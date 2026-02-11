const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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
    this.baseFolder = process.cwd(); // The folder where the app runs from
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
    this.sessionStore = new SessionStore();
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
        fs.writeFileSync(this.sessionStore.sessionsFile + '.crash', data);
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
  
  setTunnelManager(tm) {
    this.tunnelManager = tm;
  }

  async saveSessionsToDisk(force = false) {
    if (force) {
      this.sessionStore.markDirty();
    }
    await this.sessionStore.saveSessions(this.claudeSessions);
  }

  async handleShutdown() {
    // Prevent multiple shutdown attempts
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    console.log('\nGracefully shutting down...');
    await this.saveSessionsToDisk(true);
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    if (this.sessionEvictionInterval) {
      clearInterval(this.sessionEvictionInterval);
    }
    // Stop all VS Code tunnels
    await this.vscodeTunnel.stopAll();
    // Clean up temp images for all sessions
    for (const [, session] of this.claudeSessions) {
      this.cleanupSessionImages(session);
    }
    await this.close();
    process.exit(0);
  }

  isPathWithinBase(targetPath) {
    try {
      const resolvedTarget = path.resolve(targetPath);
      const resolvedBase = path.resolve(this.baseFolder);
      return resolvedTarget.startsWith(resolvedBase);
    } catch (error) {
      return false;
    }
  }

  validatePath(targetPath) {
    if (!targetPath) {
      return { valid: false, error: 'Path is required' };
    }

    const resolvedPath = path.resolve(targetPath);

    if (!this.isPathWithinBase(resolvedPath)) {
      return {
        valid: false,
        error: 'Access denied: Path is outside the allowed directory'
      };
    }

    // Resolve symlinks to prevent TOCTOU attacks
    try {
      if (fs.existsSync(resolvedPath)) {
        const realPath = fs.realpathSync(resolvedPath);
        if (!this.isPathWithinBase(realPath)) {
          return { valid: false, error: 'Access denied: symlink escapes allowed directory' };
        }
        return { valid: true, path: realPath };
      }
    } catch (e) { /* If realpath fails, fall through to using resolved path */ }

    return { valid: true, path: resolvedPath };
  }

  setupExpress() {
    this.app.use(cors());
    this.app.use(express.json());
    
    // Serve manifest.json with correct MIME type
    this.app.get('/manifest.json', (req, res) => {
      res.setHeader('Content-Type', 'application/manifest+json');
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

    // PUT /api/files/content — Save edited file with hash conflict detection
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

    // POST /api/files/upload — Upload file (base64 JSON, route-specific limit)
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

        await fs.promises.writeFile(targetPath, buffer);
        const stat = await fs.promises.stat(targetPath);

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

    // Non-blocking STT init — downloads model if needed
    if (this.sttEngine._enabled || this.sttEngine._sttEndpoint) {
      this.sttEngine.initialize().catch(err => {
        if (this.dev) console.error('[STT] Init failed:', err.message);
      });
    }

    let server;

    if (this.useHttps) {
      if (!this.certFile || !this.keyFile) {
        throw new Error('HTTPS requires both --cert and --key options');
      }
      
      const cert = fs.readFileSync(this.certFile);
      const key = fs.readFileSync(this.keyFile);
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
      created: new Date()
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

    // Leave current session if any
    if (wsInfo.claudeSessionId) {
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

    if (session.active) {
      console.warn(`startToolSession(${toolName}): session ${wsInfo.claudeSessionId} already has agent '${session.agent}' running`);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'An agent is already running in this session'
      });
      return;
    }

    const sessionId = wsInfo.claudeSessionId;

    if (!bridge.isAvailable()) {
      console.warn(`startToolSession(${toolName}): bridge reports tool not available`);
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `${toolName} is not available. Please ensure the ${toolName} CLI is installed and accessible on your PATH.`
      });
      return;
    }

    try {
      console.log(`startToolSession(${toolName}): spawning in session ${sessionId}, workingDir=${session.workingDir}`);
      await bridge.startSession(sessionId, {
        workingDir: session.workingDir,
        cols: cols || 80,
        rows: rows || 24,
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
          this.broadcastToSession(sessionId, { type: 'error', message: error.message });
          this.broadcastSessionActivity(sessionId, 'session_error');
        },
        ...options
      });

      session.active = true;
      session.agent = toolName;
      session.lastActivity = new Date();
      if (!session.sessionStartTime) {
        session.sessionStartTime = new Date();
      }
      this.sessionStore.markDirty();

      this.broadcastToSession(sessionId, {
        type: `${toolName}_started`,
        sessionId: sessionId
      });
      this.broadcastSessionActivity(sessionId, 'session_started', { agent: toolName });

    } catch (error) {
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

    // Clear auto-save interval
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    if (this.imageSweepInterval) {
      clearInterval(this.imageSweepInterval);
    }
    if (this.sessionEvictionInterval) {
      clearInterval(this.sessionEvictionInterval);
    }

    if (this.wss) {
      this.wss.close();
    }
    if (this.server) {
      this.server.close();
    }
    
    // Flush pending output and stop all sessions, awaiting clean shutdown
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
    await Promise.allSettled(stopPromises);

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

      // All validation passed — count the request for rate limiting
      recent.push(now);

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
