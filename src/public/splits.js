/**
 * SplitContainer - VS Code-style split view with independently joined panes.
 *
 * A split owns its socket and terminal. Its identity is intentionally separate
 * from the main app socket so focusing or retargeting a pane cannot retarget
 * the hidden main terminal.
 */

const SPLIT_REPLAY_TIMEOUT_MS = 5000;
const SPLIT_REPLAY_MAX_BYTES = 512 * 1024;
const SPLIT_REPLAY_MAX_ENTRIES = 2048;
const SPLIT_PRE_ACK_MAX_BYTES = 64 * 1024;
const SPLIT_PRE_ACK_MAX_ENTRIES = 256;
const SPLIT_OUTPUT_FRAME_BUDGET = 96 * 1024;

function splitByteLength(value) {
    if (value instanceof Uint8Array) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    let text;
    try {
        text = value && typeof value === 'object' ? JSON.stringify(value) : String(value || '');
    } catch (_) {
        text = String(value || '');
    }
    try {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
    } catch (_) { /* UTF-16 length is a bounded fallback */ }
    return text.length;
}

function splitIsBinary(value) {
    return value instanceof ArrayBuffer || value instanceof Uint8Array;
}

function splitToUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return null;
}

function splitRequestFrame(callback) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(callback, 0);
}

class Split {
    constructor(container, index, app) {
        this.container = container;
        this.index = index;
        this.app = app;

        // `sessionId` is the compatibility alias used by link/drop integrations.
        // It is pane-local and never writes app.currentClaudeSessionId.
        this.sessionId = null;
        this.desiredSessionId = null;
        this.committedSessionId = null;
        this.paintedSessionId = null;
        this._focusedSessionId = null;
        this.isActive = false;
        this._viewId = `split-${index}`;

        this.terminal = null;
        this.fitAddon = null;
        this.webLinksAddon = null;
        this.socket = null;
        this.connectionId = null;

        // A socket generation fences callbacks from a replaced WebSocket. A
        // transition generation fences callbacks from a retargeted pane.
        this._socketGeneration = 0;
        this.socketGeneration = 0;
        this._transitionGeneration = 0;
        this.transitionGeneration = 0;
        this._transitionId = null;
        this.transitionId = null;

        this._heartbeat = null;
        this._heartbeatTimer = null;
        this._pongTimer = null;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 10;
        this._closing = false;

        this._joinAcked = false;
        this._awaitingJoinAck = false;
        this._joinTimer = null;
        this._connectWaiter = null;

        // Ordered entries are { kind: 'binary'|'json', value }. JSON lifecycle
        // messages stay in this FIFO with binary output during replay.
        this._pendingWrites = [];
        this._pendingWriteBytes = 0;
        this._maxReplayQueueBytes = SPLIT_REPLAY_MAX_BYTES;
        this._maxReplayQueueEntries = SPLIT_REPLAY_MAX_ENTRIES;
        this._preAckQuarantine = [];
        this._preAckBytes = 0;
        this._preAckDropped = 0;
        this._replayInProgress = false;
        this._replayState = null;
        this._replayRecoveryCount = 0;
        this._rafPending = false;
        this._rafHandle = null;
        this._repainting = false;
        this._repaintTimer = null;
        this._repaintGeneration = 0;
        this._reconnectViewState = null;

        this._geometrySeen = null;
        this._geometryApplied = null;
        this._geometryIsOwner = null;

        this.createTerminal();
    }

    createTerminal() {
        const wrapper = document.createElement('div');
        wrapper.className = 'split-terminal-wrapper';

        const terminalDiv = document.createElement('div');
        terminalDiv.id = `split-terminal-${this.index}`;
        wrapper.appendChild(terminalDiv);
        this.container.appendChild(wrapper);

        this.terminal = new Terminal({
            fontFamily: this.app?.terminal?.options?.fontFamily
                || getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
                || "'MesloLGS Nerd Font', 'MesloLGS NF', 'Meslo Nerd Font', monospace",
            fontSize: this.app?.terminal?.options?.fontSize || 14,
            cursorBlink: true,
            convertEol: true,
            allowProposedApi: true,
            windowOptions: { reportFocus: false },
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

        if (typeof Unicode11Addon !== 'undefined') {
            const unicode11 = new Unicode11Addon.Unicode11Addon();
            this.terminal.loadAddon(unicode11);
            this.terminal.unicode.activeVersion = '11';
        }
        this.terminal.open(terminalDiv);

        if (typeof window.attachTerminalWheel === 'function') {
            this._wheelHandler = window.attachTerminalWheel(
                this.terminal,
                terminalDiv,
                () => (this.app && this.app._wheelScrollMode) || 'dontHijack'
            );
        }

        if (typeof WebglAddon !== 'undefined') {
            try {
                this.webglAddon = new WebglAddon.WebglAddon();
                this.webglAddon.onContextLoss(() => {
                    const addon = this.webglAddon;
                    this.webglAddon = null;
                    try { if (addon) addon.dispose(); } catch (_) {}
                });
                this.terminal.loadAddon(this.webglAddon);
            } catch (_) {
                this.webglAddon = null;
            }
        }

        Split._fitSeq = (Split._fitSeq || 0) + 1;
        this._fitId = `split-${this.index}-${Split._fitSeq}`;
        if (this.app && this.app.fitCoordinator) {
            this.app.fitCoordinator.register(this._fitId, {
                container: terminalDiv,
                terminal: this.terminal,
                proposeDimensions: () => this.fitAddon.proposeDimensions(),
                reserve: { cols: 6, rows: 0 },
                authoritativeMode: () => this._geometryIsOwner === false && !!this._geometryApplied,
                send: ({ cols, rows }) => {
                    // A resize received before session_joined is ignored by the
                    // server. Return false so FitCoordinator's bounded retry can
                    // advertise again after the join has committed.
                    if (!this.committedSessionId) return false;
                    return this._sendControl({
                        type: 'resize',
                        cols,
                        rows,
                        sessionId: this.desiredSessionId,
                        viewId: this._viewId,
                        transitionId: this._transitionId,
                    });
                }
            });
        }

        if (document.fonts) {
            Promise.resolve(document.fonts.ready).then(() => {
                try { this.terminal.clearTextureAtlas(); } catch (_) {}
                try { this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1)); } catch (_) {}
                this.fit();
            }).catch(() => {});
        }

        if (typeof attachClipboardHandler === 'function') {
            attachClipboardHandler(this.terminal, (data) => this.sendInput(data));
        }

        if (this.app && typeof this.app._setupTerminalLinking === 'function') {
            try { this.app._setupTerminalLinking(this.terminal, () => this.sessionId); } catch (_) {}
        }

        const terminalContainer = wrapper;
        if (window.imageHandler) {
            this._imageHandler = window.imageHandler.attachImageHandler(
                this.terminal,
                terminalContainer,
                {
                    onImageReady: (imageData) => {
                        this._pendingImageCaption = imageData.caption;
                        this._sendControl({
                            type: 'image_upload',
                            base64: imageData.base64,
                            mimeType: imageData.mimeType,
                            fileName: imageData.fileName || 'pasted-image.png',
                            caption: imageData.caption || ''
                        });
                    },
                    onFilesPaste: (files) => {
                        if (this._genericDropHandler
                            && typeof this._genericDropHandler.dispatchFiles === 'function') {
                            this._genericDropHandler.dispatchFiles(files);
                        }
                    }
                }
            );
        }

        if (window.genericDropHandler) {
            this._genericDropHandler = window.genericDropHandler.attachGenericDropHandler({
                containerEl: terminalContainer,
                getWorkingDir: () => (this.app && typeof this.app.getSessionWorkingDir === 'function'
                    ? this.app.getSessionWorkingDir(this.sessionId) : null),
                getAuthToken: () => (window.authManager && window.authManager.getToken
                    ? window.authManager.getToken() : null),
                onImageDrop: () => {},
                injectAtPath: (atPath) => {
                    if (!atPath) return;
                    let normalized = attachClipboardHandler.normalizeLineEndings(atPath + ' ');
                    if (this.terminal?.modes?.bracketedPasteMode) {
                        normalized = attachClipboardHandler.wrapBracketedPaste(normalized);
                    }
                    this.sendInput(normalized);
                },
                onError: (basename, message) => {
                    if (window.feedback && typeof window.feedback.error === 'function') {
                        window.feedback.error(basename + ': ' + message);
                    }
                }
            });
        }

        this.terminal.onData((data) => this.sendInput(data));
        this.fit();
    }

    _currentFence() {
        return {
            socketGeneration: this._socketGeneration,
            transitionId: this._transitionId,
            sessionId: this.desiredSessionId
        };
    }

    _transitionIsCurrent(fence) {
        return !!fence
            && fence.sessionId === this.desiredSessionId
            && Number(fence.transitionId) === Number(this._transitionId);
    }

    _fenceMatches(fence) {
        return this._transitionIsCurrent(fence)
            && fence.socketGeneration === this._socketGeneration;
    }

    _messageMatches(message, fence) {
        if (!message || typeof message !== 'object') return true;
        if (message.sessionId && message.sessionId !== fence.sessionId) return false;
        if (message.transitionId != null
            && Number(message.transitionId) !== Number(fence.transitionId)) return false;
        return true;
    }

    _sendControl(message, expectedFence) {
        const fence = expectedFence || this._currentFence();
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this._fenceMatches(fence)) {
            return false;
        }
        const payload = Object.assign({}, message);
        if (payload.sessionId == null && fence.sessionId) payload.sessionId = fence.sessionId;
        if (payload.transitionId == null && fence.transitionId != null) payload.transitionId = fence.transitionId;
        if (payload.viewId == null) payload.viewId = this._viewId;
        try {
            this.socket.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            console.warn(`[Split ${this.index}] control send failed:`, error && error.message);
            return false;
        }
    }

    sendInput(data, expectedFence) {
        if (!data) return false;
        return this._sendControl({ type: 'input', data }, expectedFence);
    }

    _clearJoinTimer() {
        if (this._joinTimer) {
            clearTimeout(this._joinTimer);
            this._joinTimer = null;
        }
    }

    _invalidateReplay() {
        this._repaintGeneration += 1;
        this._replayInProgress = false;
        this._replayState = null;
        this._repainting = false;
        if (this._repaintTimer) {
            clearTimeout(this._repaintTimer);
            this._repaintTimer = null;
        }
    }

    _startTransition(sessionId) {
        this._transitionGeneration += 1;
        this.transitionGeneration = this._transitionGeneration;
        this._transitionId = this._transitionGeneration;
        this.transitionId = this._transitionId;
        this.desiredSessionId = sessionId || null;
        this.sessionId = this.desiredSessionId;
        this.committedSessionId = null;
        this.paintedSessionId = null;
        this._focusedSessionId = null;
        this._joinAcked = false;
        this._awaitingJoinAck = false;
        this._geometrySeen = null;
        this._geometryApplied = null;
        this._geometryIsOwner = null;
        this._preAckQuarantine.length = 0;
        this._preAckBytes = 0;
        this._pendingWrites.length = 0;
        this._pendingWriteBytes = 0;
        this._invalidateReplay();
        this._clearJoinTimer();
        return this._currentFence();
    }

    async setSession(sessionId) {
        const nextId = sessionId || null;
        if (this.desiredSessionId === nextId) {
            if (this._connectWaiter && !this._connectWaiter.settled) return this._connectWaiter.promise;
            if (!nextId && !this.socket) return { success: true, fence: this._currentFence() };
        }

        // User retargeting invalidates the old socket, reconnect timer, replay
        // callback, and all queued bytes before the new transition is created.
        this.disconnect({ preserveIdentity: true });
        const fence = this._startTransition(nextId);
        if (!nextId) {
            this.updateActiveState();
            return { success: true, fence };
        }
        const result = await this.connect(nextId, fence);
        this.updateActiveState();
        return result;
    }

    _makeConnectWaiter(fence) {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        return { fence, promise, resolve, settled: false };
    }

    _settleConnectWaiter(success, fence) {
        const waiter = this._connectWaiter;
        if (!waiter || waiter.settled) return;
        if (fence && Number(waiter.fence.transitionId) !== Number(fence.transitionId)) return;
        if (fence && waiter.fence.sessionId !== fence.sessionId) return;
        waiter.settled = true;
        waiter.resolve({ success, fence: fence || waiter.fence });
    }

    _requestReplayJoin(fence) {
        if (!this._fenceMatches(fence) || !this.desiredSessionId) return false;
        this._awaitingJoinAck = true;
        return this._sendControl({
            type: 'join_session',
            sessionId: this.desiredSessionId,
            transitionId: this._transitionId,
            viewId: this._viewId
        }, fence);
    }

    async connect(sessionId, expectedFence) {
        const targetId = sessionId || null;
        if (!targetId) return { success: false, reason: 'missing-session' };

        let transitionId;
        if (expectedFence && this._transitionIsCurrent(expectedFence)) {
            transitionId = expectedFence.transitionId;
        } else if (this.desiredSessionId === targetId && this._transitionId != null) {
            transitionId = this._transitionId;
        } else {
            this.disconnect({ preserveIdentity: true });
            transitionId = this._startTransition(targetId).transitionId;
        }

        const protocol = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
        const host = typeof location !== 'undefined' ? location.host : '';
        let wsUrl = `${protocol}//${host}`;
        if (window.authManager) wsUrl = window.authManager.getWebSocketUrl(wsUrl);

        this._closing = false;
        this._socketGeneration += 1;
        this.socketGeneration = this._socketGeneration;
        const socketFence = {
            socketGeneration: this._socketGeneration,
            transitionId,
            sessionId: targetId
        };
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        this.socket = ws;
        this.connectionId = null;
        this._joinAcked = false;
        this._awaitingJoinAck = false;

        if (!this._connectWaiter || this._connectWaiter.settled
            || Number(this._connectWaiter.fence.transitionId) !== Number(transitionId)
            || this._connectWaiter.fence.sessionId !== targetId) {
            this._connectWaiter = this._makeConnectWaiter(socketFence);
        } else {
            this._connectWaiter.fence = socketFence;
        }

        const isCurrent = () => ws === this.socket && this._fenceMatches(socketFence);
        ws.onopen = () => {
            if (!isCurrent()) return;
            this._reconnectAttempts = 0;
            this._startHeartbeat();
            this._requestReplayJoin(socketFence);
            this.fit();
            this._clearJoinTimer();
            this._joinTimer = setTimeout(() => {
                if (isCurrent() && this._awaitingJoinAck) this._recoverReplay('join-timeout', socketFence);
            }, SPLIT_REPLAY_TIMEOUT_MS);
        };

        ws.onmessage = (event) => {
            if (!isCurrent()) return;
            if (splitIsBinary(event.data)) {
                const chunk = splitToUint8Array(event.data);
                if (!chunk) return;
                if (!this._joinAcked) this._quarantinePreAck(chunk, socketFence);
                else this._enqueueOrdered({ kind: 'binary', value: chunk }, socketFence);
                return;
            }
            try {
                const message = JSON.parse(event.data);
                if (!this._messageMatches(message, socketFence)) return;
                if (message.type === 'connected') {
                    this.handleMessage(message, socketFence);
                } else if (message.type === 'pong') {
                    this.handleMessage(message, socketFence);
                } else if (message.type === 'session_joined') {
                    this.handleMessage(message, socketFence);
                } else if (message.type === 'geometry_applied') {
                    this.handleMessage(message, socketFence);
                } else if (!this._joinAcked) {
                    this._quarantinePreAck(message, socketFence);
                } else {
                    this._enqueueOrdered({ kind: 'json', value: message }, socketFence);
                }
            } catch (error) {
                console.error(`[Split ${this.index}] Error handling message:`, error);
            }
        };

        ws.onclose = () => {
            if (!isCurrent()) return;
            if (this._heartbeat) {
                this._heartbeat.stop();
                this._heartbeat = null;
            }
            this._clearJoinTimer();
            const buffer = this.terminal && this.terminal.buffer && this.terminal.buffer.active;
            this._reconnectViewState = {
                sessionId: this.committedSessionId || this.desiredSessionId,
                viewportY: buffer ? buffer.viewportY : 0,
                selection: this.terminal && this.terminal.getSelectionPosition
                    ? this.terminal.getSelectionPosition() : null
            };
            // Replay is authoritative on reconnect. Do not paint stale bytes
            // accepted by the closed socket a second time after reset/replay.
            this._pendingWrites.length = 0;
            this._pendingWriteBytes = 0;
            this._preAckQuarantine.length = 0;
            this._preAckBytes = 0;
            this._joinAcked = false;
            this._awaitingJoinAck = false;
            this.committedSessionId = null;
            this._invalidateReplay();

            if (this._closing || this._reconnectAttempts >= this._maxReconnectAttempts) {
                this._settleConnectWaiter(false, socketFence);
                return;
            }
            const n = this._reconnectAttempts;
            const delay = n === 0 ? 250
                : Math.min(1000 * Math.pow(2, n), 30000) * (0.7 + Math.random() * 0.6);
            this._reconnectAttempts += 1;
            if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
            const reconnectFence = {
                transitionId: socketFence.transitionId,
                sessionId: socketFence.sessionId
            };
            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                if (this._closing || !this._transitionIsCurrent(reconnectFence)) return;
                this.connect(this.desiredSessionId, reconnectFence).catch((error) => {
                    console.error(`[Split ${this.index}] Reconnect failed:`, error);
                });
            }, delay);
        };

        ws.onerror = (error) => {
            if (isCurrent()) console.error(`[Split ${this.index}] WebSocket error:`, error);
        };
        return this._connectWaiter.promise;
    }

    _startHeartbeat() {
        if (this._heartbeat) this._heartbeat.stop();
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN
            || typeof HeartbeatWatchdog === 'undefined') return;
        this._heartbeat = new HeartbeatWatchdog({
            socket: this.socket,
            generation: this._socketGeneration,
            currentGeneration: () => this._socketGeneration,
            currentSocket: () => this.socket,
            log: (message) => console.warn(`[Split ${this.index}] heartbeat:`, message)
        });
        this._heartbeat.start();
        this._heartbeatTimer = null;
        this._pongTimer = null;
    }

    _quarantinePreAck(value, fence) {
        if (!this._fenceMatches(fence)) return;
        const bytes = splitByteLength(value);
        if (bytes > SPLIT_PRE_ACK_MAX_BYTES
            || this._preAckBytes + bytes > SPLIT_PRE_ACK_MAX_BYTES
            || this._preAckQuarantine.length >= SPLIT_PRE_ACK_MAX_ENTRIES) {
            this._preAckQuarantine.length = 0;
            this._preAckBytes = 0;
            this._preAckDropped += 1;
            this._showRecovery('Split output arrived before acknowledgement and was dropped.');
            return;
        }
        this._preAckQuarantine.push({
            kind: splitIsBinary(value) ? 'binary' : 'json',
            value
        });
        this._preAckBytes += bytes;
    }

    _enqueueOrdered(item, fence) {
        if (!item || !this._fenceMatches(fence)) return;
        const bytes = splitByteLength(item.value);
        if (bytes > this._maxReplayQueueBytes
            || this._pendingWriteBytes + bytes > this._maxReplayQueueBytes
            || this._pendingWrites.length >= this._maxReplayQueueEntries) {
            this._pendingWrites.length = 0;
            this._pendingWriteBytes = 0;
            this._showRecovery('Split output queue overflowed; rebuilding the pane.');
            this._recoverReplay('queue-overflow', fence);
            return;
        }
        this._pendingWrites.push(item);
        this._pendingWriteBytes += bytes;
        if (!this._replayInProgress) this._scheduleOutputFlush();
    }

    _showRecovery(message) {
        try {
            if (window.feedback && typeof window.feedback.warning === 'function') {
                window.feedback.warning(message);
            }
        } catch (_) {}
        console.warn(`[Split ${this.index}] ${message}`);
    }

    _recoverReplay(reason, fence) {
        if (!this._fenceMatches(fence) || !this.desiredSessionId) return;
        this._replayRecoveryCount += 1;
        this._showRecovery(`Split replay recovery (${reason}); requesting a fresh bounded replay.`);
        this._pendingWrites.length = 0;
        this._pendingWriteBytes = 0;
        this._preAckQuarantine.length = 0;
        this._preAckBytes = 0;
        this._joinAcked = false;
        this._awaitingJoinAck = true;
        this._invalidateReplay();
        this._clearJoinTimer();
        this._requestReplayJoin(fence);
        this._joinTimer = setTimeout(() => {
            if (this._fenceMatches(fence) && this._awaitingJoinAck) {
                this._showRecovery('Split replay did not complete; retaining the last confirmed screen.');
            }
        }, SPLIT_REPLAY_TIMEOUT_MS);
    }

    _scheduleOutputFlush() {
        if (this._rafPending || this._repainting || this._replayInProgress) return;
        this._rafPending = true;
        this._rafHandle = splitRequestFrame(() => this._flushOutput());
    }

    _flushOutput() {
        this._rafPending = false;
        this._rafHandle = null;
        if (this._repainting || this._replayInProgress || this._pendingWrites.length === 0) return;
        const first = this._pendingWrites[0];
        if (first.kind === 'binary') {
            const chunks = [];
            let bytes = 0;
            while (this._pendingWrites.length && bytes < SPLIT_OUTPUT_FRAME_BUDGET
                && this._pendingWrites[0].kind === 'binary') {
                const item = this._pendingWrites[0];
                const remaining = SPLIT_OUTPUT_FRAME_BUDGET - bytes;
                if (item.value.byteLength <= remaining) {
                    chunks.push(item.value);
                    this._pendingWrites.shift();
                    this._pendingWriteBytes -= item.value.byteLength;
                    bytes += item.value.byteLength;
                } else {
                    chunks.push(item.value.subarray(0, remaining));
                    this._pendingWrites[0] = {
                        kind: 'binary',
                        value: item.value.subarray(remaining)
                    };
                    this._pendingWriteBytes -= remaining;
                    bytes += remaining;
                }
            }
            const combined = new Uint8Array(bytes);
            let offset = 0;
            chunks.forEach((chunk) => {
                combined.set(chunk, offset);
                offset += chunk.byteLength;
            });
            this.terminal.write(combined);
        } else {
            const item = this._pendingWrites.shift();
            this._pendingWriteBytes -= splitByteLength(item.value);
            this._writeOrderedItem(item);
        }
        if (this._pendingWrites.length) this._scheduleOutputFlush();
    }

    _writeOrderedItem(item) {
        if (!item) return;
        if (item.kind === 'binary') {
            this.terminal.write(item.value);
        } else if (item.value.type === 'output') {
            this.terminal.write(item.value.data || '');
        } else {
            this._writeLifecycle(item.value);
        }
    }

    _writeLifecycle(message) {
        switch (message.type) {
            case 'exit':
                this.terminal.write(`\r\n[Process exited${message.code != null ? ` with code ${message.code}` : ''}]\r\n`);
                break;
            case 'error':
                this.terminal.write(`\r\n\x1b[31mError: ${message.message || 'Unknown split error'}\x1b[0m\r\n`);
                break;
            case 'image_upload_error':
                this.terminal.write(`\r\n\x1b[31m[Image upload error] ${message.message || ''}\x1b[0m\r\n`);
                break;
            case 'image_upload_complete':
                this._injectImagePath(message);
                break;
            case 'claude_started':
            case 'codex_started':
            case 'copilot_started':
            case 'gemini_started':
            case 'terminal_started':
            case 'agent_started':
                console.log(`[Split ${this.index}] Agent started`);
                break;
            default:
                break;
        }
    }

    _injectImagePath(message) {
        if (!message || !message.filePath) return;
        const caption = this._pendingImageCaption || '';
        const quotedPath = '"' + String(message.filePath).replace(/\\/g, '/') + '"';
        const inputText = caption ? caption + ' ' + quotedPath : quotedPath;
        const clipboard = window.attachClipboardHandler;
        let normalized = clipboard ? clipboard.normalizeLineEndings(inputText) : inputText;
        if (this.terminal?.modes?.bracketedPasteMode && clipboard) {
            normalized = clipboard.wrapBracketedPaste(normalized);
        }
        this.sendInput(normalized);
        this._pendingImageCaption = null;
    }

    _boundedReplayText(message) {
        const outputBuffer = Array.isArray(message.outputBuffer) ? message.outputBuffer : [];
        let text;
        if (message.active === true) {
            text = outputBuffer.join('');
        } else if (typeof message.renderedSnapshot === 'string') {
            text = message.renderedSnapshot.replace(/\r?\n/g, '\r\n');
        } else {
            text = outputBuffer.join('');
        }
        if (splitByteLength(text) <= SPLIT_REPLAY_MAX_BYTES) return text;
        this._showRecovery('Split replay exceeded its display budget; showing the newest bounded tail.');
        return text.slice(-SPLIT_REPLAY_MAX_BYTES);
    }

    async _waitForFit(fence) {
        if (!this._fenceMatches(fence)) return false;
        let result;
        try { result = this.fit(); } catch (_) { result = null; }
        if (result && typeof result.then === 'function') {
            try { await Promise.race([result, new Promise((resolve) => setTimeout(resolve, 100))]); }
            catch (_) {}
            return this._fenceMatches(fence);
        }
        await new Promise((resolve) => {
            let finished = false;
            const done = () => {
                if (finished) return;
                finished = true;
                resolve();
            };
            try { splitRequestFrame(done); } catch (_) { done(); }
            setTimeout(done, 50);
        });
        return this._fenceMatches(fence);
    }

    async _finishReplay(generation, restoreView, view, fence) {
        if (generation !== this._repaintGeneration || !this._fenceMatches(fence)) return;
        if (this._repaintTimer) {
            clearTimeout(this._repaintTimer);
            this._repaintTimer = null;
        }
        const fitSettled = await this._waitForFit(fence);
        if (!fitSettled || generation !== this._repaintGeneration || !this._fenceMatches(fence)) return;
        this._repainting = false;
        this._replayInProgress = false;
        if (restoreView !== false && view) {
            const buffer = this.terminal.buffer && this.terminal.buffer.active;
            if (buffer) this.terminal.scrollToLine(Math.min(view.viewportY, Math.max(0, buffer.baseY)));
            const selection = view.selection;
            if (selection && selection.start && selection.end) {
                const length = Math.max(0, (selection.end.y - selection.start.y) * this.terminal.cols
                    + selection.end.x - selection.start.x);
                if (length > 0) this.terminal.select(selection.start.x, selection.start.y, length);
            }
        }
        try { this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1)); } catch (_) {}
        this.paintedSessionId = this.committedSessionId;
        this._settleConnectWaiter(true, fence);

        // Binary received before the acknowledgement has no session tag and is
        // unsafe to paint. JSON lifecycle messages are retained when bounded;
        // they are useful to legacy servers and remain behind the replay.
        const preAck = this._preAckQuarantine.splice(0);
        this._preAckBytes = 0;
        for (const item of preAck) {
            if (item.kind !== 'binary') this._enqueueOrdered(item, fence);
        }
        this._scheduleOutputFlush();
    }

    _beginReplay(message, fence) {
        if (!this._fenceMatches(fence) || !this.desiredSessionId) return;
        if (!this._messageMatches(message, fence)) return;
        if (!this._awaitingJoinAck && this._joinAcked) return;
        this._awaitingJoinAck = false;
        this._joinAcked = true;
        this.committedSessionId = message.sessionId || this.desiredSessionId;
        if (this.committedSessionId !== this.desiredSessionId) return;
        this._clearJoinTimer();
        if (message.geometry) this._applyGeometry(message.geometry, fence);
        else {
            this._geometrySeen = null;
            this._geometryApplied = null;
            this._geometryIsOwner = null;
        }

        this._replayInProgress = true;
        this._repainting = true;
        const generation = ++this._repaintGeneration;
        const reconnectView = this._reconnectViewState
            && this._reconnectViewState.sessionId === this.committedSessionId
            ? this._reconnectViewState : null;
        this._reconnectViewState = null;
        const replayText = this._boundedReplayText(message);
        if (this._repaintTimer) clearTimeout(this._repaintTimer);
        this._repaintTimer = setTimeout(() => {
            if (generation !== this._repaintGeneration || !this._fenceMatches(fence)) return;
            this._showRecovery('Split replay timed out; releasing bounded live output.');
            void this._finishReplay(generation, false, null, fence).catch((error) => {
                console.warn(`[Split ${this.index}] replay timeout recovery failed:`, error);
            });
        }, SPLIT_REPLAY_TIMEOUT_MS);

        const writeReplay = () => {
            if (generation !== this._repaintGeneration || !this._fenceMatches(fence)) return;
            try {
                this.terminal.write('\x1bc' + replayText, () => {
                    try {
                        this.terminal.write('', () => {
                            void this._finishReplay(generation, true, reconnectView, fence).catch((error) => {
                                console.warn(`[Split ${this.index}] replay completion failed:`, error);
                            });
                        });
                    } catch (_) {
                        void this._finishReplay(generation, false, null, fence).catch(() => {});
                    }
                });
            } catch (_) {
                void this._finishReplay(generation, false, null, fence).catch(() => {});
            }
        };
        try { this.terminal.write('', writeReplay); } catch (_) { writeReplay(); }
    }

    handleMessage(message, fence) {
        const currentFence = fence || this._currentFence();
        if (!this._fenceMatches(currentFence) || !this._messageMatches(message, currentFence)) return;
        switch (message.type) {
            case 'connected':
                this.connectionId = message.connectionId || null;
                break;
            case 'session_joined':
                this._beginReplay(message, currentFence);
                break;
            case 'geometry_applied':
                this._applyGeometry(message.geometry || message, currentFence);
                break;
            case 'pong':
                if (this._heartbeat) this._heartbeat.onPong();
                break;
            default:
                if (!this._joinAcked) this._quarantinePreAck(message, currentFence);
                else this._enqueueOrdered({ kind: 'json', value: message }, currentFence);
                break;
        }
    }

    _applyGeometry(message, fence) {
        if (!message || !this._fenceMatches(fence)) return;
        const epoch = Number.isInteger(message.epoch) ? message.epoch : 0;
        const revision = Number.isInteger(message.revision) ? message.revision : 0;
        if (this._geometrySeen && this._geometrySeen.sessionId === this.committedSessionId
            && (epoch < this._geometrySeen.epoch
                || (epoch === this._geometrySeen.epoch && revision < this._geometrySeen.revision))) return;
        const cols = message.cols;
        const rows = message.rows;
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
        this._geometrySeen = { sessionId: this.committedSessionId, epoch, revision };
        this._geometryApplied = { cols, rows };
        this._geometryIsOwner = !!(message.owner && this.connectionId
            && message.owner.connectionId === this.connectionId);
        try {
            if (this.app.fitCoordinator && typeof this.app.fitCoordinator.applyAuthoritative === 'function') {
                this.app.fitCoordinator.applyAuthoritative(this._fitId, { cols, rows });
            }
        } catch (_) {}
        try { this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1)); } catch (_) {}
    }

    disconnect(options = {}) {
        this._closing = true;
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
        this._clearJoinTimer();
        if (this.socket) {
            try { this.socket.close(); } catch (_) {}
            this.socket = null;
        }
        if (this._connectWaiter && !this._connectWaiter.settled) {
            this._settleConnectWaiter(false, this._connectWaiter.fence);
        }
        this._connectWaiter = null;
        this._socketGeneration += 1;
        this.socketGeneration = this._socketGeneration;
        this.connectionId = null;
        this._joinAcked = false;
        this._awaitingJoinAck = false;
        this.committedSessionId = null;
        this._pendingWrites.length = 0;
        this._pendingWriteBytes = 0;
        this._preAckQuarantine.length = 0;
        this._preAckBytes = 0;
        this._invalidateReplay();
        if (this._rafHandle !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this._rafHandle);
        }
        this._rafHandle = null;
        this._rafPending = false;
        if (!options.preserveIdentity) {
            this.sessionId = null;
            this.desiredSessionId = null;
            this.paintedSessionId = null;
            this._focusedSessionId = null;
        }
    }

    fit() {
        if (!this.app || !this.app.fitCoordinator) return undefined;
        return this.app.fitCoordinator.request(this._fitId);
    }

    updateActiveState() {
        if (!this.container) return;
        if (this.isActive) this.container.classList.add('split-active');
        else this.container.classList.remove('split-active');
    }

    clear() {
        this.disconnect();
        this.sessionId = null;
        this.desiredSessionId = null;
        this.committedSessionId = null;
        this.paintedSessionId = null;
        this.isActive = false;
        if (this.terminal) this.terminal.clear();
        this.updateActiveState();
    }

    destroy() {
        this.disconnect();
        if (this.app && this.app.fitCoordinator) this.app.fitCoordinator.unregister(this._fitId);
        try { if (this._genericDropHandler?.destroy) this._genericDropHandler.destroy(); } catch (_) {}
        try { if (this._imageHandler?.destroy) this._imageHandler.destroy(); } catch (_) {}
        try { if (this._wheelHandler?.dispose) this._wheelHandler.dispose(); } catch (_) {}
        if (this.terminal) this.terminal.dispose();
    }
}

class SplitContainer {
    constructor(app) {
        this.app = app;
        this.enabled = false;
        this.splits = [];
        this.activeSplitIndex = 0;
        this.dividerPosition = 50;
        this.createSplitElements();
        this.restoreState();
        this.setupKeyboardShortcuts();
    }

    createSplitElements() {
        const main = document.querySelector('.main');
        if (!main) return;

        this.splitContainerEl = document.createElement('div');
        this.splitContainerEl.className = 'split-container';
        this.splitContainerEl.style.display = 'none';

        const leftSplit = document.createElement('div');
        leftSplit.className = 'split-pane split-left';
        leftSplit.dataset.splitIndex = '0';

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

        const rightSplit = document.createElement('div');
        rightSplit.className = 'split-pane split-right';
        rightSplit.dataset.splitIndex = '1';

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

        this.splits.push(new Split(leftSplit, 0, this.app));
        this.splits.push(new Split(rightSplit, 1, this.app));
        this.splits[0].isActive = true;
        this.splits[0].updateActiveState();
        leftSplit.addEventListener('click', () => this.focusSplit(0));
        rightSplit.addEventListener('click', () => this.focusSplit(1));
    }

    setupDividerDrag() {
        let isDragging = false;
        let startX = 0;
        let startPosition = 50;

        this.divider.addEventListener('mousedown', (event) => {
            isDragging = true;
            startX = event.clientX;
            startPosition = this.dividerPosition;
            document.body.style.cursor = 'col-resize';
            event.preventDefault();
        });
        document.addEventListener('mousemove', (event) => {
            if (!isDragging) return;
            const rect = this.splitContainerEl.getBoundingClientRect();
            const deltaPercent = ((event.clientX - startX) / rect.width) * 100;
            this.dividerPosition = Math.max(20, Math.min(80, startPosition + deltaPercent));
            this.updateDividerPosition();
        });
        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            document.body.style.cursor = '';
            this.saveState();
        });
        this.divider.addEventListener('keydown', (event) => {
            let next = this.dividerPosition;
            if (event.key === 'ArrowLeft') next -= 5;
            else if (event.key === 'ArrowRight') next += 5;
            else if (event.key === 'Home') next = 20;
            else if (event.key === 'End') next = 80;
            else return;
            event.preventDefault();
            this.dividerPosition = Math.max(20, Math.min(80, next));
            this.updateDividerPosition();
            this.saveState();
        });
    }

    updateDividerPosition() {
        const left = this.splitContainerEl.querySelector('.split-left');
        const right = this.splitContainerEl.querySelector('.split-right');
        if (!left || !right) return;
        left.style.width = `${this.dividerPosition}%`;
        right.style.width = `${100 - this.dividerPosition}%`;
        this.divider.setAttribute('aria-valuenow', String(Math.round(this.dividerPosition)));
        this.splits.forEach((split) => split.fit());
    }

    async createSplit(sessionId) {
        if (this.enabled) return;
        const availableWidth = document.querySelector('.main')?.getBoundingClientRect().width || window.innerWidth;
        if (availableWidth < 700) {
            if (window.feedback) window.feedback.info('Split view needs a wider screen. Use session tabs on this device.');
            return;
        }
        this.enabled = true;
        const terminalContainer = document.getElementById('terminalContainer');
        if (terminalContainer) terminalContainer.style.display = 'none';
        this.splitContainerEl.style.display = 'flex';
        this.updateDividerPosition();

        const currentSessionId = this.app.currentClaudeSessionId;
        await Promise.all([
            this.splits[0].setSession(currentSessionId),
            this.splits[1].setSession(sessionId)
        ]);
        this.focusSplit(1);
        this.saveState();
        console.log(`[SplitContainer] Created split with sessions: ${currentSessionId} | ${sessionId}`);
    }

    closeSplit() {
        if (!this.enabled) return;
        this.enabled = false;
        this.splits.forEach((split) => split.clear());

        const terminalContainer = document.getElementById('terminalContainer');
        if (terminalContainer) terminalContainer.style.display = 'flex';
        this.splitContainerEl.style.display = 'none';
        this.activeSplitIndex = 0;
        this.splits.forEach((split, index) => {
            split.isActive = index === 0;
            split.updateActiveState();
        });

        // Main membership was never changed by split focus. Refit its existing
        // terminal without opening a competing socket or creating a blank gap.
        if (this.app && this.app.fitCoordinator) {
            this.app.fitCoordinator.request('main', { forceSend: true });
        }
        this.saveState();
        console.log('[SplitContainer] Closed split, back to single pane');
    }

    focusSplit(index) {
        if (index < 0 || index >= this.splits.length) return;
        this.splits.forEach((split, splitIndex) => {
            split.isActive = splitIndex === index;
            split.updateActiveState();
        });
        this.activeSplitIndex = index;
        const split = this.splits[index];
        const focusedSessionId = split.desiredSessionId || split.sessionId || null;
        if (this.app) {
            this.app._lastFocusedPaneIndex = index;
            if (typeof this.app.setFocusedPaneSessionId === 'function') {
                this.app.setFocusedPaneSessionId(focusedSessionId);
            } else if (typeof this.app.setFocusedPaneIdentity === 'function') {
                this.app.setFocusedPaneIdentity(focusedSessionId);
            }
        }
        split._focusedSessionId = focusedSessionId;
        if (split.terminal) split.terminal.focus();
        console.log(`[SplitContainer] Focused split ${index}, session: ${focusedSessionId}`);
    }

    getActiveSplit() {
        if (!Number.isInteger(this.activeSplitIndex)) return null;
        return this.splits[this.activeSplitIndex] || null;
    }

    getActiveSessionId() {
        const split = this.getActiveSplit();
        return split ? (split.desiredSessionId || split.sessionId || null) : null;
    }

    sendInput(data, expectedFence) {
        const split = this.getActiveSplit();
        return split ? split.sendInput(data, expectedFence) : false;
    }

    async onTabSwitch(sessionId) {
        if (!this.enabled) return;
        const split = this.getActiveSplit();
        if (split) return split.setSession(sessionId);
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
                event.preventDefault();
                if (this.enabled) this.closeSplit();
                else console.log('[SplitContainer] Drag a tab to the right edge to create a split');
            }
            if ((event.metaKey || event.ctrlKey) && this.enabled) {
                if (event.key === '1') {
                    event.preventDefault();
                    this.focusSplit(0);
                } else if (event.key === '2') {
                    event.preventDefault();
                    this.focusSplit(1);
                }
            }
        });
    }

    saveState() {
        try {
            localStorage.setItem('cc-web-splits', JSON.stringify({
                enabled: this.enabled,
                dividerPosition: this.dividerPosition,
                activeSplitIndex: this.activeSplitIndex,
                sessions: this.splits.map((split) => split.desiredSessionId || split.sessionId)
            }));
        } catch (error) {
            console.error('Failed to save split state:', error);
        }
    }

    restoreState() {
        try {
            const saved = localStorage.getItem('cc-web-splits');
            if (!saved) return;
            const state = JSON.parse(saved);
            if (state.dividerPosition) this.dividerPosition = state.dividerPosition;
        } catch (error) {
            console.error('Failed to restore split state:', error);
        }
    }

    setupDropZones() {
        const terminalContainer = document.getElementById('terminalContainer');
        if (!terminalContainer) return;

        const dropZone = document.createElement('div');
        dropZone.className = 'split-drop-zone';
        dropZone.style.display = 'none';
        terminalContainer.appendChild(dropZone);

        terminalContainer.addEventListener('dragover', (event) => {
            if (this.enabled) return;
            const dataTransfer = event.dataTransfer;
            const sessionId = dataTransfer?.getData('application/x-session-id');
            let hasSessionPayload = !!sessionId;
            if (!hasSessionPayload && dataTransfer && dataTransfer.types) {
                try {
                    hasSessionPayload = Array.from(dataTransfer.types).includes('application/x-session-id');
                } catch (_) {}
            }
            if (!hasSessionPayload) return;
            if (sessionId && sessionId === this.app.currentClaudeSessionId) return;
            event.preventDefault();
            if (dataTransfer) dataTransfer.dropEffect = 'move';
            const rect = terminalContainer.getBoundingClientRect();
            dropZone.style.display = event.clientX > rect.right - 100 ? 'block' : 'none';
        });

        terminalContainer.addEventListener('dragleave', () => {
            dropZone.style.display = 'none';
        });

        terminalContainer.addEventListener('drop', async (event) => {
            const sessionId = event.dataTransfer?.getData('application/x-session-id');
            if (!sessionId) return;
            if (sessionId === this.app.currentClaudeSessionId) {
                dropZone.style.display = 'none';
                return;
            }
            const rect = terminalContainer.getBoundingClientRect();
            if (event.clientX > rect.right - 100 && !this.enabled) {
                event.preventDefault();
                await this.createSplit(sessionId);
            }
            dropZone.style.display = 'none';
        });
    }
}

window.SplitContainer = SplitContainer;
