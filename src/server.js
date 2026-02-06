const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const ClaudeBridge = require('./claude-bridge');
const CodexBridge = require('./codex-bridge');
const CopilotBridge = require('./copilot-bridge');
const GeminiBridge = require('./gemini-bridge');
const TerminalBridge = require('./terminal-bridge');
const SessionStore = require('./utils/session-store');
const UsageReader = require('./usage-reader');
const UsageAnalytics = require('./usage-analytics');

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
    this.sessionStore = new SessionStore();
    this.usageReader = new UsageReader(this.sessionDurationHours);
    this.usageAnalytics = new UsageAnalytics({
      sessionDurationHours: this.sessionDurationHours,
      plan: options.plan || process.env.CLAUDE_PLAN || 'max20',
      customCostLimit: parseFloat(process.env.CLAUDE_COST_LIMIT || options.customCostLimit || 50.00)
    });
    this.autoSaveInterval = null;
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
    this.loadPersistedSessions();
    this.setupAutoSave();
  }
  
  async loadPersistedSessions() {
    try {
      const sessions = await this.sessionStore.loadSessions();
      this.claudeSessions = sessions;
      if (sessions.size > 0) {
        console.log(`Loaded ${sessions.size} persisted sessions`);
      }
    } catch (error) {
      console.error('Failed to load persisted sessions:', error);
    }
  }
  
  setupAutoSave() {
    // Auto-save sessions every 30 seconds
    this.autoSaveInterval = setInterval(() => {
      this.saveSessionsToDisk();
    }, 30000);
    
    // Also save on process exit
    process.on('SIGINT', () => this.handleShutdown());
    process.on('SIGTERM', () => this.handleShutdown());
    process.on('beforeExit', () => this.saveSessionsToDisk());
  }
  
  async saveSessionsToDisk() {
    if (this.claudeSessions.size > 0) {
      await this.sessionStore.saveSessions(this.claudeSessions);
    }
  }
  
  async handleShutdown() {
    // Prevent multiple shutdown attempts
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    console.log('\nGracefully shutting down...');
    await this.saveSessionsToDisk();
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    this.close();
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
    
    return { valid: true, path: resolvedPath };
  }

  setupExpress() {
    this.app.use(cors());
    this.app.use(express.json());
    
    // Serve manifest.json with correct MIME type
    this.app.get('/manifest.json', (req, res) => {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
    });
    
    this.app.use(express.static(path.join(__dirname, 'public')));

    // PWA Icon routes - generate Cortex brain/terminal icon dynamically
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
        outputBuffer: [],
        maxBufferSize: 1000
      };
      
      this.claudeSessions.set(sessionId, session);
      
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
    this.app.delete('/api/sessions/:sessionId', (req, res) => {
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
      
      // Disconnect all WebSocket connections for this session
      session.connections.forEach(wsId => {
        const wsInfo = this.webSocketConnections.get(wsId);
        if (wsInfo && wsInfo.ws.readyState === WebSocket.OPEN) {
          wsInfo.ws.send(JSON.stringify({ 
            type: 'session_deleted',
            message: 'Session has been deleted'
          }));
          wsInfo.ws.close();
        }
      });
      
      this.claudeSessions.delete(sessionId);
      
      // Save sessions after deletion
      this.saveSessionsToDisk();
      
      res.json({ success: true, message: 'Session deleted' });
    });

    this.app.get('/api/config', (req, res) => {
      res.json({
        folderMode: this.folderMode,
        selectedWorkingDir: this.selectedWorkingDir,
        baseFolder: this.baseFolder,
        aliases: this.aliases,
        tools: {
          claude: { alias: this.aliases.claude, available: this.claudeBridge.isAvailable(), hasDangerousMode: true },
          codex: { alias: this.aliases.codex, available: this.codexBridge.isAvailable(), hasDangerousMode: true },
          copilot: { alias: this.aliases.copilot, available: this.copilotBridge.isAvailable(), hasDangerousMode: false },
          gemini: { alias: this.aliases.gemini, available: this.geminiBridge.isAvailable(), hasDangerousMode: false },
          terminal: { alias: this.aliases.terminal, available: this.terminalBridge.isAvailable(), hasDangerousMode: false }
        }
      });
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
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
  }

  async start() {
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

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        await this.handleMessage(wsId, data);
      } catch (error) {
        if (this.dev) {
          console.error('Error handling message:', error);
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
        await this.startToolSession(wsId, 'claude', this.claudeBridge, data.options || {});
        break;
      case 'start_codex':
        await this.startToolSession(wsId, 'codex', this.codexBridge, data.options || {});
        break;
      case 'start_copilot':
        await this.startToolSession(wsId, 'copilot', this.copilotBridge, data.options || {});
        break;
      case 'start_gemini':
        await this.startToolSession(wsId, 'gemini', this.geminiBridge, data.options || {});
        break;
      case 'start_terminal':
        await this.startToolSession(wsId, 'terminal', this.terminalBridge, data.options || {});
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
                  await inputBridge.sendInput(wsInfo.claudeSessionId, data.data);
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
          await this.stopToolSession(wsInfo.claudeSessionId);
        }
        break;

      case 'ping':
        this.sendToWebSocket(wsInfo.ws, { type: 'pong' });
        break;

      case 'get_usage':
        this.handleGetUsage(wsInfo);
        break;

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
      outputBuffer: [],
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

    const session = this.claudeSessions.get(wsInfo.claudeSessionId);
    if (session) {
      session.connections.delete(wsId);
      session.lastActivity = new Date();
    }

    wsInfo.claudeSessionId = null;
    
    this.sendToWebSocket(wsInfo.ws, {
      type: 'session_left'
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

  async startToolSession(wsId, toolName, bridge, options) {
    const wsInfo = this.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'No session joined'
      });
      return;
    }

    const session = this.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session) return;

    if (session.active) {
      this.sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'An agent is already running in this session'
      });
      return;
    }

    const sessionId = wsInfo.claudeSessionId;
    try {
      await bridge.startSession(sessionId, {
        workingDir: session.workingDir,
        onOutput: (data) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (!currentSession) return;
          currentSession.outputBuffer.push(data);
          if (currentSession.outputBuffer.length > currentSession.maxBufferSize) {
            currentSession.outputBuffer.shift();
          }
          this.broadcastToSession(sessionId, { type: 'output', data });
        },
        onExit: (code, signal) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (currentSession) {
            currentSession.active = false;
            currentSession.agent = null;
          }
          this.broadcastToSession(sessionId, { type: 'exit', code, signal });
        },
        onError: (error) => {
          const currentSession = this.claudeSessions.get(sessionId);
          if (currentSession) {
            currentSession.active = false;
            currentSession.agent = null;
          }
          this.broadcastToSession(sessionId, { type: 'error', message: error.message });
        },
        ...options
      });

      session.active = true;
      session.agent = toolName;
      session.lastActivity = new Date();
      if (!session.sessionStartTime) {
        session.sessionStartTime = new Date();
      }

      this.broadcastToSession(sessionId, {
        type: `${toolName}_started`,
        sessionId: sessionId
      });

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

    const bridge = this.getBridgeForAgent(session.agent);
    if (bridge) {
      await bridge.stopSession(sessionId);
    }

    const agentType = session.agent;
    session.active = false;
    session.agent = null;
    session.lastActivity = new Date();
    this.broadcastToSession(sessionId, { type: `${agentType}_stopped` });
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

  close() {
    // Save sessions before closing
    this.saveSessionsToDisk();
    
    // Clear auto-save interval
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    
    if (this.wss) {
      this.wss.close();
    }
    if (this.server) {
      this.server.close();
    }
    
    // Stop all sessions
    for (const [sessionId, session] of this.claudeSessions.entries()) {
      if (session.active) {
        const bridge = this.getBridgeForAgent(session.agent);
        if (bridge) {
          bridge.stopSession(sessionId);
        }
      }
    }
    
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

}

async function startServer(options) {
  const server = new ClaudeCodeWebServer(options);
  return await server.start();
}

module.exports = { startServer, ClaudeCodeWebServer };
