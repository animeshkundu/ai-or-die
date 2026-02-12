class ClaudeCodeWebInterface {
    constructor() {
        this.terminal = null;
        this.fitAddon = null;
        this.webLinksAddon = null;
        this.socket = null;
        this.connectionId = null;
        this.currentClaudeSessionId = null;
        this.currentClaudeSessionName = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.folderMode = true; // Always use folder mode
        this.currentFolderPath = null;
        this.claudeSessions = [];
        this.isCreatingNewSession = false;
        this.isMobile = this.detectMobile();
        this.currentMode = 'chat';
        this.planDetector = null;
        this.planModal = null;
        // Aliases for assistants (populated from /api/config)
        this.aliases = { claude: 'Claude', codex: 'Codex' };
        // Available tools (populated from /api/config)
        this.tools = {};
        // Machine hostname (populated from /api/config)
        this.hostname = '';
        
        
        // Initialize the session tab manager
        this.sessionTabManager = null;
        
        // Usage stats
        this.usageStats = null;
        this.usageUpdateTimer = null;
        this.sessionStats = null;
        this.sessionTimer = null;
        this.sessionTimerInterval = null;
        
        this.splitContainer = null;

        // Voice input
        this.voiceController = null;
        this.voiceMode = null;
        this._voiceTimerInterval = null;
        this._voiceTranscriptionTimeout = null;

        // Cached TextDecoder for lazy string decode on hot path
        this._textDecoder = new TextDecoder();

        // Flow control state (xterm.js recommended callback-counting pattern)
        this._pendingCallbacks = 0;
        this._writtenBytes = 0;
        this._CALLBACK_BYTE_LIMIT = 100 * 1024;  // Request callback every 100KB
        this._HIGH_WATER = 5;   // Pending callback count threshold
        this._LOW_WATER = 2;
        this._outputPaused = false;

        // Write coalescing: batch binary frames into a single terminal.write per rAF
        this._pendingWrites = [];
        this._rafPending = false;

        // Input coalescing: batch keystrokes per animation frame, flush on breather
        this._inputBuffer = '';
        this._inputFlushScheduled = false;
        this._INPUT_BUFFER_MAX = 64 * 1024; // 64KB safety cap

        // Deferred plan detection: accumulate binary data, decode after 100ms idle
        this._planDetectChunks = [];
        this._planDetectTimer = null;
        this._planTextDecoder = new TextDecoder();

        this.init();
    }

    // Helper method for authenticated fetch calls
    async authFetch(url, options = {}) {
        const authHeaders = window.authManager.getAuthHeaders();
        const mergedOptions = {
            ...options,
            headers: {
                ...authHeaders,
                ...(options.headers || {})
            }
        };
        const response = await fetch(url, mergedOptions);
        
        // If we get a 401, the token might be invalid or missing
        if (response.status === 401 && window.authManager.authRequired) {
            // Clear any invalid token
            window.authManager.token = null;
            sessionStorage.removeItem('cc-web-token');
            // Show login prompt
            window.authManager.showLoginPrompt();
        }
        
        return response;
    }

    async init() {
        // Check authentication first
        const authenticated = await window.authManager.initialize();
        if (!authenticated) {
            // Auth prompt is shown, stop initialization
            console.log('[Init] Authentication required, waiting for login...');
            return;
        }
        
        await this.loadConfig();
        this.setupTerminal();
        this._setupExtraKeys();
        this.setupUI();
        if (this.voiceInputConfig) this.setupVoiceInput();
        this.setupPlanDetector();
        this.applySettings(this.loadSettings());
        this.applyAliasesToUI();
        this.disablePullToRefresh();

        // Show loading while we initialize
        this.showOverlay('loadingSpinner');

        // Establish WebSocket connection early — all subsequent operations
        // (session creation, joining, tool start) depend on it being ready.
        // Without this, fresh machines with no sessions would leave the
        // socket null until the user completes the folder browser flow.
        await this.connect();

        // Initialize the session tab manager and wait for sessions to load
        this.sessionTabManager = new SessionTabManager(this);
        await this.sessionTabManager.init();

        // Listen for service worker notification clicks (Windows Notification Center)
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data?.type === 'NOTIFICATION_CLICK' && event.data.sessionId) {
                    this.sessionTabManager.switchToTab(event.data.sessionId);
                }
            });
        }
        
        // Initialize split container
        if (window.SplitContainer) {
            this.splitContainer = new window.SplitContainer(this);
            this.splitContainer.setupDropZones();
        }
        
        // Show mode switcher and bottom nav on mobile
        if (this.isMobile) {
            this.showModeSwitcher();
            this._setupBottomNav();
        }
        
        // Check if there are existing sessions
        console.log('[Init] Checking sessions, tabs.size:', this.sessionTabManager.tabs.size);
        if (this.sessionTabManager.tabs.size > 0) {
            console.log('[Init] Found sessions, switching to first tab...');
            // Sessions exist - switch to the first one (this will handle connecting)
            const firstTabId = this.sessionTabManager.tabs.keys().next().value;
            console.log('[Init] Switching to tab:', firstTabId);
            await this.sessionTabManager.switchToTab(firstTabId);
            // The session_joined handler decides the overlay state:
            // - Active session → hideOverlay()
            // - Inactive/new session → showOverlay('startPrompt') for tool selection
            // Do NOT force-hide here — it overrides the handler's decision.
        } else {
            console.log('[Init] No sessions found, auto-creating first session');
            // No sessions — auto-create one with the server's baseFolder (always valid)
            const workingDir = this.selectedWorkingDir;
            if (workingDir) {
                try {
                    const sep = workingDir.includes('\\') ? '\\' : '/';
                    const folderName = workingDir.split(sep).filter(Boolean).pop() || 'Session';
                    const name = `${folderName} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                    const response = await this.authFetch('/api/sessions/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, workingDir })
                    });
                    if (response.ok) {
                        const data = await response.json();
                        this.sessionTabManager.addTab(data.sessionId, name, 'idle', workingDir);
                        await this.sessionTabManager.switchToTab(data.sessionId);
                        // switchToTab handler will show startPrompt for tool selection
                    } else {
                        // Server rejected — fall back to folder browser
                        this.hideOverlay();
                        this.showFolderBrowser();
                    }
                } catch (err) {
                    console.error('[Init] Auto-create session failed:', err);
                    this.hideOverlay();
                    this.showFolderBrowser();
                }
            } else {
                // No baseFolder available — fall back to folder browser
                this.hideOverlay();
                this.showFolderBrowser();
            }
        }
        
        // All sessions go background when tab is hidden, restore on visible
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // Mark all sessions as background
                if (this.sessionTabManager) {
                    const sessions = [];
                    const allTabs = this.sessionTabManager.tabs || new Map();
                    allTabs.forEach((_, sid) => {
                        sessions.push({ sessionId: sid, priority: 'background' });
                    });
                    if (sessions.length > 0) {
                        this.send({ type: 'set_priority', sessions });
                    }
                }
            } else if (this.currentClaudeSessionId) {
                // Restore foreground for active session
                this.sendSessionPriority(this.currentClaudeSessionId);
            }
        });

        window.addEventListener('resize', () => {
            this.fitTerminal();
        });
        
        window.addEventListener('beforeunload', () => {
            this.disconnect();
        });
    }

    async loadConfig() {
        try {
            const res = await this.authFetch('/api/config');
            if (res.ok) {
                const cfg = await res.json();
                if (cfg?.aliases) {
                    this.aliases = {
                        claude: cfg.aliases.claude || 'Claude',
                        codex: cfg.aliases.codex || 'Codex'
                    };
                }
                if (typeof cfg.folderMode === 'boolean') {
                    this.folderMode = cfg.folderMode;
                }
                this.tools = cfg.tools || {};
                this.voiceInputConfig = cfg.voiceInput || null;
                this._configPrerequisites = cfg.prerequisites || null;
                this.hostname = cfg.hostname || '';
                // Store baseFolder so first-run can auto-create a session
                if (cfg.baseFolder) {
                    this.selectedWorkingDir = this.selectedWorkingDir || cfg.baseFolder;
                }
            }
        } catch (_) { /* best-effort */ }
    }

    getAlias(kind) {
        if (this.aliases && this.aliases[kind]) {
            return this.aliases[kind];
        }
        // Default aliases
        const defaults = {
            claude: 'Claude',
            codex: 'Codex',
            agent: 'Cursor',
            copilot: 'Copilot',
            gemini: 'Gemini',
            terminal: 'Terminal'
        };
        return defaults[kind] || kind.charAt(0).toUpperCase() + kind.slice(1);
    }

    applyAliasesToUI() {
        // Re-render tool cards to pick up any alias changes
        this.renderToolCards();

        // Plan modal title
        const planTitle = document.querySelector('#planModal .modal-header h2');
        if (planTitle) planTitle.innerHTML = `<span class=\"icon\" aria-hidden=\"true\">${window.icons?.clipboard?.(18) || ''}</span> ${this.getAlias('claude')}'s Plan`;
    }
    
    detectMobile() {
        // Check for touch capability and common mobile user agents
        const hasTouchScreen = 'ontouchstart' in window || 
                              navigator.maxTouchPoints > 0 || 
                              navigator.msMaxTouchPoints > 0;
        
        const mobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        
        // Also check viewport width for tablets
        const smallViewport = window.innerWidth <= 1024;
        
        return hasTouchScreen && (mobileUserAgent || smallViewport);
    }
    
    disablePullToRefresh() {
        // Prevent pull-to-refresh on touchmove
        let lastY = 0;
        
        document.addEventListener('touchstart', (e) => {
            lastY = e.touches[0].clientY;
        }, { passive: false });
        
        document.addEventListener('touchmove', (e) => {
            const y = e.touches[0].clientY;
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
            
            // Prevent pull-to-refresh when at the top and trying to scroll up
            if (scrollTop === 0 && y > lastY) {
                e.preventDefault();
            }
            
            lastY = y;
        }, { passive: false });
        
        // Also prevent overscroll on the terminal element
        const terminal = document.getElementById('terminal');
        if (terminal) {
            terminal.addEventListener('touchmove', (e) => {
                e.stopPropagation();
            }, { passive: false });
        }
    }
    
    showModeSwitcher() {
        // Create mode switcher button if it doesn't exist
        if (!document.getElementById('modeSwitcher')) {
            const modeSwitcher = document.createElement('div');
            modeSwitcher.id = 'modeSwitcher';
            modeSwitcher.className = 'mode-switcher';
            modeSwitcher.innerHTML = `
                <button id="escapeBtn" class="escape-btn" title="Send Escape key">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                </button>
                <button id="modeSwitcherBtn" class="mode-switcher-btn" data-mode="${this.currentMode}" title="Switch mode (Shift+Tab)">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <line x1="9" y1="9" x2="15" y2="15"/>
                        <line x1="15" y1="9" x2="9" y2="15"/>
                    </svg>
                </button>
            `;
            document.body.appendChild(modeSwitcher);
            
            // Add event listener for mode switcher
            document.getElementById('modeSwitcherBtn').addEventListener('click', () => {
                this.switchMode();
            });
            
            // Add event listener for escape button
            document.getElementById('escapeBtn').addEventListener('click', () => {
                this.sendEscape();
            });
        }
    }

    _setupBottomNav() {
        const navVoice = document.getElementById('navVoice');
        const navFiles = document.getElementById('navFiles');
        const navMore = document.getElementById('navMore');
        const navSettings = document.getElementById('navSettings');

        if (this.voiceController || document.getElementById('voiceInputBtn')?.style.display !== 'none') {
            if (navVoice) navVoice.style.display = '';
        }

        if (navFiles) navFiles.addEventListener('click', () => {
            document.getElementById('browseFilesBtn')?.click();
        });
        if (navMore) navMore.addEventListener('click', () => {
            document.getElementById('mobileMenu')?.classList.add('active');
        });
        if (navSettings) navSettings.addEventListener('click', () => {
            document.getElementById('settingsBtn')?.click();
        });
        if (navVoice) navVoice.addEventListener('click', () => {
            document.getElementById('voiceInputBtn')?.click();
        });
    }

    sendEscape() {
        // Send ESC key to terminal
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            // Send ESC key (ASCII 27 or \x1b)
            this.send({ type: 'input', data: '\x1b' });
        }
        
        // Add visual feedback
        const btn = document.getElementById('escapeBtn');
        if (btn) {
            btn.classList.add('pressed');
            setTimeout(() => {
                btn.classList.remove('pressed');
            }, 200);
        }
    }
    
    switchMode() {
        // Toggle between modes
        const modes = ['chat', 'code', 'plan'];
        const currentIndex = modes.indexOf(this.currentMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        this.currentMode = modes[nextIndex];
        
        // Update button data attribute for styling
        const btn = document.getElementById('modeSwitcherBtn');
        if (btn) {
            btn.setAttribute('data-mode', this.currentMode);
            btn.title = `Switch mode (Shift+Tab) - Current: ${this.currentMode.charAt(0).toUpperCase() + this.currentMode.slice(1)}`;
        }
        
        // Send Shift+Tab to terminal to trigger actual mode switch in Claude Code
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            // Send Shift+Tab key combination (ESC[Z is the terminal sequence for Shift+Tab)
            this.send({ type: 'input', data: '\x1b[Z' });
        }
        
        // Add visual feedback
        if (btn) {
            btn.classList.add('switching');
            setTimeout(() => {
                btn.classList.remove('switching');
            }, 300);
        }
    }

    setupTerminal() {
        // Adjust font size for mobile devices
        const isMobile = this.detectMobile();
        const fontSize = isMobile ? 14 : 14;
        
        this.terminal = new Terminal({
            fontSize: fontSize,
            fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
                || "'MesloLGS Nerd Font', 'Meslo Nerd Font', 'JetBrains Mono', monospace",
            theme: {
                background: '#0d1117',
                foreground: '#f0f6fc',
                cursor: '#ff6b00',
                cursorAccent: '#0d1117',
                selection: 'rgba(255, 107, 0, 0.2)',
                black: '#484f58',
                red: '#ff7b72',
                green: '#7ee787',
                yellow: '#ffa657',
                blue: '#79c0ff',
                magenta: '#d2a8ff',
                cyan: '#a5f3fc',
                white: '#b1bac4',
                brightBlack: '#6e7681',
                brightRed: '#ffa198',
                brightGreen: '#56d364',
                brightYellow: '#ffdf5d',
                brightBlue: '#79c0ff',
                brightMagenta: '#d2a8ff',
                brightCyan: '#a5f3fc',
                brightWhite: '#f0f6fc'
            },
            allowProposedApi: true,
            scrollback: 10000,
            rightClickSelectsWord: false,
            allowTransparency: false,
            // Disable focus tracking to prevent ^[[I and ^[[O sequences
            windowOptions: {
                reportFocus: false
            }
        });

        this.fitAddon = new FitAddon.FitAddon();
        this.webLinksAddon = new WebLinksAddon.WebLinksAddon();

        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(this.webLinksAddon);

        // Load search addon if available
        if (typeof SearchAddon !== 'undefined') {
            this.searchAddon = new SearchAddon.SearchAddon();
            this.terminal.loadAddon(this.searchAddon);
        }

        // Load Unicode11 addon for correct Nerd Font / powerline glyph widths
        if (typeof Unicode11Addon !== 'undefined') {
            this.unicode11Addon = new Unicode11Addon.Unicode11Addon();
            this.terminal.loadAddon(this.unicode11Addon);
            this.terminal.unicode.activeVersion = '11';
        }

        this.terminal.open(document.getElementById('terminal'));

        // WebGL renderer: 3-10x faster than DOM (0.7ms vs 5-10ms per frame)
        this._loadGpuRenderer();

        this.fitTerminal();

        // Re-render terminal when fonts finish loading
        if (document.fonts) {
            // One-shot: handle initial font load
            document.fonts.ready.then(() => {
                const loaded = document.fonts.check('14px "MesloLGS Nerd Font"');
                console.log(loaded ? '[Font] MesloLGS Nerd Font loaded' : '[Font] Using fallback font');
                this.terminal.clearTextureAtlas();
                this.terminal.refresh(0, this.terminal.rows - 1);
                this.fitTerminal();
            });
            // Persistent: handle late-loading Bold/Italic variants
            // document.fonts.ready is a one-shot promise that won't fire again
            // when Bold loads after output coalescing delay triggers bold rendering
            document.fonts.addEventListener('loadingdone', () => {
                this.terminal.clearTextureAtlas();
                this.terminal.refresh(0, this.terminal.rows - 1);
                this.fitTerminal();
            });
        }

        // Debounced ResizeObserver — catches all layout changes (sidebar,
        // browser zoom, DevTools toggle) and refits all terminals
        const termContainerEl = document.querySelector('.terminal-container');
        if (termContainerEl && typeof ResizeObserver !== 'undefined') {
            let resizeTimeout;
            new ResizeObserver(() => {
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    this.fitTerminal();
                    if (this.splitContainer && this.splitContainer.splits) {
                        this.splitContainer.splits.forEach(s => { try { s.fit(); } catch (_) {} });
                    }
                }, 50);
            }).observe(termContainerEl);
        }

        // Attach keyboard copy/paste shortcuts (Ctrl+C/V, Ctrl+Shift+C/V)
        attachClipboardHandler(this.terminal, (data) => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.send({ type: 'input', data });
            }
        });

        // Attach image paste/drop handler
        const termContainer = document.getElementById('terminal');
        if (window.imageHandler && termContainer) {
            this._imageHandler = window.imageHandler.attachImageHandler(
                this.terminal, termContainer, {
                    onImageReady: (imageData) => {
                        this._pendingImageCaption = imageData.caption;
                        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                            this.send({
                                type: 'image_upload',
                                base64: imageData.base64,
                                mimeType: imageData.mimeType,
                                fileName: imageData.fileName || 'pasted-image.png',
                                caption: imageData.caption || ''
                            });
                        }
                    }
                }
            );
        }

        this.setupTerminalSearch();
        this.setupTerminalContextMenu();

        this.terminal.onData((data) => {
            if (this._ctrlModifierPending) {
                if (data.length === 1) {
                    const charCode = data.charCodeAt(0);
                    if (charCode >= 97 && charCode <= 122) {
                        data = String.fromCharCode(charCode - 96);
                    } else if (charCode >= 65 && charCode <= 90) {
                        data = String.fromCharCode(charCode - 64);
                    }
                }
                this._ctrlModifierPending = false;
                if (this.extraKeys) {
                    this.extraKeys.ctrlActive = false;
                    this.extraKeys._updateCtrlVisual();
                }
            }
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                // Filter out focus tracking sequences before sending
                const filteredData = data.replace(/\x1b\[\[?[IO]/g, '');
                if (filteredData) {
                    // Accumulate keystrokes, flush per animation frame (breather-flush pattern)
                    this._inputBuffer += filteredData;
                    // Safety cap: flush immediately if buffer exceeds 64KB (e.g., large paste)
                    if (this._inputBuffer.length > this._INPUT_BUFFER_MAX) {
                        this._flushInput();
                        return;
                    }
                    if (!this._inputFlushScheduled) {
                        this._inputFlushScheduled = true;
                        requestAnimationFrame(() => this._flushInput());
                    }
                }
            }
        });

        this.terminal.onResize(({ cols, rows }) => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.send({ type: 'resize', cols, rows });
            }
        });

        // Sync terminal colors when the CSS theme changes (data-theme attribute)
        const themeObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.attributeName === 'data-theme' && this.terminal) {
                    this.syncTerminalTheme();
                }
            }
        });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    _setupExtraKeys() {
        if (!this.isMobile || !window.visualViewport || typeof ExtraKeys === 'undefined') return;

        this.extraKeys = new ExtraKeys({ app: this });

        let prevHeight = window.visualViewport.height;
        window.visualViewport.addEventListener('resize', () => {
            const currentHeight = window.visualViewport.height;
            const heightDiff = window.innerHeight - currentHeight;

            if (heightDiff > 150) {
                this.extraKeys.show();
                const termEl = document.getElementById('terminal');
                if (termEl) {
                    termEl.style.height = (currentHeight - 44) + 'px';
                    if (this.fitAddon) this.fitAddon.fit();
                }
            } else {
                this.extraKeys.hide();
                const termEl = document.getElementById('terminal');
                if (termEl) {
                    termEl.style.height = '';
                    if (this.fitAddon) this.fitAddon.fit();
                }
            }
            prevHeight = currentHeight;
        });
    }

    showSessionSelectionModal() {
        // Create a simple modal to show existing sessions
        const modal = document.createElement('div');
        modal.className = 'session-modal active';
        modal.id = 'sessionSelectionModal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Select a Session</h2>
                    <button class="close-btn" id="closeSessionSelection">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="session-list">
                        ${this.claudeSessions.map(session => {
                            const statusIcon = `<span class=\"dot ${session.active ? 'dot-on' : 'dot-idle'}\" aria-hidden=\"true\"></span><span class=\"sr-only\">${session.active ? 'Active' : 'Idle'}</span>`;
                            const clientsText = session.connectedClients === 1 ? '1 client' : `${session.connectedClients} clients`;
                            return `
                                <div class="session-item" data-session-id="${session.id}">
                                    <div class="session-info">
                                        <span class="session-status">${statusIcon}</span>
                                        <div class="session-details">
                                            <div class="session-name">${this._escapeHtml(session.name)}</div>
                                            <div class="session-meta">${clientsText} • ${new Date(session.created).toLocaleString()}</div>
                                            ${session.workingDir ? `<div class=\"session-folder\" title=\"${this._escapeHtml(session.workingDir)}\"><span class=\"icon\" aria-hidden=\"true\">${window.icons?.folder?.(14) || ''}</span> ${this._escapeHtml(session.workingDir)}</div>` : ''}
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                    <div style="margin-top: 20px; text-align: center;">
                        <button class="btn btn-secondary" id="selectSessionNewFolder">Load a New Folder Instead</button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Add event listeners
        modal.querySelectorAll('.session-item').forEach(item => {
            item.addEventListener('click', async () => {
                const sessionId = item.dataset.sessionId;
                await this.joinSession(sessionId);
                modal.remove();
            });
        });
        
        document.getElementById('closeSessionSelection').addEventListener('click', () => {
            modal.remove();
            this.hideOverlay();
            this.showFolderBrowser();
        });
        
        document.getElementById('selectSessionNewFolder').addEventListener('click', () => {
            modal.remove();
            this.hideOverlay();
            this.showFolderBrowser();
        });
        
        // Close on background click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
                this.hideOverlay();
                this.showFolderBrowser();
            }
        });
    }
    
    setupUI() {
        const settingsBtn = document.getElementById('settingsBtn');
        const retryBtn = document.getElementById('retryBtn');

        // Mobile menu buttons (keeping for mobile support)
        const closeMenuBtn = document.getElementById('closeMenuBtn');
        const settingsBtnMobile = document.getElementById('settingsBtnMobile');

        // Render dynamic tool cards from config
        this.renderToolCards();

        if (settingsBtn) settingsBtn.addEventListener('click', () => this.showSettings());
        if (retryBtn) retryBtn.addEventListener('click', () => this.reconnect());

        // Attach Image button
        const attachBtn = document.getElementById('attachImageBtn');
        if (attachBtn && window.imageHandler) {
            attachBtn.addEventListener('click', () => {
                window.imageHandler.triggerFilePicker((imageData) => {
                    this._pendingImageCaption = imageData.caption;
                    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                        this.send({
                            type: 'image_upload',
                            base64: imageData.base64,
                            mimeType: imageData.mimeType,
                            fileName: imageData.fileName || 'attached-image.png',
                            caption: imageData.caption || ''
                        });
                    }
                });
            });
        }
        
        // File Browser button
        const browseFilesBtn = document.getElementById('browseFilesBtn');
        if (browseFilesBtn) {
            browseFilesBtn.addEventListener('click', () => this.toggleFileBrowser());
        }

        // Ctrl+B shortcut for file browser
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                e.preventDefault();
                this.toggleFileBrowser();
            }
        });

        // App Tunnel button
        const appTunnelBtn = document.getElementById('appTunnelBtn');
        if (appTunnelBtn) {
            appTunnelBtn.addEventListener('click', () => this.toggleAppTunnel());
        }

        // VS Code Tunnel button
        const vscodeTunnelBtn = document.getElementById('vscodeTunnelBtn');
        if (vscodeTunnelBtn) {
            vscodeTunnelBtn.addEventListener('click', () => this.toggleVSCodeTunnel());
        }

        // Ctrl+Shift+V shortcut for VS Code tunnel
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
                e.preventDefault();
                this.toggleVSCodeTunnel();
            }
        });

        // Tile view toggle
        // Mobile menu event listeners
        if (closeMenuBtn) closeMenuBtn.addEventListener('click', () => this.closeMobileMenu());
        if (settingsBtnMobile) {
            settingsBtnMobile.addEventListener('click', () => {
                this.showSettings();
                this.closeMobileMenu();
            });
        }
        
        // Mobile sessions button
        const sessionsBtnMobile = document.getElementById('sessionsBtnMobile');
        if (sessionsBtnMobile) {
            sessionsBtnMobile.addEventListener('click', () => {
                this.showMobileSessionsModal();
                this.closeMobileMenu();
            });
        }
        
        this.setupSettingsModal();
        this.setupFolderBrowser();
        this.setupNewSessionModal();
        this.setupMobileSessionsModal();

        // Custom prompts dropdown removed
    }

    setupVoiceInput() {
        const voiceCfg = this.voiceInputConfig;
        if (!voiceCfg) return;

        const btn = document.getElementById('voiceInputBtn');
        if (!btn) return;

        // Determine mode: prefer local if ready, fall back to cloud
        const localReady = voiceCfg.localStatus === 'ready';
        const cloudAvailable = typeof window !== 'undefined' &&
            !!(window.SpeechRecognition || window.webkitSpeechRecognition);

        if (!localReady && !cloudAvailable) {
            // Neither backend available — keep button hidden
            return;
        }

        this.voiceMode = localReady ? 'local' : 'cloud';
        btn.style.display = '';

        const self = this;
        const timerEl = btn.querySelector('.voice-timer');

        this.voiceController = new window.VoiceHandler.VoiceInputController({
            mode: this.voiceMode,
            onRecordingStart: function () {
                self._playMicChime('on');
                btn.classList.add('recording');
                btn.classList.remove('processing');
                btn.setAttribute('aria-pressed', 'true');
                btn.title = 'Stop Recording (Ctrl+Shift+M)';
                if (timerEl) {
                    timerEl.style.display = '';
                    timerEl.textContent = '0:00';
                }
                // Start timer
                self._voiceTimerInterval = setInterval(function () {
                    if (self.voiceController && timerEl) {
                        var secs = self.voiceController.elapsed;
                        var m = Math.floor(secs / 60);
                        var s = secs % 60;
                        timerEl.textContent = m + ':' + (s < 10 ? '0' : '') + s;
                    }
                }, 1000);
                // Announce to screen reader
                var srEl = document.getElementById('srAnnounce');
                if (srEl) srEl.textContent = 'Recording. Speak now.';
            },
            onRecordingStop: function (result) {
                self._playMicChime('off');
                btn.classList.remove('recording');
                btn.setAttribute('aria-pressed', 'false');
                btn.title = 'Voice Input (Ctrl+Shift+M)';
                if (timerEl) timerEl.style.display = 'none';
                if (self._voiceTimerInterval) {
                    clearInterval(self._voiceTimerInterval);
                    self._voiceTimerInterval = null;
                }

                if (self.voiceMode === 'local' && result && result.samples) {
                    btn.classList.add('processing');
                    // Convert Int16 PCM to base64 efficiently (chunked to avoid call stack overflow)
                    var pcmBytes = new Uint8Array(result.samples.buffer);
                    var CHUNK_SIZE = 8192;
                    var parts = [];
                    for (var i = 0; i < pcmBytes.length; i += CHUNK_SIZE) {
                        var chunk = pcmBytes.subarray(i, Math.min(i + CHUNK_SIZE, pcmBytes.length));
                        parts.push(String.fromCharCode.apply(null, chunk));
                    }
                    var base64Audio = btoa(parts.join(''));
                    self.send({
                        type: 'voice_upload',
                        audio: base64Audio,
                        durationMs: result.durationMs
                    });

                    // Client-side timeout for transcription processing (90 seconds)
                    self._voiceTranscriptionTimeout = setTimeout(function () {
                        self._voiceTranscriptionTimeout = null;
                        btn.classList.remove('processing');
                        var errorMsg = 'Transcription timed out';
                        // Show error toast
                        var toast = document.createElement('div');
                        toast.className = 'clipboard-toast';
                        toast.textContent = errorMsg;
                        document.body.appendChild(toast);
                        setTimeout(function () { toast.remove(); }, 4000);
                        if (self.terminal) {
                            self.terminal.write('\r\n\x1b[31m[Voice error] ' + errorMsg + '\x1b[0m\r\n');
                        }
                    }, 90000);
                }
                // Cloud mode: text comes via onTranscription, no processing state needed
            },
            onTranscription: function (text) {
                btn.classList.remove('processing');
                // Clear transcription timeout
                if (self._voiceTranscriptionTimeout) {
                    clearTimeout(self._voiceTranscriptionTimeout);
                    self._voiceTranscriptionTimeout = null;
                }
                if (text && self.socket && self.socket.readyState === WebSocket.OPEN) {
                    // Inject transcribed text as terminal input
                    var normalized = text;
                    if (typeof attachClipboardHandler !== 'undefined' && attachClipboardHandler.normalizeLineEndings) {
                        normalized = attachClipboardHandler.normalizeLineEndings(text);
                    }
                    if (self.terminal && self.terminal.modes && self.terminal.modes.bracketedPasteMode) {
                        if (typeof attachClipboardHandler !== 'undefined' && attachClipboardHandler.wrapBracketedPaste) {
                            normalized = attachClipboardHandler.wrapBracketedPaste(normalized);
                        }
                    }
                    self.send({ type: 'input', data: normalized });
                }
                var srEl = document.getElementById('srAnnounce');
                if (srEl) srEl.textContent = 'Transcription complete.';
            },
            onError: function (err) {
                btn.classList.remove('recording', 'processing');
                btn.setAttribute('aria-pressed', 'false');
                btn.title = 'Voice Input (Ctrl+Shift+M)';
                if (timerEl) timerEl.style.display = 'none';
                if (self._voiceTimerInterval) {
                    clearInterval(self._voiceTimerInterval);
                    self._voiceTimerInterval = null;
                }
                // Clear transcription timeout on error
                if (self._voiceTranscriptionTimeout) {
                    clearTimeout(self._voiceTranscriptionTimeout);
                    self._voiceTranscriptionTimeout = null;
                }
                console.error('[Voice] Error:', err);
                var errorMessage = err.message || String(err);
                if (self.terminal) {
                    self.terminal.write('\r\n\x1b[31m[Voice error] ' + errorMessage + '\x1b[0m\r\n');
                }
                // Show error toast (reuse existing toast pattern)
                var toastMsg = errorMessage;
                if (errorMessage.indexOf('not-allowed') !== -1 || errorMessage.indexOf('Permission') !== -1 || errorMessage.indexOf('permission') !== -1) {
                    toastMsg = errorMessage + '. Check browser permissions';
                }
                var toast = document.createElement('div');
                toast.className = 'clipboard-toast';
                toast.textContent = toastMsg;
                document.body.appendChild(toast);
                setTimeout(function () { toast.remove(); }, 4000);
            },
            onCancel: function () {
                btn.classList.remove('recording', 'processing');
                btn.setAttribute('aria-pressed', 'false');
                btn.title = 'Voice Input (Ctrl+Shift+M)';
                if (timerEl) timerEl.style.display = 'none';
                if (self._voiceTimerInterval) {
                    clearInterval(self._voiceTimerInterval);
                    self._voiceTimerInterval = null;
                }
                var srEl = document.getElementById('srAnnounce');
                if (srEl) srEl.textContent = 'Recording cancelled.';
            }
        });

        // Button click: toggle recording
        btn.addEventListener('click', function () {
            self.voiceController.toggleRecording();
        });

        // Attach keyboard listeners (Ctrl+Shift+M, Escape)
        this.voiceController.attachKeyboardListeners();

        // Download banner dismiss
        var dismissBtn = document.getElementById('voiceDownloadDismiss');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', function () {
                var banner = document.getElementById('voiceDownloadBanner');
                if (banner) {
                    banner.classList.remove('visible');
                    banner.style.display = 'none';
                }
            });
        }
    }

    _handleVoiceMessage(message) {
        var btn = document.getElementById('voiceInputBtn');
        switch (message.type) {
            case 'voice_transcription': {
                if (btn) btn.classList.remove('processing');
                // Clear client-side transcription timeout
                if (this._voiceTranscriptionTimeout) {
                    clearTimeout(this._voiceTranscriptionTimeout);
                    this._voiceTranscriptionTimeout = null;
                }
                var text = message.text || '';
                if (text) {
                    var normalized = text;
                    if (typeof attachClipboardHandler !== 'undefined' && attachClipboardHandler.normalizeLineEndings) {
                        normalized = attachClipboardHandler.normalizeLineEndings(text);
                    }
                    if (this.terminal && this.terminal.modes && this.terminal.modes.bracketedPasteMode) {
                        if (typeof attachClipboardHandler !== 'undefined' && attachClipboardHandler.wrapBracketedPaste) {
                            normalized = attachClipboardHandler.wrapBracketedPaste(normalized);
                        }
                    }
                    this.send({ type: 'input', data: normalized });
                }
                var srEl = document.getElementById('srAnnounce');
                if (srEl) srEl.textContent = 'Transcription complete.';
                break;
            }
            case 'voice_transcription_error': {
                if (btn) btn.classList.remove('processing');
                // Clear client-side transcription timeout
                if (this._voiceTranscriptionTimeout) {
                    clearTimeout(this._voiceTranscriptionTimeout);
                    this._voiceTranscriptionTimeout = null;
                }
                if (this.terminal) {
                    this.terminal.write('\r\n\x1b[31m[Voice error] ' + (message.message || 'Transcription failed') + '\x1b[0m\r\n');
                }
                break;
            }
            case 'voice_model_progress': {
                var banner = document.getElementById('voiceDownloadBanner');
                var fill = document.getElementById('voiceDownloadFill');
                var pct = document.getElementById('voiceDownloadPercent');
                var percent = message.percent || 0;

                if (banner) {
                    if (percent >= 100) {
                        banner.classList.remove('visible');
                        banner.style.display = 'none';
                        // Switch to local mode now that model is ready
                        if (this.voiceController) {
                            this.voiceMode = 'local';
                            this.voiceController.setMode('local');
                        }
                    } else {
                        banner.style.display = '';
                        banner.classList.add('visible');
                    }
                }
                if (fill) fill.style.width = Math.min(percent, 100) + '%';
                if (pct) pct.textContent = Math.round(percent) + '%';
                break;
            }
            case 'voice_status': {
                // Update voice input config status and show/hide mic button
                if (message.voiceInput) {
                    this.voiceInputConfig = message.voiceInput;
                }
                var localReady = this.voiceInputConfig && this.voiceInputConfig.localStatus === 'ready';
                var cloudAvailable = typeof window !== 'undefined' &&
                    !!(window.SpeechRecognition || window.webkitSpeechRecognition);
                if (btn) {
                    if (localReady || cloudAvailable) {
                        btn.style.display = '';
                        // Update mode if local just became ready
                        if (localReady && this.voiceMode !== 'local' && this.voiceController) {
                            this.voiceMode = 'local';
                            this.voiceController.setMode('local');
                        }
                    } else {
                        btn.style.display = 'none';
                    }
                }
                break;
            }
        }
    }

    setupSettingsModal() {
        const modal = document.getElementById('settingsModal');
        const closeBtn = document.getElementById('closeSettingsBtn');
        const saveBtn = document.getElementById('saveSettingsBtn');
        const cancelBtn = document.getElementById('cancelSettingsBtn');
        const resetBtn = document.getElementById('resetSettingsBtn');
        const fontSizeSlider = document.getElementById('fontSize');
        const fontSizeValue = document.getElementById('fontSizeValue');

        closeBtn.addEventListener('click', () => this.hideSettings());
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.hideSettings());
        saveBtn.addEventListener('click', () => this.saveSettings());
        if (resetBtn) resetBtn.addEventListener('click', () => this.resetSettings());

        fontSizeSlider.addEventListener('input', (e) => {
            fontSizeValue.textContent = e.target.value + 'px';
        });

        const terminalPaddingSlider = document.getElementById('terminalPadding');
        const terminalPaddingValue = document.getElementById('terminalPaddingValue');
        if (terminalPaddingSlider && terminalPaddingValue) {
            terminalPaddingSlider.addEventListener('input', (e) => {
                terminalPaddingValue.textContent = e.target.value + 'px';
            });
        }

        const notifVolumeSlider = document.getElementById('notifVolume');
        const notifVolumeValue = document.getElementById('notifVolumeValue');
        if (notifVolumeSlider && notifVolumeValue) {
            notifVolumeSlider.addEventListener('input', (e) => {
                notifVolumeValue.textContent = e.target.value + '%';
            });
        }

        // Section collapse/expand (keyboard accessible)
        modal.querySelectorAll('.setting-section-header').forEach((header) => {
            const toggle = () => {
                const section = header.parentElement;
                const isCollapsed = section.classList.toggle('collapsed');
                header.setAttribute('aria-expanded', String(!isCollapsed));
            };
            header.addEventListener('click', toggle);
            header.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle();
                }
            });
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.hideSettings();
            }
        });
    }

    // setupCommandsMenu removed

    // populateCommandsDropdown removed

    // appendCustomCommandItem removed

    // runCommandFromPath removed

    // setupCustomCommandModal removed

    // openCustomCommandModal removed

    // closeCustomCommandModal removed

    connect(sessionId = null) {
        return new Promise((resolve, reject) => {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            let wsUrl = `${protocol}//${location.host}`;
            if (sessionId) {
                wsUrl += `?sessionId=${sessionId}`;
            }
            
            // Add auth token if required
            wsUrl = window.authManager.getWebSocketUrl(wsUrl);
            
            this.updateStatus('Connecting...');
            // Only show loading spinner if overlay is already visible
            // Don't force it to show if we're handling restored sessions
            if (document.getElementById('overlay').style.display !== 'none') {
                this.showOverlay('loadingSpinner');
            }
            
            try {
                this.socket = new WebSocket(wsUrl);
                this.socket.binaryType = 'arraybuffer';

                this.socket.onopen = () => {
                    this.reconnectAttempts = 0;
                    this.updateStatus('Connected');
                    console.log('Connected to server');
                    
                    // Load available sessions
                    this.loadSessions();
                    
                    // Only show start prompt if sessionTabManager is initialized and has no sessions
                    // During early init(), sessionTabManager is null — let init() handle the overlay
                    if (this.sessionTabManager && !this.currentClaudeSessionId && this.sessionTabManager.tabs.size === 0) {
                        this.showOverlay('startPrompt');
                    }
                    
                    // Show close session button if we have a selected working directory
                    if (this.selectedWorkingDir) {
                        // Close session buttons removed with header
                    }

                    // Request app tunnel status
                    this.send({ type: 'app_tunnel_status' });

                    resolve();
                };
            
            this.socket.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) {
                    // Binary frame — pass raw ArrayBuffer to handleBinaryOutput
                    this.handleBinaryOutput(event.data);
                } else {
                    // Text frame = JSON control message
                    this.handleMessage(JSON.parse(event.data));
                }
            };
            
            this.socket.onclose = (event) => {
                if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.updateStatus('Reconnecting...');
                    setTimeout(() => this.reconnect(), this.reconnectDelay * Math.pow(2, this.reconnectAttempts));
                    this.reconnectAttempts++;
                } else {
                    this.updateStatus('Disconnected');
                    this.showError(`Connection lost after ${this.maxReconnectAttempts} attempts.\n\nYour session data is preserved on the server.\n\u2022 Check your network connection\n\u2022 The server may have restarted \u2014 try refreshing the page`);
                }
            };
            
            this.socket.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.showError('Failed to connect to the server.\n\n\u2022 Check that the server is running\n\u2022 Verify your network connection\n\u2022 Try refreshing the page');
                reject(error);
            };
            
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
            this.showError('Failed to create connection.\n\n\u2022 Check that the server URL is correct\n\u2022 Try refreshing the page');
            reject(error);
        }
        });
    }

    disconnect() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }

    reconnect() {
        this.disconnect();
        // Reset flow control state so stale pause signals aren't sent on new connection
        this._outputPaused = false;
        this._pendingCallbacks = 0;
        this._writtenBytes = 0;
        this._pendingWrites = [];
        this._rafPending = false;
        // Clear stale input buffer to prevent ghost keystrokes after reconnect
        this._inputBuffer = '';
        this._inputFlushScheduled = false;
        this._ctrlModifierPending = false;
        this._planDetectChunks = [];
        if (this._planDetectTimer) {
            clearTimeout(this._planDetectTimer);
            this._planDetectTimer = null;
        }
        setTimeout(() => {
            this.connect().catch(err => console.error('Reconnection failed:', err));
        }, 1000);
    }

    send(data) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(data));
        }
    }

    // Flush accumulated input buffer to server as a single batched message
    _flushInput() {
        this._inputFlushScheduled = false;
        if (this._inputBuffer.length > 0 && this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.send({ type: 'input', data: this._inputBuffer });
            this._inputBuffer = '';
        }
    }

    handleBinaryOutput(data) {
        const chunk = new Uint8Array(data);

        // 1. Queue the chunk for coalesced terminal write
        this._pendingWrites.push(chunk);
        if (!this._rafPending) {
            this._rafPending = true;
            requestAnimationFrame(() => this._flushWrites());
        }

        // 2. Session activity tracking (cheap — runs per frame)
        if (this.sessionTabManager && this.currentClaudeSessionId) {
            const text = this._textDecoder.decode(data, { stream: true });
            this.sessionTabManager.markSessionActivity(this.currentClaudeSessionId, true, text);
        }

        // 3. Deferred plan detection — accumulate chunks, decode after 100ms idle
        if (this.planDetector) {
            this._planDetectChunks.push(chunk);
            if (this._planDetectTimer) clearTimeout(this._planDetectTimer);
            this._planDetectTimer = setTimeout(() => this._flushPlanDetection(), 100);
        }
    }

    // Concatenate all queued chunks and write to terminal once per animation frame
    _flushWrites() {
        this._rafPending = false;
        const chunks = this._pendingWrites;
        this._pendingWrites = [];
        if (chunks.length === 0) return;

        // Concatenate into a single Uint8Array
        let combined;
        if (chunks.length === 1) {
            combined = chunks[0];
        } else {
            let totalLen = 0;
            for (let i = 0; i < chunks.length; i++) totalLen += chunks[i].byteLength;
            combined = new Uint8Array(totalLen);
            let offset = 0;
            for (let i = 0; i < chunks.length; i++) {
                combined.set(chunks[i], offset);
                offset += chunks[i].byteLength;
            }
        }

        this._writeToTerminal(combined);
    }

    // Decode accumulated binary chunks and run plan detection
    _flushPlanDetection() {
        this._planDetectTimer = null;
        const chunks = this._planDetectChunks;
        this._planDetectChunks = [];
        if (chunks.length === 0 || !this.planDetector) return;

        // Concatenate then decode once
        let combined;
        if (chunks.length === 1) {
            combined = chunks[0];
        } else {
            let totalLen = 0;
            for (let i = 0; i < chunks.length; i++) totalLen += chunks[i].byteLength;
            combined = new Uint8Array(totalLen);
            let offset = 0;
            for (let i = 0; i < chunks.length; i++) {
                combined.set(chunks[i], offset);
                offset += chunks[i].byteLength;
            }
        }

        const text = this._planTextDecoder.decode(combined, { stream: true });
        this.planDetector.processOutput(text);
    }

    // Flow control using xterm.js callback-counting watermark pattern
    // (recommended by xterm.js docs, used by ttyd and Tabby)
    _writeToTerminal(data) {
        this._writtenBytes += data.byteLength || data.length;
        if (this._writtenBytes > this._CALLBACK_BYTE_LIMIT) {
            this.terminal.write(data, () => {
                this._pendingCallbacks = Math.max(this._pendingCallbacks - 1, 0);
                if (this._outputPaused && this._pendingCallbacks < this._LOW_WATER) {
                    this._outputPaused = false;
                    this.send({ type: 'flow_control', action: 'resume' });
                }
            });
            this._pendingCallbacks++;
            this._writtenBytes = 0;
            if (!this._outputPaused && this._pendingCallbacks > this._HIGH_WATER) {
                this._outputPaused = true;
                this.send({ type: 'flow_control', action: 'pause' });
            }
        } else {
            this.terminal.write(data);  // Fast path — no callback overhead
        }
    }

    handleMessage(message) {
        switch (message.type) {
            case 'connected':
                this.connectionId = message.connectionId;
                break;
                
            case 'session_created':
                this.currentClaudeSessionId = message.sessionId;
                this.currentClaudeSessionName = message.sessionName;
                this.updateWorkingDir(message.workingDir);
                this.updateSessionButton(message.sessionName);
                this.loadSessions();
                
                // Add tab for the new session if using tab manager
                if (this.sessionTabManager) {
                    this.sessionTabManager.addTab(message.sessionId, message.sessionName, 'idle', message.workingDir);
                    this.sessionTabManager.switchToTab(message.sessionId);
                }
                
                this.showOverlay('startPrompt');
                break;
                
            case 'session_joined':
                console.log('[session_joined] Message received, active:', message.active, 'tabs:', this.sessionTabManager?.tabs.size);
                this.currentClaudeSessionId = message.sessionId;
                this.currentClaudeSessionName = message.sessionName;
                this.updateWorkingDir(message.workingDir);
                this.updateSessionButton(message.sessionName);
                
                // Update tab status
                if (this.sessionTabManager) {
                    this.sessionTabManager.updateTabStatus(message.sessionId, message.active ? 'active' : 'idle');
                }
                
                // Notify split container of session change
                if (this.splitContainer) {
                    this.splitContainer.onTabSwitch(message.sessionId);
                }
                
                // Resolve pending join promise if it exists
                if (this.pendingJoinResolve && this.pendingJoinSessionId === message.sessionId) {
                    this.pendingJoinResolve();
                    this.pendingJoinResolve = null;
                    this.pendingJoinSessionId = null;
                }
                
                // Replay output buffer if available
                if (message.outputBuffer && message.outputBuffer.length > 0) {
                    this.terminal.clear();
                    message.outputBuffer.forEach(data => {
                        // Filter out focus tracking sequences (^[[I and ^[[O)
                        const filteredData = data.replace(/\x1b\[\[?[IO]/g, '');
                        this.terminal.write(filteredData);
                    });
                }
                
                // Show appropriate UI based on session state
                console.log('[session_joined] Checking if should show overlay. Active:', message.active, 'toolStartPending:', !!this._toolStartPending);
                if (this._toolStartPending) {
                    // A tool start is in flight — don't overwrite the loading spinner
                    console.log('[session_joined] Tool start pending, preserving overlay');
                } else if (message.active) {
                    console.log('[session_joined] Session is active, hiding overlay');
                    this.hideOverlay();
                } else {
                    // Session exists but Claude is not running
                    // Check if this is a brand new session (empty output buffer indicates new)
                    const isNewSession = !message.outputBuffer || message.outputBuffer.length === 0;

                    if (isNewSession) {
                        console.log('[session_joined] New session detected, showing start prompt');
                        this.showOverlay('startPrompt');
                    } else {
                        console.log('[session_joined] Existing session with stopped Claude, showing restart prompt');
                        // For existing sessions where Claude has stopped, show start prompt
                        // This allows the user to restart Claude in the same session
                        this.terminal.writeln(`\r\n\x1b[33m${this.getAlias('claude')} has stopped in this session. Click "Start ${this.getAlias('claude')}" to restart.\x1b[0m`);
                        this.showOverlay('startPrompt');
                    }
                }
                break;
                
            case 'session_left':
                this.currentClaudeSessionId = null;
                this.currentClaudeSessionName = null;
                this.updateSessionButton('Sessions');
                this.terminal.clear();
                
                // Update tab status
                if (this.sessionTabManager && message.sessionId) {
                    this.sessionTabManager.updateTabStatus(message.sessionId, 'disconnected');
                }
                
                // Only show start prompt if we don't have any tabs
                // When switching tabs, we leave one and join another, so don't show prompt
                if (!this.sessionTabManager || this.sessionTabManager.tabs.size === 0) {
                    this.showOverlay('startPrompt');
                }
                break;
                
            case 'claude_started':
            case 'codex_started':
            case 'agent_started':
            case 'copilot_started':
            case 'gemini_started':
            case 'terminal_started': {
                this._toolStartPending = false;
                if (this._startToolTimeout) { clearTimeout(this._startToolTimeout); this._startToolTimeout = null; }
                this.hideOverlay();
                this.loadSessions();
                this.requestUsageStats();
                const startedTool = message.type.replace('_started', '');
                if (this.sessionTabManager && this.currentClaudeSessionId) {
                    this.sessionTabManager.updateTabStatus(this.currentClaudeSessionId, 'active');
                    this.sessionTabManager.setTabToolType(this.currentClaudeSessionId, startedTool === 'agent' ? 'claude' : startedTool);
                }
                const srStarted = document.getElementById('srAnnounce');
                if (srStarted) srStarted.textContent = `${this.getAlias(startedTool)} started`;
                break;
            }

            case 'claude_stopped':
            case 'codex_stopped':
            case 'agent_stopped':
            case 'copilot_stopped':
            case 'gemini_stopped':
            case 'terminal_stopped': {
                const stoppedTool = message.type.replace('_stopped', '');
                this.terminal.writeln(`\r\n\x1b[33m${this.getAlias(stoppedTool)} stopped\x1b[0m`);
                const srStopped = document.getElementById('srAnnounce');
                if (srStopped) srStopped.textContent = `${this.getAlias(stoppedTool)} stopped`;
                // If terminal was opened for installation, refresh config to pick up newly installed tools
                if (this._pendingInstallToolId) {
                    const pendingTool = this._pendingInstallToolId;
                    this._pendingInstallToolId = null;
                    this.refreshConfig().then(() => {
                        // Auto-recheck the specific tool that was being installed
                        fetch(`/api/tools/${pendingTool}/recheck`, { method: 'POST' })
                            .then(r => r.json())
                            .then(() => this.refreshConfig())
                            .catch(() => {});
                    });
                }
                this.showOverlay('startPrompt');
                this.loadSessions();
                if (this.sessionTabManager && this.currentClaudeSessionId) {
                    this.sessionTabManager.updateTabStatus(this.currentClaudeSessionId, 'idle');
                }
                break;
            }
                
            case 'output':
                // Filter out focus tracking sequences (^[[I and ^[[O)
                const filteredData = message.data.replace(/\x1b\[\[?[IO]/g, '');
                this.terminal.write(filteredData);
                
                // Update session activity indicator with output data
                if (this.sessionTabManager && this.currentClaudeSessionId) {
                    this.sessionTabManager.markSessionActivity(this.currentClaudeSessionId, true, message.data);
                }
                
                // Pass output to plan detector
                if (this.planDetector) {
                    this.planDetector.processOutput(message.data);
                }
                break;
                
            case 'exit':
                this._toolStartPending = false;
                if (this._startToolTimeout) { clearTimeout(this._startToolTimeout); this._startToolTimeout = null; }
                this.terminal.writeln(`\r\n\x1b[33m${this.getAlias('claude')} exited with code ${message.code}\x1b[0m`);
                
                // Mark session as error if non-zero exit code
                if (this.sessionTabManager && this.currentClaudeSessionId && message.code !== 0) {
                    this.sessionTabManager.markSessionError(this.currentClaudeSessionId, true);
                }
                
                this.showOverlay('startPrompt');
                this.loadSessions(); // Refresh session list
                break;
                
            case 'error':
                this._toolStartPending = false;
                if (this._startToolTimeout) { clearTimeout(this._startToolTimeout); this._startToolTimeout = null; }
                this.showError(message.message);
                
                // Mark session as having an error
                if (this.sessionTabManager && this.currentClaudeSessionId) {
                    this.sessionTabManager.markSessionError(this.currentClaudeSessionId, true);
                }
                break;
                
            case 'info':
                // Info message - show the start prompt if Claude is not running
                if (message.message.includes('not running')) {
                    this.showOverlay('startPrompt');
                }
                break;
                
            case 'session_deleted': {
                const deletedId = message.sessionId;
                const isUserInitiated = this.sessionTabManager
                    && deletedId
                    && this.sessionTabManager.isUserDeletion(deletedId);
                if (isUserInitiated) {
                    this.sessionTabManager.clearUserDeletion(deletedId);
                } else {
                    this.showError(message.message);
                }
                this.currentClaudeSessionId = null;
                this.currentClaudeSessionName = null;
                this.updateSessionButton('Sessions');
                if (this.sessionTabManager && deletedId) {
                    this.sessionTabManager.closeSession(deletedId, { skipServerRequest: true });
                }
                this.loadSessions();
                break;
            }
                
            case 'pong':
                break;

            case 'image_upload_complete': {
                const { filePath } = message;
                const caption = this._pendingImageCaption || '';
                // Normalize path: forward slashes for cross-platform safety
                const normalizedPath = filePath.replace(/\\/g, '/');
                // Always quote the path to handle spaces
                const quotedPath = '"' + normalizedPath + '"';
                // Build input text
                const inputText = caption ? caption + ' ' + quotedPath : quotedPath;
                // Send as terminal input with bracketed paste wrapping
                let normalized = attachClipboardHandler.normalizeLineEndings(inputText);
                if (this.terminal && this.terminal.modes && this.terminal.modes.bracketedPasteMode) {
                    normalized = attachClipboardHandler.wrapBracketedPaste(normalized);
                }
                this.send({ type: 'input', data: normalized });
                this._pendingImageCaption = null;
                break;
            }

            case 'image_upload_error': {
                console.error('Image upload error:', message.message);
                // Write error to terminal as fallback notification
                if (this.terminal) {
                    this.terminal.write('\r\n\x1b[31m[Image upload error] ' + message.message + '\x1b[0m\r\n');
                }
                break;
            }

            case 'usage_update':
                this.updateUsageDisplay(
                    message.sessionStats, 
                    message.dailyStats, 
                    message.sessionTimer,
                    message.analytics,
                    message.burnRate,
                    message.plan,
                    message.limits
                );
                break;
                
            // Background session activity events (from broadcastSessionActivity)
            // These handlers must never touch this.terminal or this.showOverlay
            case 'session_activity':
                if (this.sessionTabManager && message.sessionId &&
                    message.sessionId !== this.currentClaudeSessionId) {
                    this.sessionTabManager.markSessionActivity(message.sessionId, true, '');
                }
                break;

            case 'session_exit':
                if (this.sessionTabManager && message.sessionId &&
                    message.sessionId !== this.currentClaudeSessionId) {
                    if (message.code !== 0) {
                        this.sessionTabManager.markSessionError(message.sessionId, true);
                    }
                    this.sessionTabManager.updateTabStatus(message.sessionId, 'idle');
                }
                this.loadSessions();
                break;

            case 'session_error':
                if (this.sessionTabManager && message.sessionId &&
                    message.sessionId !== this.currentClaudeSessionId) {
                    this.sessionTabManager.markSessionError(message.sessionId, true);
                }
                break;

            case 'session_started':
                if (this.sessionTabManager && message.sessionId &&
                    message.sessionId !== this.currentClaudeSessionId) {
                    this.sessionTabManager.updateTabStatus(message.sessionId, 'active');
                }
                this.loadSessions();
                break;

            case 'session_stopped':
                if (this.sessionTabManager && message.sessionId &&
                    message.sessionId !== this.currentClaudeSessionId) {
                    this.sessionTabManager.updateTabStatus(message.sessionId, 'idle');
                }
                this.loadSessions();
                break;

            // VS Code Tunnel events
            case 'vscode_tunnel_started':
            case 'vscode_tunnel_status':
            case 'vscode_tunnel_auth':
            case 'vscode_tunnel_error':
                if (this._vscodeTunnelUI) {
                    this._vscodeTunnelUI.handleMessage(message);
                } else if (window.VSCodeTunnelUI) {
                    this._vscodeTunnelUI = new window.VSCodeTunnelUI({ app: this });
                    this._vscodeTunnelUI.handleMessage(message);
                }
                break;

            // App-level tunnel events
            case 'app_tunnel_status':
            case 'app_tunnel_restarting':
                if (this._appTunnelUI) {
                    this._appTunnelUI.handleMessage(message);
                } else if (window.AppTunnelUI) {
                    this._appTunnelUI = new window.AppTunnelUI({ app: this });
                    this._appTunnelUI.handleMessage(message);
                }
                // Reset reconnect budget on tunnel restart
                if (message.type === 'app_tunnel_restarting') {
                    this.reconnectAttempts = 0;
                }
                break;

            // Voice input events
            case 'voice_transcription':
            case 'voice_transcription_error':
            case 'voice_model_progress':
            case 'voice_status':
                this._handleVoiceMessage(message);
                break;

            default:
                console.log('Unknown message type:', message.type);
        }
    }

    renderToolCards() {
        const container = document.getElementById('toolCards');
        if (!container) return;
        container.innerHTML = '';

        const toolMeta = {
            terminal: {
                icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
                gradient: 'linear-gradient(135deg, #52525b, #71717a)',
                desc: 'System shell (bash / powershell)',
            },
            claude: {
                icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>',
                gradient: 'linear-gradient(135deg, #d97706, #b45309)',
                desc: 'AI coding assistant by Anthropic',
            },
            codex: {
                icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
                gradient: 'linear-gradient(135deg, #059669, #047857)',
                desc: 'AI coding agent by OpenAI',
            },
            copilot: {
                icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="3"/><circle cx="15" cy="12" r="3"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/></svg>',
                gradient: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                desc: 'AI pair programmer by GitHub',
            },
            gemini: {
                icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C6.5 8 6.5 16 12 22c5.5-6 5.5-14 0-20z"/><path d="M2 12c6-5.5 14-5.5 20 0-6 5.5-14 5.5-20 0z"/></svg>',
                gradient: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                desc: 'AI coding assistant by Google',
            }
        };

        // Sort: terminal first, then available tools, then unavailable
        const sortedEntries = Object.entries(this.tools)
            .filter(([, tool]) => tool.alias)
            .sort((a, b) => {
                if (a[0] === 'terminal') return -1;
                if (b[0] === 'terminal') return 1;
                if (a[1].available && !b[1].available) return -1;
                if (!a[1].available && b[1].available) return 1;
                return 0;
            });

        let cardIndex = 0;
        let addedDivider = false;
        for (const [toolId, tool] of sortedEntries) {
            const meta = toolMeta[toolId] || {
                icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
                gradient: 'linear-gradient(135deg, #6b7280, #4b5563)',
                desc: '',
            };

            // Add divider between available and unavailable tools
            if (!tool.available && !addedDivider) {
                const hasAvailable = sortedEntries.some(([, t]) => t.available);
                if (hasAvailable) {
                    const divider = document.createElement('div');
                    divider.className = 'tool-cards-divider';
                    divider.innerHTML = '<span>More tools</span>';
                    container.appendChild(divider);
                    addedDivider = true;
                }
            }

            const isInstallable = !tool.available && toolId !== 'terminal';
            const card = document.createElement('div');
            card.className = 'tool-card' + (tool.available ? '' : (isInstallable ? ' installable' : ' disabled'));
            card.dataset.tool = toolId;
            card.style.animationDelay = `${cardIndex * 50}ms`;
            card.classList.add('tool-card-enter');

            // Escape alias to prevent XSS from server-provided config
            const safeAlias = (tool.alias || '').replace(/[&<>"']/g, c =>
                ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

            if (tool.available) {
                card.setAttribute('tabindex', '0');
                card.setAttribute('role', 'button');
                card.setAttribute('aria-label', `Start ${safeAlias} — ${meta.desc}`);
            } else if (isInstallable) {
                card.setAttribute('tabindex', '0');
                card.setAttribute('role', 'button');
                card.setAttribute('aria-expanded', 'false');
                card.setAttribute('aria-label', `${safeAlias} — Not installed. Click to see install options.`);
            } else {
                card.setAttribute('tabindex', '-1');
                card.setAttribute('role', 'button');
                card.setAttribute('aria-disabled', 'true');
                card.setAttribute('aria-label', `${safeAlias} — Not installed`);
            }

            const statusHtml = tool.available
                ? '<svg class="tool-card-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>'
                : `<span class="tool-card-status">Not installed${isInstallable ? ' <span class="expand-chevron">&#x25BE;</span>' : ''}</span>`;

            card.innerHTML = `
                <div class="tool-card-icon" style="background: ${meta.gradient}">${meta.icon}</div>
                <div class="tool-card-info">
                    <div class="tool-card-name">${safeAlias}</div>
                    <div class="tool-card-desc">${meta.desc}</div>
                </div>
                ${statusHtml}
            `;

            if (tool.available) {
                card.addEventListener('click', () => this.startToolSession(toolId));
                card.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.startToolSession(toolId);
                    }
                });
            } else if (isInstallable) {
                card.addEventListener('click', () => this.toggleInstallExpansion(toolId, card));
                card.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.toggleInstallExpansion(toolId, card);
                    }
                });
            }

            container.appendChild(card);

            // Create expansion panel (hidden by default)
            if (isInstallable) {
                const expansion = document.createElement('div');
                expansion.className = 'tool-card-expansion';
                expansion.id = `install-expansion-${toolId}`;
                container.appendChild(expansion);
            }

            cardIndex++;
        }
    }

    toggleInstallExpansion(toolId, card) {
        const expansion = document.getElementById(`install-expansion-${toolId}`);
        if (!expansion) return;

        const isExpanded = card.getAttribute('aria-expanded') === 'true';

        // Collapse any other expanded cards (accordion)
        document.querySelectorAll('.tool-card.installable[aria-expanded="true"]').forEach(otherCard => {
            if (otherCard !== card) {
                otherCard.setAttribute('aria-expanded', 'false');
                const otherId = otherCard.dataset.tool;
                const otherExpansion = document.getElementById(`install-expansion-${otherId}`);
                if (otherExpansion) otherExpansion.classList.remove('expanded');
            }
        });

        if (isExpanded) {
            card.setAttribute('aria-expanded', 'false');
            expansion.classList.remove('expanded');
        } else {
            card.setAttribute('aria-expanded', 'true');
            this.renderInstallExpansion(toolId, expansion);
            expansion.classList.add('expanded');
        }
    }

    renderInstallExpansion(toolId, container) {
        const tool = this.tools[toolId];
        const installInfo = tool && tool.install;
        const prereqs = this._configPrerequisites;

        if (!installInfo) {
            container.innerHTML = '<p style="color: var(--text-muted); font-size: var(--text-sm);">Install information unavailable.</p>';
            return;
        }

        let html = '';

        // Prerequisite warnings
        if (prereqs && !prereqs.npm.available) {
            const npmMethods = installInfo.methods.filter(m => m.requiresNpm);
            if (npmMethods.length > 0) {
                html += `<div class="install-prereq-warning">
                    <span>&#x26A0;</span>
                    <span>npm is not available. <a href="https://nodejs.org/" target="_blank" rel="noopener">Install Node.js</a> to enable npm-based installation.</span>
                </div>`;
            }
        } else if (prereqs && prereqs.npm.available && !prereqs.npm.userMode) {
            html += `<div class="install-prereq-warning">
                <span>&#x26A0;</span>
                <span>npm global installs may require admin. Run <code>npm config set prefix ~/.npm-global</code> first.</span>
            </div>`;
        }

        // Install methods
        for (const method of installInfo.methods) {
            if (method.command) {
                const escapedCmd = this._escapeHtml(method.command);
                html += `<div class="install-cmd-block">
                    <code>${escapedCmd}</code>
                    <button class="btn-copy" data-cmd="${escapedCmd}" title="Copy command">Copy</button>
                </div>`;
                if (method.note) {
                    html += `<div class="install-method-note">${this._escapeHtml(method.note)}</div>`;
                }
            } else if (method.url) {
                html += `<div class="install-cmd-block">
                    <code><a href="${this._escapeHtml(method.url)}" target="_blank" rel="noopener">${this._escapeHtml(method.label)}</a></code>
                    <button class="btn-copy" data-cmd="${this._escapeHtml(method.url)}" title="Copy URL">Copy</button>
                </div>`;
                if (method.note) {
                    html += `<div class="install-method-note">${this._escapeHtml(method.note)}</div>`;
                }
            }
        }

        // Auth steps
        if (installInfo.authSteps && installInfo.authSteps.length > 0) {
            html += '<div class="install-auth-steps"><div class="auth-label">After installing</div>';
            for (const step of installInfo.authSteps) {
                if (step.type === 'command') {
                    html += `<div class="install-auth-step">
                        <span>${this._escapeHtml(step.label)}:</span>
                        <code>${this._escapeHtml(step.command)}</code>
                    </div>`;
                } else if (step.type === 'url') {
                    html += `<div class="install-auth-step">
                        <a href="${this._escapeHtml(step.url)}" target="_blank" rel="noopener">${this._escapeHtml(step.label)}</a>
                    </div>`;
                } else if (step.type === 'env') {
                    html += `<div class="install-auth-step">
                        <span>${this._escapeHtml(step.label)}:</span>
                        <code>${this._escapeHtml(step.command || step.variable)}</code>
                    </div>`;
                } else if (step.type === 'info') {
                    html += `<div class="install-auth-step">
                        <span>${this._escapeHtml(step.label)}</span>
                    </div>`;
                }
            }
            html += '</div>';
        }

        // Action buttons
        const primaryMethod = installInfo.methods.find(m => m.command);
        html += '<div class="install-actions">';
        if (primaryMethod) {
            html += `<button class="btn-install-terminal" data-tool="${toolId}" data-method="${primaryMethod.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                Open Terminal
            </button>`;
        }
        html += `<button class="btn-verify" data-tool="${toolId}">Verify Install</button>`;
        html += '</div>';

        // Docs link
        if (installInfo.docsUrl) {
            html += `<div class="install-docs-link"><a href="${this._escapeHtml(installInfo.docsUrl)}" target="_blank" rel="noopener">Documentation &#x2197;</a></div>`;
        }

        container.innerHTML = html;

        // Wire up event handlers
        container.querySelectorAll('.btn-copy').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const cmd = btn.dataset.cmd;
                navigator.clipboard.writeText(cmd).then(() => {
                    btn.textContent = 'Copied!';
                    btn.classList.add('copied');
                    setTimeout(() => {
                        btn.textContent = 'Copy';
                        btn.classList.remove('copied');
                    }, 2000);
                });
            });
        });

        const terminalBtn = container.querySelector('.btn-install-terminal');
        if (terminalBtn) {
            terminalBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._pendingInstallToolId = toolId;
                this.send({
                    type: 'open_install_terminal',
                    toolId: toolId,
                    method: terminalBtn.dataset.method,
                    cols: this.terminal ? this.terminal.cols : 80,
                    rows: this.terminal ? this.terminal.rows : 24,
                });
            });
        }

        const verifyBtn = container.querySelector('.btn-verify');
        if (verifyBtn) {
            verifyBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                verifyBtn.textContent = 'Checking...';
                verifyBtn.disabled = true;
                try {
                    const resp = await fetch(`/api/tools/${toolId}/recheck`, { method: 'POST' });
                    const result = await resp.json();
                    if (result.available) {
                        verifyBtn.textContent = 'Installed!';
                        verifyBtn.classList.add('success');
                        // Refresh the config and re-render cards
                        setTimeout(() => this.refreshConfig(), 500);
                    } else {
                        verifyBtn.textContent = 'Not found';
                        setTimeout(() => {
                            verifyBtn.textContent = 'Verify Install';
                            verifyBtn.disabled = false;
                        }, 2000);
                    }
                } catch {
                    verifyBtn.textContent = 'Error';
                    setTimeout(() => {
                        verifyBtn.textContent = 'Verify Install';
                        verifyBtn.disabled = false;
                    }, 2000);
                }
            });
        }
    }

    async refreshConfig() {
        try {
            const resp = await this.authFetch('/api/config');
            const config = await resp.json();
            this.tools = config.tools || {};
            this.voiceInputConfig = config.voiceInput || null;
            this._configPrerequisites = config.prerequisites || null;
            this.renderToolCards();
        } catch {
            // Silently fail — config will refresh on next page load
        }
    }

    _escapeHtml(str) {
        return (str || '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    startToolSession(toolId) {
        if (!this.currentClaudeSessionId) {
            console.warn('[startToolSession] No active session, cannot start tool:', toolId);
            return;
        }
        this._toolStartPending = true;
        const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
        const dangerousMode = settings.dangerousMode || false;
        const options = {};
        if (dangerousMode && this.tools[toolId]?.hasDangerousMode) {
            options.dangerouslySkipPermissions = true;
        }
        this.showOverlay('loadingSpinner');
        const toolAlias = this.tools[toolId]?.alias || toolId;
        const loadingText = options.dangerouslySkipPermissions
            ? `Starting ${toolAlias} (skipping permissions)...`
            : `Starting ${toolAlias}...`;
        document.getElementById('loadingSpinner').querySelector('p').textContent = loadingText;

        // Safety net: dismiss spinner if server never responds
        if (this._startToolTimeout) clearTimeout(this._startToolTimeout);
        this._startToolTimeout = setTimeout(() => {
            const overlay = document.getElementById('overlay');
            const spinner = document.getElementById('loadingSpinner');
            if (overlay && overlay.style.display !== 'none' &&
                spinner && spinner.style.display !== 'none') {
                const toolCmd = toolId === 'terminal' ? 'shell' : toolId;
                this.showError(`${toolAlias} did not start within 45 seconds.\n\nTroubleshooting:\n\u2022 Check that ${toolAlias} CLI is installed (run '${toolCmd} --version')\n\u2022 Ensure it's in your PATH\n\u2022 Try restarting the session`);
            }
        }, 45000);

        this.send({
            type: `start_${toolId}`,
            options,
            cols: this.terminal ? this.terminal.cols : 80,
            rows: this.terminal ? this.terminal.rows : 24
        });
    }

    clearTerminal() {
        this.terminal.clear();
    }

    toggleMobileMenu() {
        const mobileMenu = document.getElementById('mobileMenu');
        const hamburgerBtn = document.getElementById('hamburgerBtn');
        mobileMenu.classList.toggle('active');
        hamburgerBtn.classList.toggle('active');
    }

    closeMobileMenu() {
        const mobileMenu = document.getElementById('mobileMenu');
        const hamburgerBtn = document.getElementById('hamburgerBtn');
        mobileMenu.classList.remove('active');
        hamburgerBtn.classList.remove('active');
    }

    _loadGpuRenderer() {
        if (this.isMobile) {
            console.log('[Renderer] Mobile detected, using Canvas renderer for reliability');
            this._loadCanvasAddon();
            return;
        }
        if (typeof WebglAddon !== 'undefined') {
            try {
                this.webglAddon = new WebglAddon.WebglAddon();
                this.webglAddon.onContextLoss(() => {
                    this.webglAddon.dispose();
                    this.webglAddon = null;
                    this._loadCanvasAddon();
                });
                this.terminal.loadAddon(this.webglAddon);
            } catch (e) {
                console.log('[Renderer] WebGL unavailable, using Canvas renderer');
                this._loadCanvasAddon();
            }
        } else {
            console.log('[Renderer] WebGL unavailable, using Canvas renderer');
            this._loadCanvasAddon();
        }
    }

    _loadCanvasAddon() {
        if (typeof CanvasAddon !== 'undefined') {
            try {
                this.canvasAddon = new CanvasAddon.CanvasAddon();
                this.terminal.loadAddon(this.canvasAddon);
            } catch (e) {
                console.log('[Renderer] Canvas unavailable, using DOM renderer (slower)');
            }
        } else {
            console.log('[Renderer] Canvas unavailable, using DOM renderer (slower)');
        }
    }

    fitTerminal() {
        if (this.fitAddon) {
            try {
                this.fitAddon.fit();

                // Subtract 2 rows for tab bar, 6 cols for scrollbar width
                const adjustedRows = Math.max(1, this.terminal.rows - 2);
                const adjustedCols = Math.max(1, this.terminal.cols - 6);
                if (adjustedRows !== this.terminal.rows || adjustedCols !== this.terminal.cols) {
                    this.terminal.resize(adjustedCols, adjustedRows);
                }

                // On mobile, ensure terminal doesn't exceed viewport width
                if (this.isMobile) {
                    const terminalElement = document.querySelector('.xterm');
                    if (terminalElement) {
                        const viewportWidth = window.innerWidth;
                        const currentWidth = terminalElement.offsetWidth;
                        
                        if (currentWidth > viewportWidth) {
                            // Reduce columns to fit viewport
                            const charWidth = currentWidth / this.terminal.cols;
                            const maxCols = Math.floor((viewportWidth - 20) / charWidth);
                            this.terminal.resize(maxCols, this.terminal.rows);
                        }
                    }
                }
            } catch (error) {
                console.error('Error fitting terminal:', error);
            }
        }
    }

    setupTerminalSearch() {
        const bar = document.getElementById('terminalSearchBar');
        const input = document.getElementById('termSearchInput');
        const countEl = document.getElementById('termSearchCount');
        const prevBtn = document.getElementById('termSearchPrev');
        const nextBtn = document.getElementById('termSearchNext');
        const caseBtn = document.getElementById('termSearchCase');
        const regexBtn = document.getElementById('termSearchRegex');
        const closeBtn = document.getElementById('termSearchClose');
        if (!bar || !input || !this.searchAddon) return;

        let caseSensitive = false;
        let useRegex = false;

        const doSearch = (direction = 'next') => {
            const query = input.value;
            if (!query) { countEl.textContent = ''; return; }
            const opts = { caseSensitive, regex: useRegex };
            if (direction === 'prev') {
                this.searchAddon.findPrevious(query, opts);
            } else {
                this.searchAddon.findNext(query, opts);
            }
        };

        const openSearch = () => {
            bar.style.display = 'flex';
            input.focus();
            input.select();
        };

        const closeSearch = () => {
            bar.style.display = 'none';
            input.value = '';
            countEl.textContent = '';
            this.searchAddon.clearDecorations();
            this.terminal.focus();
        };

        // Ctrl+F opens search (capture phase to intercept before xterm)
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                e.stopPropagation();
                openSearch();
            }
        }, true);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                doSearch(e.shiftKey ? 'prev' : 'next');
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
            }
        });

        input.addEventListener('input', () => doSearch('next'));
        prevBtn.addEventListener('click', () => doSearch('prev'));
        nextBtn.addEventListener('click', () => doSearch('next'));
        closeBtn.addEventListener('click', () => closeSearch());

        caseBtn.addEventListener('click', () => {
            caseSensitive = !caseSensitive;
            caseBtn.classList.toggle('active', caseSensitive);
            caseBtn.setAttribute('aria-pressed', String(caseSensitive));
            doSearch('next');
        });

        regexBtn.addEventListener('click', () => {
            useRegex = !useRegex;
            regexBtn.classList.toggle('active', useRegex);
            regexBtn.setAttribute('aria-pressed', String(useRegex));
            doSearch('next');
        });
    }

    setupTerminalContextMenu() {
        const menu = document.getElementById('termContextMenu');
        if (!menu) return;

        // Track which terminal triggered the context menu (supports split panes)
        let activeTerminal = null;
        let activeSendFn = null;
        let activeSocket = null;

        const menuItems = Array.from(menu.querySelectorAll('.ctx-item'));

        // Helper: get the terminal and sendFn for a right-click target
        const resolveTerminal = (target) => {
            // Check if click is inside a split pane terminal
            const splitPane = target.closest('.split-pane');
            if (splitPane && this.splitContainer) {
                const index = parseInt(splitPane.dataset.splitIndex, 10);
                const split = this.splitContainer.splits[index];
                if (split && split.terminal) {
                    return {
                        terminal: split.terminal,
                        socket: split.socket,
                        sendFn: (data) => {
                            if (split.socket && split.socket.readyState === WebSocket.OPEN) {
                                split.socket.send(JSON.stringify({ type: 'input', data }));
                            }
                        }
                    };
                }
            }
            // Default: main terminal
            return {
                terminal: this.terminal,
                socket: this.socket,
                sendFn: (data) => {
                    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                        this.send({ type: 'input', data });
                    }
                }
            };
        };

        // Helper: send paste data with line ending normalization + bracketed paste
        const sendPasteData = (text, sendFn, terminal) => {
            let normalized = attachClipboardHandler.normalizeLineEndings(text);
            if (terminal.modes && terminal.modes.bracketedPasteMode) {
                normalized = attachClipboardHandler.wrapBracketedPaste(normalized);
            }
            sendFn(normalized);
        };

        // Helper: show clipboard error toast
        const showClipboardError = () => {
            const toast = document.createElement('div');
            toast.className = 'clipboard-toast';
            toast.textContent = 'Clipboard access denied. Use Ctrl+V to paste.';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);
        };

        // Right-click handler — listen on <main> for event delegation (covers splits)
        const mainEl = document.querySelector('.main');
        mainEl.addEventListener('contextmenu', (e) => {
            // Only trigger on terminal areas (xterm elements)
            if (!e.target.closest('.xterm')) return;

            e.preventDefault();
            e.stopPropagation();

            const resolved = resolveTerminal(e.target);
            activeTerminal = resolved.terminal;
            activeSendFn = resolved.sendFn;
            activeSocket = resolved.socket;

            // Position menu at cursor, constrained to viewport
            const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
            const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
            menu.style.display = 'block';

            // Disable copy if no selection
            const copyItem = menu.querySelector('[data-action="copy"]');
            if (copyItem) {
                const hasSelection = activeTerminal.hasSelection();
                copyItem.classList.toggle('disabled', !hasSelection);
                copyItem.setAttribute('aria-disabled', !hasSelection);
            }

            // Disable "Paste Image" if clipboard.read() is not available
            const pasteImageItem = menu.querySelector('[data-action="pasteImage"]');
            if (pasteImageItem) {
                if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
                    pasteImageItem.classList.add('disabled');
                } else {
                    pasteImageItem.classList.remove('disabled');
                }
            }

            // Focus first non-disabled item for keyboard navigation
            const firstEnabled = menuItems.find(el => !el.classList.contains('disabled'));
            if (firstEnabled) firstEnabled.focus();
        });

        // Handle menu item clicks
        menu.addEventListener('click', async (e) => {
            const item = e.target.closest('.ctx-item');
            if (!item || item.classList.contains('disabled')) return;
            const action = item.dataset.action;
            if (!action) return;
            menu.style.display = 'none';

            switch (action) {
                case 'copy': {
                    const sel = activeTerminal.getSelection();
                    if (sel) {
                        try {
                            await navigator.clipboard.writeText(sel);
                            if (window.attachClipboardHandler?.showCopiedToast) {
                                window.attachClipboardHandler.showCopiedToast();
                            }
                        } catch { showClipboardError(); }
                    }
                    break;
                }
                case 'paste': {
                    try {
                        const text = await navigator.clipboard.readText();
                        if (text) sendPasteData(text, activeSendFn, activeTerminal);
                    } catch { showClipboardError(); }
                    break;
                }
                case 'pastePlain': {
                    try {
                        const text = await navigator.clipboard.readText();
                        if (text) sendPasteData(text, activeSendFn, activeTerminal);
                    } catch { showClipboardError(); }
                    break;
                }
                case 'pasteImage': {
                    const pasteSocket = activeSocket;
                    try {
                        if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
                            const items = await navigator.clipboard.read();
                            for (const item of items) {
                                const imageType = item.types.find(t =>
                                    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(t)
                                );
                                if (imageType) {
                                    const blob = await item.getType(imageType);
                                    window.imageHandler.showImagePreview(blob, (imageData) => {
                                        this._pendingImageCaption = imageData.caption;
                                        const msg = JSON.stringify({
                                            type: 'image_upload',
                                            base64: imageData.base64,
                                            mimeType: imageData.mimeType,
                                            fileName: imageData.fileName || 'pasted-image.png',
                                            caption: imageData.caption || ''
                                        });
                                        if (pasteSocket && pasteSocket.readyState === WebSocket.OPEN) {
                                            pasteSocket.send(msg);
                                        }
                                    });
                                    return;
                                }
                            }
                            // No image found
                            if (activeTerminal) {
                                activeTerminal.write('\r\n\x1b[33mNo image found in clipboard.\x1b[0m\r\n');
                            }
                        } else {
                            if (activeTerminal) {
                                activeTerminal.write('\r\n\x1b[33mImage paste requires HTTPS. Use Attach Image instead.\x1b[0m\r\n');
                            }
                        }
                    } catch (err) {
                        console.error('Paste Image failed:', err);
                    }
                    break;
                }
                case 'attachImage': {
                    const attachSocket = activeSocket;
                    if (window.imageHandler) {
                        window.imageHandler.triggerFilePicker((imageData) => {
                            this._pendingImageCaption = imageData.caption;
                            const msg = JSON.stringify({
                                type: 'image_upload',
                                base64: imageData.base64,
                                mimeType: imageData.mimeType,
                                fileName: imageData.fileName || 'attached-image.png',
                                caption: imageData.caption || ''
                            });
                            if (attachSocket && attachSocket.readyState === WebSocket.OPEN) {
                                attachSocket.send(msg);
                            }
                        });
                    }
                    break;
                }
                case 'selectAll':
                    activeTerminal.selectAll();
                    break;
                case 'clear':
                    activeTerminal.clear();
                    break;
            }
            if (activeTerminal) activeTerminal.focus();
        });

        // Keyboard navigation within menu
        menu.addEventListener('keydown', (e) => {
            const items = menuItems.filter(el => !el.classList.contains('disabled'));
            const currentIndex = items.indexOf(document.activeElement);

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    items[(currentIndex + 1) % items.length].focus();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    items[(currentIndex - 1 + items.length) % items.length].focus();
                    break;
                case 'Home':
                    e.preventDefault();
                    if (items.length) items[0].focus();
                    break;
                case 'End':
                    e.preventDefault();
                    if (items.length) items[items.length - 1].focus();
                    break;
                case 'Enter':
                case ' ':
                    e.preventDefault();
                    if (document.activeElement.classList.contains('ctx-item')) {
                        document.activeElement.click();
                    }
                    break;
                case 'Escape':
                case 'Tab':
                    e.preventDefault();
                    menu.style.display = 'none';
                    if (activeTerminal) activeTerminal.focus();
                    break;
            }
        });

        // Dismiss menu on click outside
        document.addEventListener('click', (e) => {
            if (!menu.contains(e.target)) menu.style.display = 'none';
        });
    }

    updateStatus(status) {
        console.log('Status:', status);
        const indicator = document.getElementById('connectionStatus');
        if (indicator) {
            const isConnected = status === 'Connected';
            const isReconnecting = status === 'Connecting...' || status === 'Reconnecting...';
            if (isConnected) {
                indicator.className = 'connection-status connected';
                indicator.title = 'Connected to server';
                indicator.setAttribute('aria-label', 'Connected to server');
            } else if (isReconnecting) {
                indicator.className = 'connection-status reconnecting';
                indicator.title = 'Reconnecting...';
                indicator.setAttribute('aria-label', 'Reconnecting to server');
            } else {
                indicator.className = 'connection-status disconnected';
                indicator.title = 'Disconnected';
                indicator.setAttribute('aria-label', 'Disconnected from server');
            }
        }
        const srAnnounce = document.getElementById('srAnnounce');
        if (srAnnounce) srAnnounce.textContent = status;
    }

    updateWorkingDir(dir) {
        // Working dir display removed with header - shown in tab titles
        console.log('Working directory:', dir);
    }

    showOverlay(contentId) {
        const overlay = document.getElementById('overlay');
        const contents = ['loadingSpinner', 'startPrompt', 'errorMessage'];
        
        contents.forEach(id => {
            document.getElementById(id).style.display = id === contentId ? 'block' : 'none';
        });
        
        overlay.style.display = 'flex';
    }

    hideOverlay() {
        const overlay = document.getElementById('overlay');
        if (overlay) {
            console.log('[hideOverlay] Hiding overlay, current display:', overlay.style.display);
            overlay.style.display = 'none';
            console.log('[hideOverlay] Overlay hidden, new display:', overlay.style.display);
        } else {
            console.error('[hideOverlay] Overlay element not found!');
        }
    }

    hideModal(overlayId) {
        const overlay = document.getElementById(overlayId);
        if (!overlay) return;
        if (window.focusTrap) window.focusTrap.deactivate();
        const content = overlay.querySelector('.modal-content');
        if (content) {
            content.classList.add('closing');
            overlay.classList.add('closing');
            setTimeout(() => {
                content.classList.remove('closing');
                overlay.classList.remove('closing');
                overlay.classList.remove('active');
                overlay.style.display = 'none';
            }, 150);
        } else {
            overlay.classList.remove('active');
            overlay.style.display = 'none';
        }
    }

    showError(message) {
        const errorText = document.getElementById('errorText');
        errorText.style.whiteSpace = 'pre-line';
        errorText.textContent = message;
        const srAnnounce = document.getElementById('srAnnounce');
        if (srAnnounce) srAnnounce.textContent = message;
        this.showOverlay('errorMessage');
    }

    showSettings() {
        const modal = document.getElementById('settingsModal');
        modal.classList.add('active');

        // Prevent body scroll on mobile when modal is open
        if (this.isMobile) {
            document.body.style.overflow = 'hidden';
        }

        this._populateSettingsForm(this.loadSettings());
        if (window.focusTrap) window.focusTrap.activate(modal);
    }

    _populateSettingsForm(settings) {
        document.getElementById('fontSize').value = settings.fontSize;
        document.getElementById('fontSizeValue').textContent = settings.fontSize + 'px';
        const themeSelect = document.getElementById('themeSelect');
        if (themeSelect) themeSelect.value = settings.theme || 'midnight';
        const fontFamily = document.getElementById('fontFamily');
        if (fontFamily) fontFamily.value = settings.fontFamily || "'MesloLGS Nerd Font', 'Meslo Nerd Font', monospace";
        const cursorStyle = document.getElementById('cursorStyle');
        if (cursorStyle) cursorStyle.value = settings.cursorStyle || 'block';
        const cursorBlink = document.getElementById('cursorBlink');
        if (cursorBlink) cursorBlink.checked = settings.cursorBlink ?? true;
        const scrollback = document.getElementById('scrollback');
        if (scrollback) scrollback.value = String(settings.scrollback || 1000);
        const terminalPadding = document.getElementById('terminalPadding');
        if (terminalPadding) terminalPadding.value = String(settings.terminalPadding ?? 8);
        const terminalPaddingValue = document.getElementById('terminalPaddingValue');
        if (terminalPaddingValue) terminalPaddingValue.textContent = (settings.terminalPadding ?? 8) + 'px';
        document.getElementById('showTokenStats').checked = settings.showTokenStats;
        document.getElementById('dangerousMode').checked = settings.dangerousMode || false;

        // Voice settings
        const voiceRecordingMode = document.getElementById('voiceRecordingMode');
        if (voiceRecordingMode) voiceRecordingMode.value = settings.voiceRecordingMode || 'push-to-talk';
        const voiceMethod = document.getElementById('voiceMethod');
        if (voiceMethod) voiceMethod.value = settings.voiceMethod || 'auto';
        const micSounds = document.getElementById('micSounds');
        if (micSounds) micSounds.checked = settings.micSounds ?? true;

        // Notification settings
        const notifSound = document.getElementById('notifSound');
        if (notifSound) notifSound.checked = settings.notifSound ?? true;
        const notifVolume = document.getElementById('notifVolume');
        if (notifVolume) notifVolume.value = String(settings.notifVolume ?? 30);
        const notifVolumeValue = document.getElementById('notifVolumeValue');
        if (notifVolumeValue) notifVolumeValue.textContent = (settings.notifVolume ?? 30) + '%';
        const notifDesktop = document.getElementById('notifDesktop');
        if (notifDesktop) notifDesktop.checked = settings.notifDesktop ?? true;
    }

    hideSettings() {
        this.hideModal('settingsModal');

        // Restore body scroll
        if (this.isMobile) {
            document.body.style.overflow = '';
        }
    }

    _getDefaultSettings() {
        return {
            fontSize: 14,
            fontFamily: "'MesloLGS Nerd Font', 'MesloLGS NF', 'Meslo Nerd Font', monospace",
            cursorStyle: 'block',
            cursorBlink: true,
            scrollback: 1000,
            terminalPadding: 8,
            showTokenStats: true,
            theme: 'midnight',
            dangerousMode: false,
            voiceRecordingMode: 'push-to-talk',
            voiceMethod: 'auto',
            micSounds: true,
            notifSound: true,
            notifVolume: 30,
            notifDesktop: true
        };
    }

    loadSettings() {
        const defaults = this._getDefaultSettings();

        try {
            const saved = localStorage.getItem('cc-web-settings');
            if (!saved) return defaults;
            const settings = { ...defaults, ...JSON.parse(saved) };
            // Migrate old fontFamily values that lack MesloLGS Nerd Font fallback
            if (settings.fontFamily && !settings.fontFamily.includes('MesloLGS Nerd Font')) {
                settings.fontFamily = settings.fontFamily.replace(
                    /,\s*monospace\s*$/,
                    ", 'MesloLGS Nerd Font', monospace"
                );
            }
            return settings;
        } catch (error) {
            console.error('Failed to load settings:', error);
            return defaults;
        }
    }

    saveSettings() {
        const settings = {
            fontSize: parseInt(document.getElementById('fontSize').value),
            fontFamily: document.getElementById('fontFamily')?.value || "'MesloLGS Nerd Font', 'MesloLGS NF', 'Meslo Nerd Font', monospace",
            cursorStyle: document.getElementById('cursorStyle')?.value || 'block',
            cursorBlink: document.getElementById('cursorBlink')?.checked ?? true,
            scrollback: parseInt(document.getElementById('scrollback')?.value || '1000'),
            terminalPadding: parseInt(document.getElementById('terminalPadding')?.value || '8'),
            showTokenStats: document.getElementById('showTokenStats').checked,
            theme: (document.getElementById('themeSelect')?.value) || 'midnight',
            dangerousMode: document.getElementById('dangerousMode').checked,
            voiceRecordingMode: document.getElementById('voiceRecordingMode')?.value || 'push-to-talk',
            voiceMethod: document.getElementById('voiceMethod')?.value || 'auto',
            micSounds: document.getElementById('micSounds')?.checked ?? true,
            notifSound: document.getElementById('notifSound')?.checked ?? true,
            notifVolume: parseInt(document.getElementById('notifVolume')?.value || '30'),
            notifDesktop: document.getElementById('notifDesktop')?.checked ?? true
        };

        try {
            localStorage.setItem('cc-web-settings', JSON.stringify(settings));
            this.applySettings(settings);

            // Flash save button green briefly
            const saveBtn = document.getElementById('saveSettingsBtn');
            if (saveBtn) {
                const origText = saveBtn.textContent;
                saveBtn.classList.add('btn-save-success');
                saveBtn.textContent = '\u2713 Saved';
                setTimeout(() => {
                    saveBtn.classList.remove('btn-save-success');
                    saveBtn.textContent = origText;
                    this.hideSettings();
                }, 1500);
            } else {
                this.hideSettings();
            }
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
    }

    resetSettings() {
        const defaults = this._getDefaultSettings();
        localStorage.removeItem('cc-web-settings');
        this._populateSettingsForm(defaults);
        this.applySettings(defaults);
    }

    applySettings(settings) {
        // Apply theme — 'midnight' is default (no attribute), others set data-theme
        if (settings.theme && settings.theme !== 'midnight') {
            document.documentElement.setAttribute('data-theme', settings.theme);
        } else {
            document.documentElement.removeAttribute('data-theme');
        }

        // Apply terminal settings
        this.terminal.options.fontSize = settings.fontSize;
        if (settings.fontFamily) this.terminal.options.fontFamily = settings.fontFamily;
        if (settings.cursorStyle) this.terminal.options.cursorStyle = settings.cursorStyle;
        this.terminal.options.cursorBlink = settings.cursorBlink ?? true;
        if (settings.scrollback) this.terminal.options.scrollback = settings.scrollback;

        // Apply terminal padding
        const terminalEl = document.getElementById('terminal');
        if (terminalEl) {
            terminalEl.style.padding = (settings.terminalPadding ?? 8) + 'px';
        }

        // Apply voice recording mode
        if (this.voiceController) {
            if (settings.voiceRecordingMode) {
                this.voiceController._forcedMode = settings.voiceRecordingMode;
            }
            // Apply voice method preference
            if (settings.voiceMethod && settings.voiceMethod !== 'auto') {
                const localReady = this.voiceInputConfig && this.voiceInputConfig.localStatus === 'ready';
                const cloudAvailable = typeof window !== 'undefined' &&
                    !!(window.SpeechRecognition || window.webkitSpeechRecognition);
                if (settings.voiceMethod === 'local' && localReady) {
                    this.voiceMode = 'local';
                    this.voiceController.setMode('local');
                } else if (settings.voiceMethod === 'cloud' && cloudAvailable) {
                    this.voiceMode = 'cloud';
                    this.voiceController.setMode('cloud');
                }
            }
        }

        this.syncTerminalTheme();
    }

    syncTerminalTheme() {
        const style = getComputedStyle(document.documentElement);
        this.terminal.options.theme = {
            background: style.getPropertyValue('--terminal-bg').trim() || style.getPropertyValue('--surface-primary').trim(),
            foreground: style.getPropertyValue('--terminal-fg').trim() || style.getPropertyValue('--text-primary').trim(),
            cursor: style.getPropertyValue('--terminal-cursor').trim() || style.getPropertyValue('--accent-default').trim(),
            selectionBackground: style.getPropertyValue('--terminal-selection').trim() || undefined,
        };

        this.terminal.clearTextureAtlas();
        this.fitTerminal();
    }

    startHeartbeat() {
        setInterval(() => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.send({ type: 'ping' });
            }
        }, 30000);
    }

    // File Browser Methods
    toggleFileBrowser() {
        if (!this._fileBrowserPanel && window.fileBrowser) {
            this._fileBrowserPanel = new window.fileBrowser.FileBrowserPanel({
                app: this,
                authFetch: (url, opts) => this.authFetch(url, opts),
                initialPath: this.getCurrentWorkingDir(),
            });
        }
        if (this._fileBrowserPanel) {
            this._fileBrowserPanel.toggle();
        }
    }

    // VS Code Tunnel Methods
    toggleVSCodeTunnel() {
        if (!this._vscodeTunnelUI && window.VSCodeTunnelUI) {
            this._vscodeTunnelUI = new window.VSCodeTunnelUI({ app: this });
        }
        if (this._vscodeTunnelUI) {
            this._vscodeTunnelUI.toggle();
        }
    }

    stopVSCodeTunnel() {
        if (this._vscodeTunnelUI) {
            this._vscodeTunnelUI.stop();
        }
    }

    copyVSCodeTunnelUrl() {
        if (this._vscodeTunnelUI) {
            this._vscodeTunnelUI.copyUrl();
        }
    }

    // App Tunnel Methods
    toggleAppTunnel() {
        if (!this._appTunnelUI && window.AppTunnelUI) {
            this._appTunnelUI = new window.AppTunnelUI({ app: this });
        }
        if (this._appTunnelUI) {
            this._appTunnelUI.toggle();
        }
    }

    restartAppTunnel() {
        if (!this._appTunnelUI && window.AppTunnelUI) {
            this._appTunnelUI = new window.AppTunnelUI({ app: this });
        }
        if (this._appTunnelUI) {
            this._appTunnelUI.restart();
        }
    }

    openFileInViewer(filePath) {
        if (!this._fileBrowserPanel && window.fileBrowser) {
            this._fileBrowserPanel = new window.fileBrowser.FileBrowserPanel({
                app: this,
                authFetch: (url, opts) => this.authFetch(url, opts),
                initialPath: this.getCurrentWorkingDir(),
            });
        }
        if (this._fileBrowserPanel) {
            this._fileBrowserPanel.openToFile(filePath);
        }
    }

    getCurrentWorkingDir() {
        // Return the working directory of the active session, or the base folder
        if (this.currentClaudeSessionId && this.claudeSessions) {
            const session = this.claudeSessions.find(s => s.id === this.currentClaudeSessionId);
            if (session && session.workingDir) return session.workingDir;
        }
        return this.currentFolderPath || null;
    }

    // Folder Browser Methods
    setupFolderBrowser() {
        const modal = document.getElementById('folderBrowserModal');
        const upBtn = document.getElementById('folderUpBtn');
        const homeBtn = document.getElementById('folderHomeBtn');
        const selectBtn = document.getElementById('selectFolderBtn');
        const cancelBtn = document.getElementById('cancelFolderBtn');
        const showHiddenCheckbox = document.getElementById('showHiddenFolders');
        const createFolderBtn = document.getElementById('createFolderBtn');
        const confirmCreateBtn = document.getElementById('confirmCreateFolderBtn');
        const cancelCreateBtn = document.getElementById('cancelCreateFolderBtn');
        const newFolderInput = document.getElementById('newFolderNameInput');
        
        upBtn.addEventListener('click', () => this.navigateToParent());
        homeBtn.addEventListener('click', () => this.navigateToHome());
        selectBtn.addEventListener('click', () => this.selectCurrentFolder());
        cancelBtn.addEventListener('click', () => this.closeFolderBrowser());
        showHiddenCheckbox.addEventListener('change', () => this.loadFolders(this.currentFolderPath));
        createFolderBtn.addEventListener('click', () => this.showCreateFolderInput());
        confirmCreateBtn.addEventListener('click', () => this.createFolder());
        cancelCreateBtn.addEventListener('click', () => this.hideCreateFolderInput());
        
        // Allow Enter key to create folder
        newFolderInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.createFolder();
            } else if (e.key === 'Escape') {
                this.hideCreateFolderInput();
            }
        });
        
        // Close modal when clicking outside
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.closeFolderBrowser();
            }
        });
    }

    async showFolderBrowser() {
        const modal = document.getElementById('folderBrowserModal');
        modal.classList.add('active');

        // Prevent body scroll on mobile when modal is open
        if (this.isMobile) {
            document.body.style.overflow = 'hidden';
        }

        // Load home directory by default
        await this.loadFolders();
        if (window.focusTrap) window.focusTrap.activate(modal);
    }

    closeFolderBrowser() {
        this.hideModal('folderBrowserModal');
        
        // Restore body scroll
        if (this.isMobile) {
            document.body.style.overflow = '';
        }
        
        // Reset the creating new session flag if canceling
        this.isCreatingNewSession = false;
        
        // If no folder selected, show error
        if (!this.currentFolderPath) {
            this.showError('You must select a folder to continue');
        }
    }

    async loadFolders(path = null) {
        const showHidden = document.getElementById('showHiddenFolders').checked;
        const params = new URLSearchParams();
        if (path) params.append('path', path);
        if (showHidden) params.append('showHidden', 'true');
        
        try {
            const response = await this.authFetch(`/api/folders?${params}`);
            if (!response.ok) {
                // Handle 401 specifically - show auth prompt
                if (response.status === 401) {
                    console.log('Authentication required - showing login prompt');
                    window.authManager.showLoginPrompt();
                    return;
                }
                const error = await response.json();
                throw new Error(error.message || 'Failed to load folders');
            }
            
            const data = await response.json();
            this.currentFolderPath = data.currentPath;
            this.renderFolders(data);
        } catch (error) {
            console.error('Failed to load folders:', error);
            this.showError(`Failed to load folders: ${error.message}`);
        }
    }

    renderFolders(data) {
        const pathInput = document.getElementById('currentPathInput');
        const folderList = document.getElementById('folderList');
        const upBtn = document.getElementById('folderUpBtn');
        
        // Update path display
        pathInput.value = data.currentPath;
        
        // Enable/disable up button
        upBtn.disabled = !data.parentPath;
        
        // Clear and populate folder list
        folderList.innerHTML = '';
        
        if (data.folders.length === 0) {
            folderList.innerHTML = '<div class="empty-folder-message">No folders found</div>';
            return;
        }
        
        data.folders.forEach(folder => {
            const folderItem = document.createElement('div');
            folderItem.className = 'folder-item';
            folderItem.innerHTML = `
                <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span class="folder-name">${folder.name}</span>
            `;
            folderItem.addEventListener('click', () => this.loadFolders(folder.path));
            folderList.appendChild(folderItem);
        });
    }

    async navigateToParent() {
        if (this.currentFolderPath) {
            const parentPath = this.currentFolderPath.split('/').slice(0, -1).join('/') || '/';
            await this.loadFolders(parentPath);
        }
    }

    async navigateToHome() {
        await this.loadFolders();
    }

    showCreateFolderInput() {
        const createBar = document.getElementById('folderCreateBar');
        const input = document.getElementById('newFolderNameInput');
        createBar.style.display = 'flex';
        input.value = '';
        input.focus();
    }

    hideCreateFolderInput() {
        const createBar = document.getElementById('folderCreateBar');
        const input = document.getElementById('newFolderNameInput');
        createBar.style.display = 'none';
        input.value = '';
    }

    async createFolder() {
        const input = document.getElementById('newFolderNameInput');
        const folderName = input.value.trim();
        
        if (!folderName) {
            this.showError('Please enter a folder name');
            return;
        }
        
        if (folderName.includes('/') || folderName.includes('\\')) {
            this.showError('Folder name cannot contain path separators');
            return;
        }
        
        try {
            const response = await this.authFetch('/api/create-folder', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    parentPath: this.currentFolderPath || '/',
                    folderName: folderName
                })
            });
            
            if (!response.ok) {
                // Handle 401 specifically - show auth prompt
                if (response.status === 401) {
                    console.log('Authentication required - showing login prompt');
                    window.authManager.showLoginPrompt();
                    return;
                }
                const error = await response.json();
                throw new Error(error.message || 'Failed to create folder');
            }
            
            // Hide the input and reload the folder list
            this.hideCreateFolderInput();
            await this.loadFolders(this.currentFolderPath);
        } catch (error) {
            console.error('Failed to create folder:', error);
            this.showError(`Failed to create folder: ${error.message}`);
        }
    }

    async selectCurrentFolder() {
        if (!this.currentFolderPath) {
            this.showError('No folder selected');
            return;
        }
        
        // Store the selected working directory
        this.selectedWorkingDir = this.currentFolderPath;
        
        // If not connected yet, connect first with the selected directory
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            try {
                // Set the working directory on the server
                const response = await this.authFetch('/api/folders/select', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ path: this.currentFolderPath })
                });
                
                if (!response.ok) throw new Error('Failed to set working directory');
                
                const data = await response.json();
                this.selectedWorkingDir = data.workingDir;
                
                // Update UI - working dir now shown in tab titles
                
                // Close folder browser
                this.closeFolderBrowser();
                
                // Connect to the server
                await this.connect();
                
                // Show new session modal with folder name pre-filled
                this.showNewSessionModal();
                const folderName = this.selectedWorkingDir.split('/').pop() || 'Session';
                document.getElementById('sessionName').value = folderName;
                document.getElementById('sessionWorkingDir').value = this.selectedWorkingDir;
                return;
            } catch (error) {
                console.error('Failed to set working directory:', error);
                this.showError('Failed to set working directory.\n\n\u2022 The folder may not exist or be inaccessible\n\u2022 Try selecting a different folder');
                return;
            }
        }
        
        // If we're creating a new session (either no active session OR explicitly creating new)
        if (!this.currentClaudeSessionId || this.isCreatingNewSession) {
            this.closeFolderBrowser();
            this.showNewSessionModal();
            // Pre-fill the session name with folder name and working directory
            const folderName = this.currentFolderPath.split('/').pop() || 'Session';
            document.getElementById('sessionName').value = folderName;
            document.getElementById('sessionWorkingDir').value = this.currentFolderPath;
            this.isCreatingNewSession = false; // Reset the flag
            return;
        }
        
        // Otherwise, set working directory for current session
        try {
            const response = await this.authFetch('/api/set-working-dir', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ path: this.currentFolderPath })
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to set working directory');
            }
            
            const result = await response.json();
            console.log('Working directory set to:', result.workingDir);
            
            // Close folder browser and connect
            this.closeFolderBrowser();
            await this.connect();
        } catch (error) {
            console.error('Failed to set working directory:', error);
            this.showError(`Failed to set working directory: ${error.message}`);
        }
    }
    
    async closeSession() {
        try {
            // Send close session message via WebSocket if connected
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.send({ type: 'close_session' });
            }
            
            // Clear the working directory on the server
            const response = await this.authFetch('/api/close-session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to close session');
            }
            
            // Reset the local state
            this.selectedWorkingDir = null;
            this.currentFolderPath = null;
            
            // Hide the close session button
            // Close session buttons removed with header
            
            // Disconnect WebSocket
            this.disconnect();
            
            // Clear terminal
            this.clearTerminal();
            
            // Show folder browser again
            this.showFolderBrowser();
            
        } catch (error) {
            console.error('Failed to close session:', error);
            this.showError(`Failed to close session: ${error.message}`);
        }
    }

    // Session Management Methods
    toggleSessionDropdown() {
        // Session dropdown removed with header - using tabs instead
    }
    
    showMobileSessionsModal() {
        const modal = document.getElementById('mobileSessionsModal');
        modal.classList.add('active');

        // Prevent body scroll on mobile when modal is open
        if (this.isMobile) {
            document.body.style.overflow = 'hidden';
        }

        this.loadMobileSessions();
        if (window.focusTrap) window.focusTrap.activate(modal);
    }
    
    hideMobileSessionsModal() {
        this.hideModal('mobileSessionsModal');

        // Restore body scroll
        if (this.isMobile) {
            document.body.style.overflow = '';
        }
    }
    
    async loadMobileSessions() {
        try {
            const response = await this.authFetch('/api/sessions/list');
            if (!response.ok) throw new Error('Failed to load sessions');
            
            const data = await response.json();
            this.claudeSessions = data.sessions;
            this.renderMobileSessionList();
        } catch (error) {
            console.error('Failed to load sessions:', error);
        }
    }
    
    renderMobileSessionList() {
        const sessionList = document.getElementById('mobileSessionList');
        sessionList.innerHTML = '';
        
        if (this.claudeSessions.length === 0) {
            sessionList.innerHTML = '<div class="no-sessions">No active sessions</div>';
            return;
        }
        
        this.claudeSessions.forEach(session => {
            const sessionItem = document.createElement('div');
            sessionItem.className = 'session-item';
            if (session.id === this.currentClaudeSessionId) {
                sessionItem.classList.add('active');
            }
            
            const statusIcon = `<span class="dot ${session.active ? 'dot-on' : 'dot-idle'}" aria-hidden="true"></span><span class="sr-only">${session.active ? 'Active' : 'Idle'}</span>`;
            const clientsText = session.connectedClients === 1 ? '1 client' : `${session.connectedClients} clients`;

            sessionItem.innerHTML = `
                <div class="session-info">
                    <span class="session-status">${statusIcon}</span>
                    <div class="session-details">
                        <div class="session-name">${this._escapeHtml(session.name)}</div>
                        <div class="session-meta">${clientsText} • ${new Date(session.created).toLocaleTimeString()}</div>
                        ${session.workingDir ? `<div class=\"session-folder\" title=\"${this._escapeHtml(session.workingDir)}\"><span class=\"icon\" aria-hidden=\"true\">${window.icons?.folder?.(14) || ''}</span> ${this._escapeHtml(session.workingDir.split('/').pop() || '/')}</div>` : ''}
                    </div>
                </div>
                <div class="session-actions">
                    ${session.id === this.currentClaudeSessionId ? 
                        '<button class="btn-icon" title="Leave session" data-action="leave"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></button>' :
                        '<button class="btn-icon" title="Join session" data-action="join"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg></button>'
                    }
                    <button class="btn-icon" title="Delete session" data-action="delete">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            `;
            
            sessionItem.querySelectorAll('button').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const action = btn.dataset.action;
                    if (action === 'join') {
                        this.joinSession(session.id);
                        this.hideMobileSessionsModal();
                    } else if (action === 'leave') {
                        this.leaveSession(session.id);
                        this.hideMobileSessionsModal();
                    } else if (action === 'delete') {
                        if (confirm(`Delete session "${(session.name || '').replace(/[<>"]/g, '')}"?`)) {
                            this.deleteSession(session.id);
                        }
                    }
                });
            });
            
            sessionList.appendChild(sessionItem);
        });
    }
    
    async loadSessions() {
        try {
            const response = await this.authFetch('/api/sessions/list');
            if (!response.ok) throw new Error('Failed to load sessions');
            
            const data = await response.json();
            this.claudeSessions = data.sessions;
            this.renderSessionList();
        } catch (error) {
            console.error('Failed to load sessions:', error);
        }
    }
    
    renderSessionList() {
        // This method is deprecated - sessions are now displayed as tabs
        // The sessionList element no longer exists as we use tabs instead
        // Keeping empty method to avoid errors from old code references
        return;
    }
    
    handleSessionAction(action, sessionId) {
        switch (action) {
            case 'join':
                this.joinSession(sessionId);
                break;
            case 'leave':
                this.leaveSession();
                break;
            case 'delete':
                this.deleteSession(sessionId);
                break;
        }
    }
    
    _cleanupVoiceState() {
        // Cancel any active recording and clear processing state on session switch
        if (this.voiceController && this.voiceController.isRecording) {
            this.voiceController.cancelRecording();
        }
        // Clear processing spinner and transcription timeout
        var btn = document.getElementById('voiceInputBtn');
        if (btn) {
            btn.classList.remove('recording', 'processing');
            btn.setAttribute('aria-pressed', 'false');
            btn.title = 'Voice Input (Ctrl+Shift+M)';
        }
        var timerEl = btn ? btn.querySelector('.voice-timer') : null;
        if (timerEl) timerEl.style.display = 'none';
        if (this._voiceTimerInterval) {
            clearInterval(this._voiceTimerInterval);
            this._voiceTimerInterval = null;
        }
        if (this._voiceTranscriptionTimeout) {
            clearTimeout(this._voiceTranscriptionTimeout);
            this._voiceTranscriptionTimeout = null;
        }
    }

    async joinSession(sessionId) {
        // Clean up any active voice state before switching sessions
        this._cleanupVoiceState();

        // Ensure we're connected first
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            // Check if we're already connecting (readyState === 0 means CONNECTING)
            if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
                // Wait for existing connection to complete
                await new Promise((resolve) => {
                    const checkConnection = setInterval(() => {
                        if (this.socket.readyState === WebSocket.OPEN) {
                            clearInterval(checkConnection);
                            resolve();
                        }
                    }, 50);
                    // Timeout after 5 seconds
                    setTimeout(() => {
                        clearInterval(checkConnection);
                        resolve();
                    }, 5000);
                });
            } else {
                // No socket or socket is closed, create new connection
                await this.connect();
                // Wait a bit for connection to establish
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        // Create a promise that resolves when we receive session_joined message
        return new Promise((resolve) => {
            // Store the resolve function to call when we get the response
            this.pendingJoinResolve = resolve;
            this.pendingJoinSessionId = sessionId;
            
            // Send the join request
            this.send({ type: 'join_session', sessionId });

            // Signal session priority — joined session is foreground, others background
            this.sendSessionPriority(sessionId);

            // Request usage stats when joining a session
            this.requestUsageStats();
            
            // Set a timeout in case the response never comes
            setTimeout(() => {
                if (this.pendingJoinResolve) {
                    this.pendingJoinResolve = null;
                    this.pendingJoinSessionId = null;
                    resolve(); // Resolve anyway after timeout
                }
            }, 2000);
        });
    }
    
    leaveSession() {
        this.send({ type: 'leave_session' });
        // Session dropdown removed - using tabs
    }

    sendSessionPriority(foregroundSessionId) {
        if (!this.sessionTabManager) return;
        const allTabs = this.sessionTabManager.tabs || new Map();
        const sessions = [];
        // Collect visible split pane session IDs
        const splitSessionIds = new Set();
        if (this.splitContainer && this.splitContainer.splits) {
            this.splitContainer.splits.forEach(split => {
                if (split.sessionId) splitSessionIds.add(split.sessionId);
            });
        }
        allTabs.forEach((_, sid) => {
            const isForeground = sid === foregroundSessionId || splitSessionIds.has(sid);
            sessions.push({ sessionId: sid, priority: isForeground ? 'foreground' : 'background' });
        });
        if (sessions.length > 0) {
            this.send({ type: 'set_priority', sessions });
        }
    }
    
    async deleteSession(sessionId) {
        if (!confirm('Are you sure you want to delete this session? This will stop any running Claude process.')) {
            return;
        }
        
        try {
            const response = await this.authFetch(`/api/sessions/${sessionId}`, {
                method: 'DELETE'
            });
            
            if (!response.ok) throw new Error('Failed to delete session');
            
            this.loadSessions();
            
            if (sessionId === this.currentClaudeSessionId) {
                this.currentClaudeSessionId = null;
                this.currentClaudeSessionName = null;
                this.updateSessionButton('Sessions');
                this.terminal.clear();
                this.showOverlay('startPrompt');
            }
        } catch (error) {
            console.error('Failed to delete session:', error);
            this.showError('Failed to delete session.\n\n\u2022 The session may have already been removed\n\u2022 Try refreshing the page');
        }
    }
    
    updateSessionButton(text) {
        // Session button removed with header - using tabs instead
        console.log('Session:', text);
    }
    
    setupNewSessionModal() {
        const modal = document.getElementById('newSessionModal');
        const closeBtn = document.getElementById('closeNewSessionBtn');
        const cancelBtn = document.getElementById('cancelNewSessionBtn');
        const createBtn = document.getElementById('createSessionBtn');
        const nameInput = document.getElementById('sessionName');
        const dirInput = document.getElementById('sessionWorkingDir');
        
        closeBtn.addEventListener('click', () => this.hideNewSessionModal());
        cancelBtn.addEventListener('click', () => this.hideNewSessionModal());
        createBtn.addEventListener('click', () => this.createNewSession());
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.hideNewSessionModal();
            }
        });
        
        // Allow Enter key to create session
        [nameInput, dirInput].forEach(input => {
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.createNewSession();
                }
            });
        });
    }
    
    setupMobileSessionsModal() {
        const closeMobileSessionsBtn = document.getElementById('closeMobileSessionsModal');
        const newSessionBtnMobile = document.getElementById('newSessionBtnMobile');
        
        if (closeMobileSessionsBtn) {
            closeMobileSessionsBtn.addEventListener('click', () => this.hideMobileSessionsModal());
        }
        if (newSessionBtnMobile) {
            newSessionBtnMobile.addEventListener('click', () => {
                this.hideMobileSessionsModal();
                // Show folder picker for new session
                this.isCreatingNewSession = true;
                this.selectedWorkingDir = null;
                this.currentFolderPath = null;
                this.showFolderBrowser();
            });
        }
    }
    
    showNewSessionModal() {
        const modal = document.getElementById('newSessionModal');
        modal.classList.add('active');

        // Prevent body scroll on mobile when modal is open
        if (this.isMobile) {
            document.body.style.overflow = 'hidden';
        }

        document.getElementById('sessionName').focus();
        if (window.focusTrap) window.focusTrap.activate(modal);
    }
    
    hideNewSessionModal() {
        this.hideModal('newSessionModal');

        // Restore body scroll
        if (this.isMobile) {
            document.body.style.overflow = '';
        }

        document.getElementById('sessionName').value = '';
        document.getElementById('sessionWorkingDir').value = '';
    }
    
    async createNewSession() {
        const name = document.getElementById('sessionName').value.trim() || `Session ${new Date().toLocaleString()}`;
        const workingDir = document.getElementById('sessionWorkingDir').value.trim() || this.selectedWorkingDir;
        
        if (!workingDir) {
            this.showError('Please select a working directory first');
            return;
        }
        
        try {
            const response = await this.authFetch('/api/sessions/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, workingDir })
            });
            
            if (!response.ok) throw new Error('Failed to create session');
            
            const data = await response.json();
            
            // Hide the modal
            this.hideNewSessionModal();

            // Add tab for the new session
            if (this.sessionTabManager) {
                this.sessionTabManager.addTab(data.sessionId, name, 'idle', workingDir);
                // switchToTab will handle joining the session
                await this.sessionTabManager.switchToTab(data.sessionId);
            } else {
                // No tab manager, join directly
                await this.joinSession(data.sessionId);
            }

            const srCreated = document.getElementById('srAnnounce');
            if (srCreated) srCreated.textContent = `Session created: ${name}`;
            
            // Update sessions list
            this.loadSessions();
        } catch (error) {
            console.error('Failed to create session:', error);
            this.showError('Failed to create session.\n\n\u2022 Check that the working directory exists\n\u2022 The server may be unreachable \u2014 try refreshing');
        }
    }
    
    setupPlanDetector() {
        // Initialize plan detector
        this.planDetector = new PlanDetector();
        this.planModal = document.getElementById('planModal');
        
        // Set up callbacks
        this.planDetector.onPlanDetected = (plan) => {
            this.showPlanModal(plan);
        };
        
        this.planDetector.onPlanModeChange = (isActive) => {
            this.updatePlanModeIndicator(isActive);
        };
        
        // Set up modal buttons
        const acceptBtn = document.getElementById('acceptPlanBtn');
        const rejectBtn = document.getElementById('rejectPlanBtn');
        const closeBtn = document.getElementById('closePlanBtn');
        
        acceptBtn.addEventListener('click', () => this.acceptPlan());
        rejectBtn.addEventListener('click', () => this.rejectPlan());
        closeBtn.addEventListener('click', () => this.hidePlanModal());
        
        // Start monitoring
        this.planDetector.startMonitoring();
    }
    
    showPlanModal(plan) {
        const modal = document.getElementById('planModal');
        const content = document.getElementById('planContent');
        
        // Format the plan content
        let formattedContent = plan.content;
        
        // Convert markdown to basic HTML for better display
        formattedContent = formattedContent
            .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
            .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
            .replace(/^- (.*?)$/gm, '• $1')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code>$1</code>');
        
        content.innerHTML = formattedContent;
        modal.classList.add('active');
        if (window.focusTrap) window.focusTrap.activate(modal);

        // Play a subtle notification sound (optional)
        this.playNotificationSound();
    }
    
    hidePlanModal() {
        this.hideModal('planModal');
    }
    
    acceptPlan() {
        // Send acceptance to Claude
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'input',
                data: 'y\n' // Send 'y' to accept the plan
            }));
        }
        
        this.hidePlanModal();
        this.planDetector.clearBuffer();
        
        // Show confirmation
        this.showNotification('Plan accepted! Claude will begin implementation.');
    }
    
    rejectPlan() {
        // Send rejection to Claude
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'input',
                data: 'n\n' // Send 'n' to reject the plan
            }));
        }
        
        this.hidePlanModal();
        this.planDetector.clearBuffer();
        
        // Show confirmation
        this.showNotification('Plan rejected. You can provide feedback to Claude.');
    }
    
    updatePlanModeIndicator(isActive) {
        const statusElement = document.getElementById('status');
        if (!statusElement) return; // No explicit status area in current UI
        if (isActive) {
            statusElement.innerHTML = `<span class="icon" style="color: var(--success);">${window.icons?.clipboard?.(14) || ''}</span> Plan Mode Active`;
        } else {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                statusElement.textContent = 'Connected';
                statusElement.className = 'status connected';
            }
        }
    }
    
    requestUsageStats() {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'get_usage' }));
        }
        
        // Start periodic updates if not already running
        if (!this.usageUpdateTimer) {
            this.usageUpdateTimer = setInterval(() => {
                this.requestUsageStats();
            }, 10000); // Update every 10 seconds for more real-time stats
        }
    }

    startSessionTimerUpdate() {
        // Token usage timer removed - no UI elements to update
        return;
    }

    updateUsageDisplay(sessionStats, dailyStats, sessionTimer, analytics, burnRate, plan, limits) {
        // Token usage display removed - no UI elements to update
        return;
        
        // Container is already visible by default
        
        // Check if mobile screen
        const isMobile = window.innerWidth <= 768;
        const isSmallMobile = window.innerWidth <= 480;
        
        // Format tokens (K/M notation)
        const formatTokens = (tokens) => {
            if (tokens >= 1000000) {
                return (tokens / 1000000).toFixed(1) + 'M';
            } else if (tokens >= 1000) {
                return (tokens / 1000).toFixed(1) + 'K';
            }
            return tokens.toString();
        };
        
        // Update display for current Claude session
        // If session is expired (remainingMs === 0), still show the stats but with 0 time
        if (sessionStats && sessionTimer && !sessionTimer.isExpired) {
            // Show session timer - just time remaining
            let sessionText;
            if (sessionTimer.remainingMs > 0) {
                const remainingHours = Math.floor(sessionTimer.remainingMs / (1000 * 60 * 60));
                const remainingMinutes = Math.floor((sessionTimer.remainingMs % (1000 * 60 * 60)) / (1000 * 60));
                sessionText = `${remainingHours}h ${remainingMinutes}m`;
            } else {
                // Session expired or no active session - show zeros
                sessionText = '0h 0m';
            }
            
            // Just show the time, no burn rate indicator in session field
            document.getElementById('usageTitle').textContent = sessionText;
            
            // Display tokens - on mobile just show percentage
            const actualTokens = sessionStats.totalTokens || 0;
            let tokenDisplay = actualTokens.toLocaleString();
            let percentUsed = 0;
            
            // Get the actual limit for custom plans (P90 based)
            let tokenLimit = this.planLimits?.tokens;
            if (!tokenLimit && this.currentPlan === 'custom') {
                // Default P90 limit for custom plans
                tokenLimit = 188026;
            }
            
            if (tokenLimit) {
                percentUsed = (actualTokens / tokenLimit) * 100;
                // Mobile: just percentage, Desktop: full display
                if (isMobile) {
                    tokenDisplay = `${percentUsed.toFixed(1)}%`;
                } else {
                    tokenDisplay = `${actualTokens.toLocaleString()} (${percentUsed.toFixed(1)}%)`;
                }
                
                // Update progress bar
                const progressBar = document.getElementById('usageProgressBar');
                const progressText = document.getElementById('usageProgressText');
                const progressContainer = document.getElementById('usageProgress');
                
                if (progressBar && progressText && progressContainer) {
                    progressContainer.style.display = 'block';
                    progressBar.style.width = Math.min(100, percentUsed) + '%';
                    progressText.textContent = percentUsed.toFixed(1) + '%';
                    
                    // Change color based on usage
                    progressBar.className = 'usage-progress-bar';
                    if (percentUsed >= 90) {
                        progressBar.classList.add('danger');
                    } else if (percentUsed >= 70) {
                        progressBar.classList.add('warning');
                    } else {
                        progressBar.classList.add('success');
                    }
                }
            }
            document.getElementById('usageTokens').textContent = tokenDisplay;
            
            // Start the live timer update
            this.startSessionTimerUpdate();
            
            // Format cost - CSS handles hiding on mobile
            const cost = sessionStats.totalCost || 0;
            const costText = cost > 0 ? `$${cost.toFixed(2)}` : '$0.00';
            document.getElementById('usageCost').textContent = costText;
            
            // Show burn rate - on mobile just show icon
            if (sessionTimer.burnRate && sessionTimer.burnRate > 0) {
                const burnRate = Math.round(sessionTimer.burnRate);
                let rateDisplay;
                
                if (isMobile) {
                    rateDisplay = `<span class="icon" aria-hidden="true">${window.icons?.chartLine?.(12) || ''}</span> ${burnRate}`;
                } else {
                    const burnRateText = `${burnRate} tok/min`;
                    rateDisplay = `<span class="icon" aria-hidden="true">${window.icons?.chartLine?.(12) || ''}</span> ${burnRateText}`;
                }
                
                document.getElementById('usageRate').innerHTML = rateDisplay;
                
                // Add depletion time if available
                if (sessionTimer.depletionTime && sessionTimer.depletionConfidence > 0.5) {
                    const depletionDate = new Date(sessionTimer.depletionTime);
                    const now = new Date();
                    const minutesToDepletion = Math.max(0, (depletionDate - now) / 1000 / 60);
                    
                    if (minutesToDepletion < 60) {
                        document.getElementById('usageRate').title = `Tokens depleting in ~${Math.round(minutesToDepletion)} minutes`;
                    } else {
                        const hoursToDepletion = Math.floor(minutesToDepletion / 60);
                        document.getElementById('usageRate').title = `Tokens depleting in ~${hoursToDepletion}h ${Math.round(minutesToDepletion % 60)}m`;
                    }
                }
            } else {
                // Fallback to simple rate
                const hours = sessionTimer.hours + (sessionTimer.minutes / 60) + (sessionTimer.seconds / 3600);
                const rate = hours > 0 ? sessionStats.requests / hours : 0;
                document.getElementById('usageRate').innerHTML = rate > 0 ? `<span class="icon" aria-hidden="true">${window.icons?.chartLine?.(12) || ''}</span> ${rate.toFixed(1)}/h` : '-';
            }
            
            // Show model distribution
            if (sessionStats.models) {
                const models = sessionStats.models;
                let totalTokens = 0;
                let opusTokens = 0;
                let sonnetTokens = 0;
                
                // Calculate totals
                for (const [model, data] of Object.entries(models)) {
                    const modelTokens = (data.inputTokens || 0) + (data.outputTokens || 0);
                    totalTokens += modelTokens;
                    
                    if (model.toLowerCase().includes('opus')) {
                        opusTokens += modelTokens;
                    } else if (model.toLowerCase().includes('sonnet')) {
                        sonnetTokens += modelTokens;
                    }
                }
                
                // Calculate percentages
                let modelText = '';
                if (totalTokens > 0) {
                    const opusPercent = (opusTokens / totalTokens) * 100;
                    const sonnetPercent = (sonnetTokens / totalTokens) * 100;
                    const isMobile = window.innerWidth <= 768;
                    
                    // Use short names on mobile, full names on desktop
                    const opusName = isMobile ? 'O' : 'Opus';
                    const sonnetName = isMobile ? 'S' : 'Sonnet';
                    
                    if (opusPercent > 0 && sonnetPercent > 0) {
                        modelText = `${opusName} ${opusPercent.toFixed(0)}% / ${sonnetName} ${sonnetPercent.toFixed(0)}%`;
                    } else if (opusPercent > 0) {
                        modelText = `${opusName} ${opusPercent.toFixed(0)}%`;
                    } else if (sonnetPercent > 0) {
                        modelText = `${sonnetName} ${sonnetPercent.toFixed(0)}%`;
                    } else {
                        modelText = 'Unknown';
                    }
                } else {
                    modelText = 'No usage';
                }
                
                document.getElementById('usageModel').textContent = modelText;
            }
        } else {
            // No active session or expired session - show zeros
            const isMobile = window.innerWidth <= 768;
            
            document.getElementById('usageTitle').textContent = '0h 0m';
            document.getElementById('usageTokens').textContent = isMobile ? '0%' : '0';
            document.getElementById('usageCost').textContent = '$0.00';
            document.getElementById('usageRate').textContent = '-';
            document.getElementById('usageModel').textContent = 'No usage';
            
            // Stop the timer update
            if (this.sessionTimerInterval) {
                clearInterval(this.sessionTimerInterval);
                this.sessionTimerInterval = null;
            }
            
            // Hide progress bar when no session
            const progressContainer = document.getElementById('usageProgress');
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
        }
        
        // Removed model breakdown and projections - compact view doesn't need them
    }

    getBurnRateIndicator(rate) {
        // Minimalist indicator using a line chart icon and label
        const icon = window.icons?.chartLine?.(12) || '';
        if (rate > 1000) return `<span class="icon" aria-hidden="true">${icon}</span> Very high`;
        if (rate > 500) return `<span class="icon" aria-hidden="true">${icon}</span> High`;
        if (rate > 100) return `<span class="icon" aria-hidden="true">${icon}</span> Moderate`;
        if (rate > 50) return `<span class="icon" aria-hidden="true">${icon}</span> Low`;
        return `<span class="icon" aria-hidden="true">${icon}</span> Very low`;
    }
    
    showNotification(message) {
        // Simple notification - you could enhance this with a toast notification
        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: var(--accent);
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            z-index: 10002;
            animation: slideIn 0.3s ease;
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
    
    _playMicChime(type) {
        const settings = this.loadSettings();
        if (!settings.micSounds) return;
        const volume = typeof settings.notifVolume === 'number'
            ? (settings.notifVolume / 100) * 0.3
            : 0.3;
        if (volume <= 0) return;

        try {
            if (!this._micAudioCtx) {
                this._micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            const ctx = this._micAudioCtx;
            if (ctx.state === 'suspended') ctx.resume();
            const t = ctx.currentTime;

            const playTone = (startTime, freq, dur) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(volume, startTime);
                gain.gain.exponentialRampToValueAtTime(0.01, startTime + dur);
                osc.start(startTime);
                osc.stop(startTime + dur);
            };

            if (type === 'on') {
                // Ascending: 440Hz -> 660Hz
                playTone(t, 440, 0.075);
                playTone(t + 0.075, 660, 0.075);
            } else {
                // Descending: 660Hz -> 440Hz
                playTone(t, 660, 0.075);
                playTone(t + 0.075, 440, 0.075);
            }
        } catch (e) {
            // Audio not available
        }
    }

    playNotificationSound() {
        // Optional: Play a subtle sound when plan is detected
        // You can add an audio element to play a notification sound
        try {
            const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBRld0Oy9diMFl2+z2e7NeSgFxYvg+8SEIwW3we6eVg0FqOTupjMBSanLvV0OBba37J5QCgU4cLvfvn0cBUCd1Oq2yFSvvayILgm359+2pw8HVqfu3LNDCEij59+NLwBarvfZN20aBVGU4OyrdR0Ff5/i5paFFDGD0+ylVBYF3NTaz38nBThl4fDbmU0NF1PD5uyqUBcIJJDO5buGNggMoNvyx08FB1er/OykQRIKrau3mHs0BQ5azvfZx30VBbDe3LVmFAVK0PC1vnoPC42S4ObNozsJB1Ox58+TYyAKL5zN9r19JAWFz9P6s4s6C2uz+L2VJwUUncflwpdMC0HD5d5sFAVWv+PYiEQIDXq16eyxlSAK57vi75NkBqOZ88WzlnAHl9TmsS8JBaLj4rQ8BigO1/rPuIMtBjGI1PG+kCcFxoTg+bxnMwfSfOL55LVeCn/R+Mltbw8FBpP48KBwKgtDqPDfnzsLCJDZ/dpTWRUHo+S6+M9+lQdRp/DdnysJFXG559GdWwgTgN7z04k2Be/B8d2AUAILJLTy2Y8xBZmduvneOxYFy6H24LhpGgWunuznm0sTDbXm9bldBQuK6u7LfxUIPLH74Z5CBRt37uWmTRgB7ez+0ogeCi+J0Oe4X');
            audio.volume = 0.3;
            audio.play();
        } catch (e) {
            // Ignore sound errors
        }
    }

}

// Add animation keyframes
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);

// Focus trap utility for modal dialogs
window.focusTrap = {
    _active: null,
    _previousFocus: null,
    _handler: null,

    activate(modalEl) {
        this._previousFocus = document.activeElement;
        this._active = modalEl;

        const getFocusable = () => {
            return Array.from(modalEl.querySelectorAll(
                'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )).filter(el => el.offsetParent !== null);
        };

        this._handler = (e) => {
            if (e.key !== 'Tab') return;
            const focusable = getFocusable();
            if (!focusable.length) return;

            const first = focusable[0];
            const last = focusable[focusable.length - 1];

            if (e.shiftKey) {
                if (document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };
        modalEl.addEventListener('keydown', this._handler);

        // Focus the first focusable element (or close button)
        requestAnimationFrame(() => {
            const focusable = getFocusable();
            if (focusable.length) focusable[0].focus();
        });
    },

    deactivate() {
        if (this._active && this._handler) {
            this._active.removeEventListener('keydown', this._handler);
        }
        this._active = null;
        this._handler = null;
        if (this._previousFocus && typeof this._previousFocus.focus === 'function') {
            this._previousFocus.focus();
        }
        this._previousFocus = null;
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const app = new ClaudeCodeWebInterface();
    window.app = app;
    app.startHeartbeat();
});
