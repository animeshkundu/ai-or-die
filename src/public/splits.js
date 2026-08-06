/**
 * SplitContainer - Simple VS Code-style split view
 * Manages up to 2 terminal panes side-by-side with independent terminals
 */

class Split {
    constructor(container, index, app) {
        this.container = container;
        this.index = index;
        this.app = app;
        this.sessionId = null;
        this.isActive = false;

        // Create independent terminal instance for this split
        this.terminal = null;
        this.fitAddon = null;
        this.webLinksAddon = null;
        this.socket = null;
        this.connectionId = null;
        this.geometryViewId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
            ? globalThis.crypto.randomUUID()
            : `split-${index}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this._socketGeneration = 0;
        this._heartbeatTimer = null;
        this._pongTimer = null;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 10;
        this._closing = false;
        this._pendingWrites = [];
        this._rafPending = false;
        this._rafHandle = null;
        this._repainting = false;
        this._repaintTimer = null;
        this._repaintGeneration = 0;
        this._reconnectViewState = null;
        this._wheelInputPending = false;
        this._connectReady = null;

        this.createTerminal();
    }

    createTerminal() {
        // Create terminal wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'split-terminal-wrapper';
        
        const terminalDiv = document.createElement('div');
        terminalDiv.id = `split-terminal-${this.index}`;
        terminalDiv.className = 'split-terminal-capacity';
        const terminalStage = document.createElement('div');
        terminalStage.className = 'terminal-stage';
        terminalDiv.appendChild(terminalStage);
        wrapper.appendChild(terminalDiv);

        const controlStatus = document.createElement('div');
        controlStatus.className = 'terminal-control-status split-terminal-control-status';
        controlStatus.setAttribute('role', 'status');
        controlStatus.setAttribute('aria-live', 'polite');
        controlStatus.setAttribute('aria-atomic', 'true');
        controlStatus.hidden = true;
        controlStatus.innerHTML = '<span data-terminal-control-message>Viewing another device\'s terminal size</span>'
            + '<button type="button">Take control</button>';
        controlStatus.querySelector('button').addEventListener('click', () => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({
                    type: 'geometry_take_control',
                    viewId: this.geometryViewId
                }));
            }
        });
        wrapper.appendChild(controlStatus);
        this._controlStatus = controlStatus;
        
        this.container.appendChild(wrapper);
        
        // Initialize xterm.js terminal
        this.terminal = new Terminal({
            fontFamily: this.app?.terminal?.options?.fontFamily
                || getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
                || "'MesloLGS Nerd Font', 'MesloLGS NF', 'Meslo Nerd Font', monospace",
            fontSize: this.app?.terminal?.options?.fontSize || 14,
            cursorBlink: true,
            convertEol: true,
            allowProposedApi: true,
            windowOptions: {
                reportFocus: false
            },
            theme: this.app?.terminal?.options?.theme || {
                background: '#0d1117',
                foreground: '#c9d1d9',
                cursor: '#58a6ff'
            }
        });
        
        this.fitAddon = new FitAddon.FitAddon();
        this.webLinksAddon = new WebLinksAddon.WebLinksAddon();
        
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(this.webLinksAddon);

        // Load Unicode11 addon for correct Nerd Font / powerline glyph widths
        if (typeof Unicode11Addon !== 'undefined') {
            const unicode11 = new Unicode11Addon.Unicode11Addon();
            this.terminal.loadAddon(unicode11);
            this.terminal.unicode.activeVersion = '11';
        }

        this.terminal.open(terminalStage);

        // Trackpad/mouse-wheel policy (same as the main terminal): preempt
        // xterm's alt-buffer wheel->arrow translation so scrolling doesn't
        // hijack the Claude Code TUI. Reads the app-wide setting live.
        if (typeof window.attachTerminalWheel === 'function') {
            this._wheelHandler = window.attachTerminalWheel(
                this.terminal,
                terminalDiv,
                () => (this.app && this.app._wheelScrollMode) || 'dontHijack',
                () => {
                    this._wheelInputPending = true;
                    queueMicrotask(() => { this._wheelInputPending = false; });
                }
            );
        }

        // WebGL renderer with DOM-renderer fallback. The Canvas renderer was
        // removed in xterm 6.0, so on WebGL failure/context-loss we fall back to
        // xterm's default DOM renderer (loading no addon).
        if (typeof WebglAddon !== 'undefined') {
            try {
                this.webglAddon = new WebglAddon.WebglAddon();
                this.webglAddon.onContextLoss(() => {
                    const addon = this.webglAddon;
                    this.webglAddon = null;
                    try { if (addon) addon.dispose(); } catch (_) {}
                    // No addon loaded -> xterm reverts to the DOM renderer.
                });
                this.terminal.loadAddon(this.webglAddon);
            } catch (e) {
                this.webglAddon = null;
                // Falls back to the default DOM renderer.
            }
        }

        // Monotonic instance id, NOT the positional index. register() calls
        // unregister(id) first, so two panes sharing an id silently tear down
        // each other's ResizeObserver: close pane 1, open a new pane that takes
        // index 1, and the old pane's deferred destroy -> unregister(this._fitId)
        // disconnects the NEW pane's observer. It then never re-fits and its PTY
        // keeps a stale size. The index is reused by design; the fit identity
        // must not be.
        Split._fitSeq = (Split._fitSeq || 0) + 1;
        this._fitId = `split-${this.index}-${Split._fitSeq}`;
        if (this.app && this.app.fitCoordinator) {
            this.app.fitCoordinator.register(this._fitId, {
                container: terminalDiv,
                stage: terminalStage,
                terminal: this.terminal,
                authoritativeMode: true,
                measureCapacity: () => TerminalGeometry.measureOuterTerminalCapacity(
                    terminalDiv,
                    this.terminal
                ),
                reserve: { cols: 6, rows: 0 },
                send: ({ cols, rows }) => {
                    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                        this.socket.send(JSON.stringify({
                            type: 'resize',
                            cols,
                            rows,
                            viewId: this.geometryViewId
                        }));
                        return true;
                    }
                    return false;
                },
                withdraw: () => {
                    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                        this.socket.send(JSON.stringify({
                            type: 'geometry_withdraw',
                            viewId: this.geometryViewId
                        }));
                    }
                },
                onAuthoritative: (frame) => this._updateControlStatus(frame)
            });
        }

        this.terminal.onCursorMove(() => this.app.fitCoordinator?.requestRendered(this._fitId));

        // Refresh the atlas once when fonts settle; geometry is owned by the
        // coordinator and ResizeObserver resumes deferred hidden panes.
        if (document.fonts) {
            document.fonts.ready.then(() => {
                this.terminal.clearTextureAtlas();
                this.terminal.refresh(0, this.terminal.rows - 1);
                this.fit();
            });
        }

        // Attach keyboard copy/paste shortcuts (Ctrl+C/V, Ctrl+Shift+C/V)
        attachClipboardHandler(this.terminal, (data) => {
            this._sendInput(data);
        });

        // Wire clickable file paths (xterm registerLinkProvider) +
        // right-click selection-based file menu, same as the main terminal.
        // CRITICAL: pass `() => this.sessionId` so the link provider's
        // resolver chain looks up THIS split's session workingDir, not
        // whichever session is foregrounded in the main terminal. Without
        // this, clicks in a backgrounded split resolve against the wrong
        // session — silent 404 or wrong-file open. (Post-PR-108 bug; see
        // the matching comment in app.js _setupTerminalLinking.)
        if (this.app && typeof this.app._setupTerminalLinking === 'function') {
            try { this.app._setupTerminalLinking(this.terminal, () => this.sessionId); } catch (_) {}
        }

        // Attach image handler to split terminal
        const terminalContainer = wrapper;
        if (window.imageHandler) {
            this._imageHandler = window.imageHandler.attachImageHandler(
                this.terminal, terminalContainer, {
                    onImageReady: (imageData) => {
                        this._pendingImageCaption = imageData.caption;
                        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                            this.socket.send(JSON.stringify({
                                type: 'image_upload',
                                base64: imageData.base64,
                                mimeType: imageData.mimeType,
                                fileName: imageData.fileName || 'pasted-image.png',
                                caption: imageData.caption || ''
                            }));
                        }
                    },
                    // Non-image files pasted from a file manager route through the
                    // generic pipeline — same bridge as the main terminal
                    // (app.js). Without this, non-image PASTE is silently dropped
                    // in a split pane. Fires only after the image branch declines.
                    onFilesPaste: (files) => {
                        if (this._genericDropHandler
                                && typeof this._genericDropHandler.dispatchFiles === 'function') {
                            this._genericDropHandler.dispatchFiles(files);
                        }
                    }
                }
            );
        }

        // Generic (non-image) file drop — mirror of the main terminal wiring
        // in app.js. WITHOUT this, a split pane attaches only the image
        // handler, whose drop listener preventDefaults every drop and then
        // silently returns for anything that isn't an accepted image — so
        // dropping a PDF (or any non-image file) on a split does nothing.
        // Runs in capture phase so it preempts xterm's own drop handling;
        // image MIMEs delegate to the image preview via onImageDrop, everything
        // else uploads to <session cwd>/.claude-attachments/ and injects
        // `@<absolute-path>` as bracketed paste.
        //
        // Session scoping is load-bearing: use THIS split's sessionId-scoped
        // working dir + THIS split's socket, never the foregrounded session's
        // (same wrong-session hazard the link-provider comment above warns of).
        if (window.genericDropHandler) {
            this._genericDropHandler = window.genericDropHandler.attachGenericDropHandler({
                containerEl: terminalContainer,
                getWorkingDir: () => (this.app && typeof this.app.getSessionWorkingDir === 'function'
                    ? this.app.getSessionWorkingDir(this.sessionId) : null),
                getAuthToken: () => (window.authManager && window.authManager.getToken
                    ? window.authManager.getToken() : null),
                onImageDrop: () => {
                    // Intentionally a no-op: for an image-only drop the generic
                    // handler returns WITHOUT stopPropagation (see the "defer to
                    // image-handler.js entirely" branch in generic-drop-handler.js),
                    // so this split's own image handler onDrop still fires and
                    // shows the preview. Calling showImagePreview here too would
                    // stack a SECOND identical modal. (Mixed image+non-image drops
                    // do stopPropagation, so the image partition of a mixed drop is
                    // not previewed — a rare edge; drop images on their own.)
                },
                injectAtPath: (atPath) => {
                    if (!atPath) return;
                    let normalized = attachClipboardHandler.normalizeLineEndings(atPath + ' ');
                    if (this.terminal && this.terminal.modes && this.terminal.modes.bracketedPasteMode) {
                        normalized = attachClipboardHandler.wrapBracketedPaste(normalized);
                    }
                    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                        this._sendInput(normalized);
                    }
                },
                onError: (basename, msg) => {
                    if (window.feedback && typeof window.feedback.error === 'function') {
                        window.feedback.error(basename + ': ' + msg);
                    }
                },
            });
        }

        // Setup terminal input handler
        this.terminal.onData((data) => {
            this._sendInput(data);
        });
        
        this.fit();
    }

    async setSession(sessionId) {
        if (this.sessionId === sessionId) return;
        
        // Disconnect from old session
        if (this.socket) {
            this.disconnect();
        }
        
        this.sessionId = sessionId;
        
        // Connect to new session
        if (sessionId) {
            await this.connect(sessionId);
        }
        
        // Update active state
        this.updateActiveState();
    }

    _updateControlStatus(frame) {
        const status = this._controlStatus;
        if (!status) return;
        const owner = frame && frame.owner;
        const isOwner = !!(owner
            && owner.connectionId === this.connectionId
            && owner.viewId === this.geometryViewId);
        const hasGeometry = Number.isInteger(frame && frame.cols)
            && Number.isInteger(frame && frame.rows);
        const message = status.querySelector('[data-terminal-control-message]');
        if (message) {
            message.textContent = owner
                ? 'Viewing another device\'s terminal size'
                : 'Terminal control is available';
        }
        status.hidden = !hasGeometry || isOwner;
        status.dataset.owner = isOwner ? 'local' : (owner ? 'remote' : 'vacant');
    }

    _sendInput(data) {
        data = typeof data === 'string' ? data.replace(/\x1b\[\[?[IO]/g, '') : data;
        if (!data) return;
        const wheelGenerated = this._wheelInputPending
            && TerminalGeometry.isWheelArrowInput(data);
        this._wheelInputPending = false;
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'input',
                data,
                claim: !(wheelGenerated || TerminalGeometry.isNonClaimingTerminalInput(data)),
                viewId: this.geometryViewId
            }));
        }
    }

    async connect(sessionId) {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let wsUrl = `${protocol}//${location.host}?sessionId=${encodeURIComponent(sessionId)}`;

        // Add auth token if needed
        if (window.authManager) {
            wsUrl = window.authManager.getWebSocketUrl(wsUrl);
        }

        // Reset closing flag when (re)connecting — disconnect() may have set it.
        this._closing = false;
        this._socketGeneration += 1;
        const gen = this._socketGeneration;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        this.socket = ws;
        const isCurrent = () => ws === this.socket && gen === this._socketGeneration;
        const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this._connectReady || this._connectReady.generation !== gen) return;
                this._connectReady = null;
                reject(new Error(`Split ${this.index} session join timed out`));
            }, 15000);
            this._connectReady = { generation: gen, resolve, reject, timer };
        });

        ws.onopen = () => {
            if (!isCurrent()) return;
            this._reconnectAttempts = 0;
            this._startHeartbeat();
            console.log(`[Split ${this.index}] Connected to session ${sessionId}`);
            this.app.fitCoordinator?.request(this._fitId, { forceSend: true });
        };

        ws.onmessage = (event) => {
            if (!isCurrent()) return;
            if (event.data instanceof ArrayBuffer) {
                this._queueOutput(new Uint8Array(event.data));
            } else {
                try {
                    const msg = JSON.parse(event.data);
                    this.handleMessage(msg);
                } catch (error) {
                    console.error(`[Split ${this.index}] Error handling message:`, error);
                }
            }
        };

        ws.onclose = () => {
            // Stale-socket fence: ignore close events from prior sockets.
            if (!isCurrent()) return;
            this._rejectConnectReady(gen, new Error(`Split ${this.index} disconnected before session join`));
            if (this._heartbeat) { this._heartbeat.stop(); this._heartbeat = null; }
            if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
            if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
            const buffer = this.terminal && this.terminal.buffer && this.terminal.buffer.active;
            this._reconnectViewState = {
                sessionId: this.sessionId,
                viewportY: buffer ? buffer.viewportY : 0,
                selection: this.terminal && this.terminal.getSelectionPosition
                    ? this.terminal.getSelectionPosition()
                    : null
            };
            if (this._closing || this._reconnectAttempts >= this._maxReconnectAttempts) {
                console.log(`[Split ${this.index}] Disconnected from session ${sessionId}`);
                return;
            }
            // Mirror main pane: 250ms first attempt, exponential+jitter after.
            const n = this._reconnectAttempts;
            const delay = n === 0
                ? 250
                : Math.min(1000 * Math.pow(2, n), 30000) * (0.7 + Math.random() * 0.6);
            this._reconnectAttempts++;
            console.log(`[Split ${this.index}] Reconnecting (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts}) in ${Math.round(delay)}ms`);
            // Fence the deferred reconnect with the current generation so a
            // user-initiated setSession() (which calls disconnect→connect and
            // advances the generation) cannot have an old timer fire later and
            // spawn a parallel socket. (Caught by gemini-3.1-pro-preview review.)
            if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
            const onCloseGen = this._socketGeneration;
            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                if (this._closing) return;
                if (onCloseGen !== this._socketGeneration) return;
                this.connect(this.sessionId).catch(err =>
                    console.error(`[Split ${this.index}] Reconnect failed:`, err));
            }, delay);
        };

        ws.onerror = (error) => {
            if (!isCurrent()) return;
            this._rejectConnectReady(gen, new Error(`Split ${this.index} WebSocket connection failed`));
            console.error(`[Split ${this.index}] WebSocket error:`, error);
        };
        return ready;
    }

    _resolveConnectReady(generation) {
        const ready = this._connectReady;
        if (!ready || ready.generation !== generation) return;
        clearTimeout(ready.timer);
        this._connectReady = null;
        ready.resolve();
    }

    _rejectConnectReady(generation, error) {
        const ready = this._connectReady;
        if (!ready || ready.generation !== generation) return;
        clearTimeout(ready.timer);
        this._connectReady = null;
        ready.reject(error);
    }

    _startHeartbeat() {
        // Splits maintain their own heartbeat — main socket's heartbeat is not
        // a substitute, since an idle split socket can silently die from NAT
        // timeout while the main socket stays alive on user traffic.
        // Delegates to HeartbeatWatchdog (loaded via index.html before splits.js).
        if (this._heartbeat) this._heartbeat.stop();
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        this._heartbeat = new HeartbeatWatchdog({
            socket: this.socket,
            generation: this._socketGeneration,
            currentGeneration: () => this._socketGeneration,
            currentSocket: () => this.socket,
            log: (m) => console.warn(`[Split ${this.index}] heartbeat:`, m),
        });
        this._heartbeat.start();
        // Legacy refs — the watchdog owns the actual timers via stop().
        this._heartbeatTimer = null;
        this._pongTimer = null;
    }

    _queueOutput(chunk) {
        this._pendingWrites.push(chunk);
        if (!this._rafPending && !this._repainting) {
            this._rafPending = true;
            this._rafHandle = requestAnimationFrame(() => this._flushOutput());
        }
    }

    _flushOutput() {
        this._rafPending = false;
        this._rafHandle = null;
        if (this._repainting || this._pendingWrites.length === 0) return;
        const combined = OutputFrameBatcher.takeChunkBudget(this._pendingWrites, 96 * 1024);
        this.terminal.write(combined);
        if (this._pendingWrites.length > 0) {
            this._rafPending = true;
            this._rafHandle = requestAnimationFrame(() => this._flushOutput());
        }
    }

    _drainOutputNow() {
        if (this._pendingWrites.length === 0) return;
        if (this._rafHandle !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this._rafHandle);
        }
        this._rafHandle = null;
        this._rafPending = false;
        let guard = 0;
        while (this._pendingWrites.length > 0 && guard++ < 10000) {
            const combined = OutputFrameBatcher.takeChunkBudget(this._pendingWrites, 96 * 1024);
            this.terminal.write(combined);
        }
    }

    _finishReplay(generation, restoreView, view) {
        if (generation !== this._repaintGeneration) return;
        if (this._repaintTimer) {
            clearTimeout(this._repaintTimer);
            this._repaintTimer = null;
        }
        this._repainting = false;
        if (this._pendingWrites.length > 0 && !this._rafPending) {
            this._rafPending = true;
            this._rafHandle = requestAnimationFrame(() => this._flushOutput());
        }
        if (restoreView === false) return;
        if (view) {
            const buffer = this.terminal.buffer && this.terminal.buffer.active;
            if (buffer) this.terminal.scrollToLine(Math.min(view.viewportY, Math.max(0, buffer.baseY)));
            const selection = view.selection;
            if (selection && selection.start && selection.end) {
                const length = Math.max(
                    0,
                    (selection.end.y - selection.start.y) * this.terminal.cols
                        + selection.end.x - selection.start.x
                );
                if (length > 0) this.terminal.select(selection.start.x, selection.start.y, length);
            }
        }
    }

    handleMessage(msg) {
        switch (msg.type) {
            case 'connected':
                this.connectionId = msg.connectionId;
                break;

            case 'geometry_applied':
                if (!msg.sessionId || msg.sessionId === this.sessionId) {
                    this._drainOutputNow();
                    this.app.fitCoordinator?.applyAuthoritative(this._fitId, msg);
                }
                break;

            case 'output':
                this._drainOutputNow();
                this.terminal.write(msg.data);
                break;

            case 'pong':
                if (this._heartbeat) this._heartbeat.onPong();
                break;

            case 'session_joined': {
                if (msg.geometry) this.app.fitCoordinator?.applyAuthoritative(this._fitId, msg.geometry);
                else this.app.fitCoordinator?.clearAuthoritative(this._fitId, msg.sessionId);
                this.app.fitCoordinator?.request(this._fitId, { forceSend: true });
                const repaintGeneration = ++this._repaintGeneration;
                const connectionGeneration = this._socketGeneration;
                this._repainting = true;
                this._pendingWrites.length = 0;
                const reconnectView = this._reconnectViewState
                    && this._reconnectViewState.sessionId === msg.sessionId
                    ? this._reconnectViewState
                    : null;
                this._reconnectViewState = null;
                const joined = Array.isArray(msg.outputBuffer)
                    ? msg.outputBuffer.join('')
                    : '';
                if (this._repaintTimer) clearTimeout(this._repaintTimer);
                this._repaintTimer = setTimeout(() => {
                    if (repaintGeneration !== this._repaintGeneration) return;
                    console.warn(`[Split ${this.index}] replay timed out; resuming queued output`);
                    this._finishReplay(repaintGeneration, false, null);
                    this._resolveConnectReady(connectionGeneration);
                }, 5000);
                this.terminal.write(
                    '\x1bc' + joined,
                    () => {
                        this._finishReplay(repaintGeneration, true, reconnectView);
                        this._resolveConnectReady(connectionGeneration);
                    }
                );
                break;
            }
                
            case 'claude_started':
            case 'codex_started':
            case 'agent_started':
                console.log(`[Split ${this.index}] Agent started`);
                break;
                
            case 'exit':
                this.terminal.write('\r\n[Process exited]\r\n');
                break;
                
            case 'error':
                this.terminal.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
                break;

            case 'image_upload_complete': {
                const { filePath } = msg;
                const caption = this._pendingImageCaption || '';
                const normalizedPath = filePath.replace(/\\/g, '/');
                const quotedPath = '"' + normalizedPath + '"';
                const inputText = caption ? caption + ' ' + quotedPath : quotedPath;
                let normalized = window.attachClipboardHandler
                    ? window.attachClipboardHandler.normalizeLineEndings(inputText)
                    : inputText;
                if (this.terminal && this.terminal.modes && this.terminal.modes.bracketedPasteMode) {
                    normalized = window.attachClipboardHandler
                        ? window.attachClipboardHandler.wrapBracketedPaste(normalized)
                        : normalized;
                }
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this._sendInput(normalized);
                }
                this._pendingImageCaption = null;
                break;
            }

            case 'image_upload_error': {
                if (this.terminal) {
                    this.terminal.write('\r\n\x1b[31m[Image upload error] ' + msg.message + '\x1b[0m\r\n');
                }
                break;
            }
        }
    }

    disconnect() {
        // Mark as user-initiated close so onclose's reconnect logic bails out.
        this._closing = true;
        this._rejectConnectReady(
            this._socketGeneration,
            new Error(`Split ${this.index} disconnected before session join`)
        );
        // Cancel any deferred reconnect from a prior onclose so it cannot fire
        // after a user-initiated setSession() and spawn a parallel socket.
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._heartbeat) {
            this._heartbeat.stop();
            this._heartbeat = null;
        }
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
        if (this._pongTimer) {
            clearTimeout(this._pongTimer);
            this._pongTimer = null;
        }
        if (this.socket) {
            try {
                this.socket.close();
            } catch (e) {
                // Ignore errors
            }
            this.socket = null;
        }
        if (this._rafHandle !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this._rafHandle);
        }
        this._rafHandle = null;
        this._rafPending = false;
        this._pendingWrites.length = 0;
        this._repainting = false;
        this._repaintGeneration += 1;
        if (this._repaintTimer) {
            clearTimeout(this._repaintTimer);
            this._repaintTimer = null;
        }
    }

    fit() {
        this.app.fitCoordinator?.request(this._fitId);
    }

    updateActiveState() {
        if (this.container) {
            if (this.isActive) {
                this.container.classList.add('split-active');
            } else {
                this.container.classList.remove('split-active');
            }
        }
    }

    clear() {
        this.disconnect();
        this.sessionId = null;
        this.isActive = false;
        if (this.terminal) {
            this.terminal.clear();
        }
        this.updateActiveState();
    }

    destroy() {
        this.disconnect();
        this.app.fitCoordinator?.unregister(this._fitId);
        // Tear down drop/paste handlers (listeners + any in-flight uploads)
        // before disposing the terminal so nothing fires against a dead pane.
        try { if (this._genericDropHandler && this._genericDropHandler.destroy) this._genericDropHandler.destroy(); } catch (_) {}
        try { if (this._imageHandler && this._imageHandler.destroy) this._imageHandler.destroy(); } catch (_) {}
        try { if (this._wheelHandler && this._wheelHandler.dispose) this._wheelHandler.dispose(); } catch (_) {}
        if (this.terminal) {
            this.terminal.dispose();
        }
    }
}

class SplitContainer {
    constructor(app) {
        this.app = app;
        this.enabled = false;
        this.splits = [];
        this.activeSplitIndex = 0;
        this.dividerPosition = 50; // percentage
        
        // Create split container elements
        this.createSplitElements();
        
        // Restore state from localStorage
        this.restoreState();
        
        // Setup keyboard shortcuts
        this.setupKeyboardShortcuts();
    }

    createSplitElements() {
        const main = document.querySelector('.main');
        if (!main) return;

        // Create split container (initially hidden)
        this.splitContainerEl = document.createElement('div');
        this.splitContainerEl.className = 'split-container';
        this.splitContainerEl.style.display = 'none';

        // Create left split
        const leftSplit = document.createElement('div');
        leftSplit.className = 'split-pane split-left';
        leftSplit.dataset.splitIndex = '0';

        // Create divider
        this.divider = document.createElement('div');
        this.divider.className = 'split-divider';
        this.divider.setAttribute('role', 'separator');
        this.divider.setAttribute('aria-label', 'Resize terminal panes');
        this.divider.setAttribute('aria-orientation', 'vertical');
        this.divider.setAttribute('aria-valuemin', '20');
        this.divider.setAttribute('aria-valuemax', '80');
        this.divider.setAttribute('aria-valuenow', '50');
        this.divider.tabIndex = 0;
        this.setupDividerDrag();

        // Create right split
        const rightSplit = document.createElement('div');
        rightSplit.className = 'split-pane split-right';
        rightSplit.dataset.splitIndex = '1';

        // Add close button to right split
        const closeBtn = document.createElement('button');
        closeBtn.className = 'split-close';
        closeBtn.title = 'Close Split (Ctrl+\\)';
        closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>`;
        closeBtn.addEventListener('click', () => this.closeSplit());
        rightSplit.appendChild(closeBtn);

        this.splitContainerEl.appendChild(leftSplit);
        this.splitContainerEl.appendChild(this.divider);
        this.splitContainerEl.appendChild(rightSplit);

        main.appendChild(this.splitContainerEl);

        // Create Split instances with their own terminals
        this.splits.push(new Split(leftSplit, 0, this.app));
        this.splits.push(new Split(rightSplit, 1, this.app));
        
        // Mark left as active by default
        this.splits[0].isActive = true;
        this.splits[0].updateActiveState();

        // Click handlers to focus splits
        leftSplit.addEventListener('click', () => this.focusSplit(0));
        rightSplit.addEventListener('click', () => this.focusSplit(1));
    }

    setupDividerDrag() {
        let isDragging = false;
        let startX = 0;
        let startPosition = 50;

        this.divider.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startPosition = this.dividerPosition;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const container = this.splitContainerEl.getBoundingClientRect();
            const delta = e.clientX - startX;
            const deltaPercent = (delta / container.width) * 100;
            
            this.dividerPosition = Math.max(20, Math.min(80, startPosition + deltaPercent));
            this.updateDividerPosition();
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                document.body.style.cursor = '';
                this.saveState();
            }
        });

        this.divider.addEventListener('keydown', (e) => {
            let next = this.dividerPosition;
            if (e.key === 'ArrowLeft') next -= 5;
            else if (e.key === 'ArrowRight') next += 5;
            else if (e.key === 'Home') next = 20;
            else if (e.key === 'End') next = 80;
            else return;
            e.preventDefault();
            this.dividerPosition = Math.max(20, Math.min(80, next));
            this.updateDividerPosition();
            this.saveState();
        });
    }

    updateDividerPosition() {
        const leftSplit = this.splitContainerEl.querySelector('.split-left');
        const rightSplit = this.splitContainerEl.querySelector('.split-right');
        
        if (leftSplit && rightSplit) {
            leftSplit.style.width = `${this.dividerPosition}%`;
            rightSplit.style.width = `${100 - this.dividerPosition}%`;
            this.divider.setAttribute('aria-valuenow', String(Math.round(this.dividerPosition)));
            
            // Fit both terminals
            this.splits.forEach(split => split.fit());
        }
    }

    async createSplit(sessionId) {
        if (this.enabled) return; // Already split
        const availableWidth = document.querySelector('.main')?.getBoundingClientRect().width || window.innerWidth;
        if (availableWidth < 700) {
            if (window.feedback) window.feedback.info('Split view needs a wider screen. Use session tabs on this device.');
            return;
        }

        // Set sessions - left gets current session, right gets the dragged session
        const currentSessionId = this.app.currentClaudeSessionId;
        try {
            await this.splits[0].setSession(currentSessionId);
            await this.splits[1].setSession(sessionId);
        } catch (error) {
            this.splits.forEach((split) => {
                split.disconnect();
                split.sessionId = null;
            });
            throw error;
        }

        this.enabled = true;

        // Hide single terminal container only after both pane joins are ready.
        const terminalContainer = document.getElementById('terminalContainer');
        if (terminalContainer) {
            terminalContainer.style.display = 'none';
        }

        this.splitContainerEl.style.display = 'flex';
        this.updateDividerPosition();

        // Focus right split (newly created)
        this.focusSplit(1);

        // Save state
        this.saveState();

        console.log(`[SplitContainer] Created split with sessions: ${currentSessionId} | ${sessionId}`);
    }

    closeSplit() {
        if (!this.enabled) return;

        this.enabled = false;

        // Disconnect both splits
        this.splits.forEach(split => split.disconnect());

        // Show single terminal container
        const terminalContainer = document.getElementById('terminalContainer');
        if (terminalContainer) {
            terminalContainer.style.display = 'flex';
        }

        // Hide split container
        this.splitContainerEl.style.display = 'none';

        // Clear splits but don't destroy terminals (we'll reuse them)
        this.splits.forEach((split, i) => {
            split.sessionId = null;
            split.isActive = (i === 0);
            split.updateActiveState();
            if (split.terminal) {
                split.terminal.clear();
            }
        });
        
        this.activeSplitIndex = 0;

        // The main socket remains joined while split panes use their own
        // connections. Reuse it instead of creating an overlapping socket whose
        // delayed open can race a real reconnect.
        this.app.fitCoordinator?.request('main', { forceSend: true });

        // Save state
        this.saveState();

        console.log('[SplitContainer] Closed split, back to single pane');
    }

    focusSplit(index) {
        if (index < 0 || index >= this.splits.length) return;
        if (this.activeSplitIndex === index) return;

        // Update active state
        this.splits.forEach((split, i) => {
            split.isActive = (i === index);
            split.updateActiveState();
        });

        this.activeSplitIndex = index;

        // Keep input overlay's pane tracker in sync
        if (this.app) {
            this.app._lastFocusedPaneIndex = index;
        }

        // Focus the terminal in this split
        const split = this.splits[index];
        if (split.terminal) {
            split.terminal.focus();
        }

        // Update app's current session to match this split
        if (split.sessionId && this.app) {
            this.app.currentClaudeSessionId = split.sessionId;
            
            // Update tab selection
            if (this.app.sessionTabManager) {
                const tab = this.app.sessionTabManager.tabs.get(split.sessionId);
                if (tab) {
                    // Update visual state of tabs
                    this.app.sessionTabManager.tabs.forEach((t, id) => {
                        if (id === split.sessionId) {
                            t.classList.add('active');
                        } else {
                            t.classList.remove('active');
                        }
                    });
                    this.app.sessionTabManager.activeTabId = split.sessionId;
                }
            }
        }

        console.log(`[SplitContainer] Focused split ${index}, session: ${split.sessionId}`);
    }

    // Called when a tab is switched - update the active split's session
    async onTabSwitch(sessionId) {
        if (!this.enabled) return;

        const activeSplit = this.splits[this.activeSplitIndex];
        if (activeSplit) {
            await activeSplit.setSession(sessionId);
        }
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Cmd/Ctrl + \ to toggle split
            if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
                e.preventDefault();
                if (this.enabled) {
                    this.closeSplit();
                } else {
                    // Create split - need to pick a session to split with
                    // For now, just show a message
                    console.log('[SplitContainer] To create a split, drag a tab to the right edge of the terminal');
                }
            }
            
            // Cmd/Ctrl + 1/2 to focus splits
            if ((e.metaKey || e.ctrlKey) && this.enabled) {
                if (e.key === '1') {
                    e.preventDefault();
                    this.focusSplit(0);
                } else if (e.key === '2') {
                    e.preventDefault();
                    this.focusSplit(1);
                }
            }
        });
    }

    saveState() {
        try {
            const state = {
                enabled: this.enabled,
                dividerPosition: this.dividerPosition,
                activeSplitIndex: this.activeSplitIndex,
                sessions: this.splits.map(s => s.sessionId)
            };
            localStorage.setItem('cc-web-splits', JSON.stringify(state));
        } catch (error) {
            console.error('Failed to save split state:', error);
        }
    }

    restoreState() {
        try {
            const saved = localStorage.getItem('cc-web-splits');
            if (!saved) return;

            const state = JSON.parse(saved);
            
            // Restore divider position
            if (state.dividerPosition) {
                this.dividerPosition = state.dividerPosition;
            }

            // Note: Don't auto-restore enabled state on page load
            // User needs to manually create splits
            // This prevents issues with stale session IDs
        } catch (error) {
            console.error('Failed to restore split state:', error);
        }
    }

    // Setup drop zones for drag-to-split
    setupDropZones() {
        const terminalContainer = document.getElementById('terminalContainer');
        if (!terminalContainer) return;

        // Create drop zone indicator
        const dropZone = document.createElement('div');
        dropZone.className = 'split-drop-zone';
        dropZone.style.display = 'none';
        terminalContainer.appendChild(dropZone);

        // Listen for drag events on terminal container
        terminalContainer.addEventListener('dragover', (e) => {
            // Only show drop zone if we're not already in split mode
            if (this.enabled) return;
            
            const sessionId = e.dataTransfer?.getData('application/x-session-id');
            if (!sessionId) return;
            
            // Don't allow splitting with the current session
            if (sessionId === this.app.currentClaudeSessionId) return;

            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            // Show drop zone if near right edge
            const rect = terminalContainer.getBoundingClientRect();
            const isNearRightEdge = (e.clientX > rect.right - 100);

            if (isNearRightEdge) {
                dropZone.style.display = 'block';
            } else {
                dropZone.style.display = 'none';
            }
        });

        terminalContainer.addEventListener('dragleave', () => {
            dropZone.style.display = 'none';
        });

        terminalContainer.addEventListener('drop', async (e) => {
            const sessionId = e.dataTransfer?.getData('application/x-session-id');
            if (!sessionId) return;
            
            // Don't allow splitting with the current session
            if (sessionId === this.app.currentClaudeSessionId) {
                dropZone.style.display = 'none';
                return;
            }

            const rect = terminalContainer.getBoundingClientRect();
            const isNearRightEdge = (e.clientX > rect.right - 100);

            if (isNearRightEdge && !this.enabled) {
                e.preventDefault();
                await this.createSplit(sessionId);
            }

            dropZone.style.display = 'none';
        });
    }
}

// Export for use in app.js
window.SplitContainer = SplitContainer;
