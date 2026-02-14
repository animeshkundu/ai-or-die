function _esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

class SessionTabManager {
    constructor(claudeInterface) {
        this.claudeInterface = claudeInterface;
        this.tabs = new Map(); // sessionId -> tab element
        this.activeSessions = new Map(); // sessionId -> session data
        this.activeTabId = null;
        this.tabOrder = []; // visual order of tabs
        this.tabHistory = []; // most recently used order
        this.notificationsEnabled = false;
        this.idleTimeoutMs = 90000;
        this._deletingSessionIds = new Set();
        this.requestNotificationPermission();
    }

    getAlias(kind) {
        if (this.claudeInterface && typeof this.claudeInterface.getAlias === 'function') {
            return this.claudeInterface.getAlias(kind);
        }
        return kind === 'codex' ? 'Codex' : 'Claude';
    }
    
    requestNotificationPermission() {
        if ('Notification' in window) {
            if (Notification.permission === 'default') {
                // Request permission
                Notification.requestPermission().then(permission => {
                    this.notificationsEnabled = permission === 'granted';
                    if (this.notificationsEnabled) {
                        console.log('Desktop notifications enabled');
                    } else {
                        console.log('Desktop notifications denied');
                    }
                });
            } else if (Notification.permission === 'granted') {
                this.notificationsEnabled = true;
                console.log('Desktop notifications already enabled');
            } else {
                this.notificationsEnabled = false;
                console.log('Desktop notifications blocked');
            }
        } else {
            console.log('Desktop notifications not supported in this browser');
        }
    }
    
    /**
     * Send a notification for a background session event.
     * @param {object|string} opts - Notification options object, or title string (legacy)
     * @param {string} [legacyBody] - Body text (legacy positional arg)
     * @param {string} [legacySessionId] - Session ID (legacy positional arg)
     */
    sendNotification(opts, legacyBody, legacySessionId) {
        // Support both object and legacy positional args
        let title, body, sessionId, notifType;
        if (typeof opts === 'object' && opts !== null) {
            ({ title, body, sessionId, type: notifType } = opts);
        } else {
            title = opts;
            body = legacyBody;
            sessionId = legacySessionId;
        }

        // Don't send notification for active tab
        if (sessionId === this.activeTabId) return;

        // Prepend hostname for multi-machine context
        const hostname = this.claudeInterface?.hostname || '';
        const fullTitle = hostname ? `[${hostname}] ${title}` : title;

        // Check user preference for desktop notifications
        const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
        const desktopEnabled = settings.notifDesktop !== false;

        // Try desktop notifications when the page is not visible
        if (document.visibilityState !== 'visible' && desktopEnabled) {
            if ('Notification' in window && Notification.permission === 'granted') {
                // Prefer service worker showNotification() for Windows Notification Center
                if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.ready.then(registration => {
                        registration.showNotification(fullTitle, {
                            body: body,
                            icon: '/favicon.ico',
                            tag: sessionId,
                            requireInteraction: false,
                            silent: false,
                            data: { sessionId },
                            actions: [
                                { action: 'switch-tab', title: 'Open Session' }
                            ]
                        });
                    }).catch(err => {
                        console.error('SW showNotification failed:', err);
                    });
                    console.log(`Desktop notification sent (SW): ${fullTitle}`);
                    return;
                }

                // Fallback to basic Notification API
                try {
                    const notification = new Notification(fullTitle, {
                        body: body,
                        icon: '/favicon.ico',
                        tag: sessionId,
                        requireInteraction: false,
                        silent: false
                    });

                    notification.onclick = () => {
                        window.focus();
                        this.switchToTab(sessionId);
                        notification.close();
                    };

                    setTimeout(() => notification.close(), 5000);
                    console.log(`Desktop notification sent: ${fullTitle}`);
                    return; // Desktop notification succeeded; no need for in-app toast
                } catch (error) {
                    console.error('Desktop notification failed:', error);
                }
            }
        }

        // In-app toast: show for background tabs even when page is visible
        this.showMobileNotification(fullTitle, body, sessionId, notifType);
    }

    showMobileNotification(title, body, sessionId, notifType) {
        // Update page title to show notification
        const originalTitle = document.title;
        let flashCount = 0;
        const flashInterval = setInterval(() => {
            document.title = flashCount % 2 === 0 ? `• ${title}` : originalTitle;
            flashCount++;
            if (flashCount > 6) {
                clearInterval(flashInterval);
                document.title = originalTitle;
            }
        }, 1000);
        
        // Try to vibrate if available (Android)
        if ('vibrate' in navigator) {
            try {
                navigator.vibrate([200, 100, 200]);
            } catch (e) {
                console.log('Vibration not available');
            }
        }
        
        // Show a toast-style notification at the top of the screen
        const toast = document.createElement('div');
        toast.className = 'mobile-notification';

        const titleEl = document.createElement('div');
        titleEl.className = 'mobile-notification-title';
        titleEl.textContent = title;
        const bodyEl = document.createElement('div');
        bodyEl.className = 'mobile-notification-body';
        bodyEl.textContent = body;
        toast.appendChild(titleEl);
        toast.appendChild(bodyEl);
        
        // Add CSS animation
        if (!document.querySelector('#mobileNotificationStyles')) {
            const style = document.createElement('style');
            style.id = 'mobileNotificationStyles';
            style.textContent = `
                @keyframes slideDown {
                    from {
                        transform: translateX(-50%) translateY(-100%);
                        opacity: 0;
                    }
                    to {
                        transform: translateX(-50%) translateY(0);
                        opacity: 1;
                    }
                }
                @keyframes slideUp {
                    from {
                        transform: translateX(-50%) translateY(0);
                        opacity: 1;
                    }
                    to {
                        transform: translateX(-50%) translateY(-100%);
                        opacity: 0;
                    }
                }
            `;
            document.head.appendChild(style);
        }
        
        toast.onclick = () => {
            this.switchToTab(sessionId);
            toast.style.animation = 'slideUp 0.3s ease-out';
            setTimeout(() => toast.remove(), 300);
        };
        
        document.body.appendChild(toast);
        
        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (toast.parentNode) {
                toast.style.animation = 'slideUp 0.3s ease-out';
                setTimeout(() => toast.remove(), 300);
            }
        }, 5000);
        
        // Play notification chime
        this.playNotificationChime(notifType || 'idle');
    }

    /**
     * Play a synthesized notification chime via Web Audio API.
     * @param {'success'|'error'|'idle'} type - The notification type
     */
    playNotificationChime(type = 'idle') {
        // Respect user mute setting
        const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
        if (settings.notifSound === false) return;

        const volume = typeof settings.notifVolume === 'number'
            ? (settings.notifVolume / 100) * 0.3
            : 0.3;
        if (volume <= 0) return;

        try {
            if (!this._audioCtx) {
                this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            const ctx = this._audioCtx;
            // Resume if suspended (browsers suspend after user gesture timeout)
            if (ctx.state === 'suspended') ctx.resume();
            const t = ctx.currentTime;

            if (type === 'success') {
                // Ascending two-tone: C5 (523Hz) → E5 (659Hz)
                this._playTone(ctx, t, 523, 'sine', volume, 0.15);
                this._playTone(ctx, t + 0.2, 659, 'sine', volume, 0.15);
            } else if (type === 'error') {
                // Descending two-tone: E4 (330Hz) → C4 (262Hz)
                this._playTone(ctx, t, 330, 'triangle', volume * 0.67, 0.12);
                this._playTone(ctx, t + 0.16, 262, 'triangle', volume * 0.67, 0.12);
            } else {
                // Idle: single soft tone G5 (784Hz)
                this._playTone(ctx, t, 784, 'sine', volume * 0.5, 0.2);
            }
        } catch (e) {
            console.log('Audio notification not available');
        }
    }

    /** @private Abbreviate a path to its last 2 segments */
    _abbreviatePath(dir) {
        if (!dir) return '';
        const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
        return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : dir;
    }

    /** @private Build rich notification body from session data */
    _buildNotifBody(session, duration) {
        const parts = [];
        if (session.workingDir) {
            parts.push(this._abbreviatePath(session.workingDir));
        }
        const agentType = session.toolType || 'claude';
        const agentName = this.getAlias(agentType);
        if (duration > 0) {
            parts.push(`${Math.round(duration / 1000)}s | ${agentName}`);
        } else {
            parts.push(agentName);
        }
        return parts.join('\n');
    }

    /** @private Play a single tone with gain envelope */
    _playTone(ctx, startTime, freq, waveform, gain, duration) {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        osc.connect(gainNode);
        gainNode.connect(ctx.destination);
        osc.type = waveform;
        osc.frequency.value = freq;
        gainNode.gain.setValueAtTime(gain, startTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
        osc.start(startTime);
        osc.stop(startTime + duration);
    }

    getOrderedTabIds() {
        // Filter out any ids that may have been removed without updating the order array
        this.tabOrder = this.tabOrder.filter(id => this.tabs.has(id));
        return [...this.tabOrder];
    }

    getOrderedTabElements() {
        return this.getOrderedTabIds()
            .map(id => this.tabs.get(id))
            .filter(Boolean);
    }

    syncOrderFromDom() {
        const tabsContainer = document.getElementById('tabsContainer');
        if (!tabsContainer) return;
        const ids = Array.from(tabsContainer.querySelectorAll('.session-tab'))
            .map(tab => tab.dataset.sessionId)
            .filter(Boolean);
        if (ids.length) {
            this.tabOrder = ids;
        }
    }

    ensureTabVisible(sessionId) {
        const tab = this.tabs.get(sessionId);
        if (!tab) return;
        const scrollContainer = tab.closest('.tabs-section');
        if (!scrollContainer) return;
        const tabRect = tab.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();

        if (tabRect.left < containerRect.left) {
            scrollContainer.scrollLeft += tabRect.left - containerRect.left - 16;
        } else if (tabRect.right > containerRect.right) {
            scrollContainer.scrollLeft += tabRect.right - containerRect.right + 16;
        }
    }

    updateTabHistory(sessionId) {
        this.tabHistory = this.tabHistory.filter(id => id !== sessionId && this.tabs.has(id));
        this.tabHistory.unshift(sessionId);
        if (this.tabHistory.length > 50) {
            this.tabHistory.length = 50;
        }
    }

    removeFromHistory(sessionId) {
        this.tabHistory = this.tabHistory.filter(id => id !== sessionId);
    }

    async init() {
        this.setupTabBar();
        this.setupKeyboardShortcuts();
        this.setupOverflowDropdown();
        await this.loadSessions();
        this.updateTabOverflow();
        
        // Show notification permission prompt after a slight delay
        setTimeout(() => {
            this.checkAndPromptForNotifications();
        }, 2000);
    }
    
    checkAndPromptForNotifications() {
        if ('Notification' in window && Notification.permission === 'default') {
            // Create a small prompt to enable notifications
            const promptDiv = document.createElement('div');
            promptDiv.className = 'notif-permission-prompt';
            promptDiv.innerHTML = `
                <div class="prompt-body">
                    <strong>Enable Desktop Notifications?</strong><br>
                    Get notified when ${this.getAlias('claude')} completes tasks in background tabs.
                </div>
                <div class="prompt-actions">
                    <button id="enableNotifications" class="btn btn-primary btn-small">Enable</button>
                    <button id="dismissNotifications" class="btn btn-secondary btn-small">Not Now</button>
                </div>
            `;
            document.body.appendChild(promptDiv);
            
            document.getElementById('enableNotifications').onclick = () => {
                this.requestNotificationPermission();
                promptDiv.remove();
            };
            
            document.getElementById('dismissNotifications').onclick = () => {
                promptDiv.remove();
            };
            
            // Auto-dismiss after 10 seconds
            setTimeout(() => {
                if (promptDiv.parentNode) {
                    promptDiv.remove();
                }
            }, 10000);
        }
    }

    setupTabBar() {
        const tabsContainer = document.getElementById('tabsContainer');
        const newTabBtn = document.getElementById('tabNewBtn');
        
        // New tab button — quick create
        newTabBtn?.addEventListener('click', () => {
            this.quickCreateSession();
        });

        // Dropdown button — full folder browser flow
        const newTabDropdown = document.getElementById('tabNewDropdown');
        newTabDropdown?.addEventListener('click', () => {
            this.createNewSession();
        });

        // Enable drag and drop for tabs
        if (tabsContainer) {
            tabsContainer.addEventListener('dragstart', (e) => {
                if (e.target.classList.contains('session-tab')) {
                    e.dataTransfer.effectAllowed = 'copyMove';
                    const sid = e.target.dataset.sessionId;
                    if (sid) {
                        e.dataTransfer.setData('text/plain', sid);
                        e.dataTransfer.setData('application/x-session-id', sid);
                        e.dataTransfer.setData('x-source-pane', '-1');
                    }
                    e.target.classList.add('dragging');
                }
            });
            
            tabsContainer.addEventListener('dragend', (e) => {
                if (e.target.classList.contains('session-tab')) {
                    e.target.classList.remove('dragging');
                    this.syncOrderFromDom();
                    this.updateTabOverflow();
                    this.updateOverflowMenu();
                }
            });
            
            tabsContainer.addEventListener('dragover', (e) => {
                e.preventDefault();
                const draggingTab = tabsContainer.querySelector('.dragging');
                if (!draggingTab) return;
                const afterElement = this.getDragAfterElement(tabsContainer, e.clientX);
                
                if (afterElement == null) {
                    tabsContainer.appendChild(draggingTab);
                } else {
                    tabsContainer.insertBefore(draggingTab, afterElement);
                }
            });

            tabsContainer.addEventListener('drop', (e) => {
                e.preventDefault();
            });
        }
    }


    setupOverflowDropdown() {
        const overflowBtn = document.getElementById('tabOverflowBtn');
        const overflowMenu = document.getElementById('tabOverflowMenu');
        
        if (overflowBtn) {
            overflowBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                overflowMenu.classList.toggle('active');
                this.updateOverflowMenu();
            });
        }
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!overflowMenu?.contains(e.target) && !overflowBtn?.contains(e.target)) {
                overflowMenu?.classList.remove('active');
            }
        });
        
        // Update overflow on window resize (debounced to avoid layout thrashing)
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.updateTabOverflow();
                this.updateOverflowMenu();
            }, 150);
        });
    }
    
    updateTabOverflow() {
        const isMobile = window.innerWidth <= 820;
        const overflowWrapper = document.getElementById('tabOverflowWrapper');
        const overflowCount = document.querySelector('.tab-overflow-count');
        
        if (!isMobile) {
            // On desktop, show all tabs and hide overflow
            this.tabs.forEach(tab => {
                tab.style.display = '';
            });
            if (overflowWrapper) {
                overflowWrapper.style.display = 'none';
            }
            if (overflowCount) overflowCount.textContent = '';
            return;
        }
        
        // On mobile, show only first 2 tabs
        const tabsArray = this.getOrderedTabElements();
        
        tabsArray.forEach((tab, index) => {
            if (index < 2) {
                tab.style.display = ''; // Show first 2 tabs
            } else {
                tab.style.display = 'none'; // Hide rest
            }
        });
        
        if (tabsArray.length > 2) {
            // Show overflow button with count
            if (overflowWrapper) {
                overflowWrapper.style.display = 'flex';
                if (overflowCount) {
                    overflowCount.textContent = tabsArray.length - 2;
                }
            }
        } else {
            // Hide overflow button
            if (overflowWrapper) {
                overflowWrapper.style.display = 'none';
            }
            if (overflowCount) {
                overflowCount.textContent = '';
            }
        }
    }
    
    updateOverflowMenu() {
        const menu = document.getElementById('tabOverflowMenu');
        if (!menu) return;
        
        const overflowIds = this.getOrderedTabIds().slice(2);
        
        menu.innerHTML = '';
        
        overflowIds.forEach((sessionId) => {
            const tabElement = this.tabs.get(sessionId);
            if (!tabElement) return;
            const session = this.activeSessions.get(sessionId);
            if (!session) return;
            
            const item = document.createElement('div');
            item.className = 'overflow-tab-item';
            if (sessionId === this.activeTabId) {
                item.classList.add('active');
            }
            
            item.innerHTML = `
                <span class="overflow-tab-name">${tabElement.querySelector('.tab-name').textContent}</span>
                <span class="overflow-tab-close" data-session-id="${sessionId}" title="Close tab">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </span>
            `;
            
            // Click to switch to tab
            item.addEventListener('click', async (e) => {
                if (!e.target.classList.contains('overflow-tab-close')) {
                    await this.switchToTab(sessionId);
                    menu.classList.remove('active');
                    // Update menu contents after switching - use a slightly longer delay to ensure UI updates
                    setTimeout(() => {
                        this.updateTabOverflow();
                        this.updateOverflowMenu();
                    }, 150);
                }
            });
            
            // Close button
            const closeBtn = item.querySelector('.overflow-tab-close');
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeSession(sessionId);
                menu.classList.remove('active');
            });
            
            menu.appendChild(item);
        });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + T: Quick new tab
            if ((e.ctrlKey || e.metaKey) && e.key === 't') {
                e.preventDefault();
                this.quickCreateSession();
            }
            
            // Ctrl/Cmd + W: Close current tab
            if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
                e.preventDefault();
                if (this.activeTabId) {
                    this.closeSession(this.activeTabId);
                }
            }
            
            // Ctrl/Cmd + Tab: Next tab
            if ((e.ctrlKey || e.metaKey) && e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                this.switchToNextTab();
            }
            
            // Ctrl/Cmd + Shift + Tab: Previous tab
            if ((e.ctrlKey || e.metaKey) && e.key === 'Tab' && e.shiftKey) {
                e.preventDefault();
                this.switchToPreviousTab();
            }
            
            // Alt + 1-9: Switch to tab by number
            if (e.altKey && e.key >= '1' && e.key <= '9') {
                e.preventDefault();
                const index = parseInt(e.key) - 1;
                this.switchToTabByIndex(index);
            }
            
        });
    }

    async loadSessions() {
        try {
            console.log('[SessionManager.loadSessions] Fetching sessions from server...');
            const authHeaders = window.authManager ? window.authManager.getAuthHeaders() : {};
            const response = await fetch('/api/sessions/list', {
                headers: authHeaders
            });
            const data = await response.json();
            
            console.log('[SessionManager.loadSessions] Got data:', data);
            
            // Sort sessions by creation time (assuming older sessions should be less recent)
            // This provides a default order that will be updated as tabs are accessed
            const sessions = data.sessions || [];
            
            console.log('[SessionManager.loadSessions] Processing', sessions.length, 'sessions');
            
            sessions.forEach((session, index) => {
                console.log('[SessionManager.loadSessions] Adding tab for:', session.id);
                // Don't auto-switch when loading existing sessions
                this.addTab(session.id, session.name, session.active ? 'active' : 'idle', session.workingDir, false);
                // Set initial timestamps based on order (older sessions get older timestamps)
                const sessionData = this.activeSessions.get(session.id);
                if (sessionData) {
                    sessionData.lastAccessed = Date.now() - (sessions.length - index) * 1000;
                }
            });
            
            // Reorder tabs based on the initial timestamps (mobile only)
            if (window.innerWidth <= 820) {
                this.reorderTabsByLastAccessed();
            }
            
            console.log('[SessionManager.loadSessions] Final tabs.size:', this.tabs.size);
            
            return sessions;
        } catch (error) {
            console.error('Failed to load sessions:', error);
            return [];
        }
    }

    addTab(sessionId, sessionName, status = 'idle', workingDir = null, autoSwitch = true, toolType = null) {
        const tabsContainer = document.getElementById('tabsContainer');
        if (!tabsContainer) return;
        
        // Check if tab already exists
        if (this.tabs.has(sessionId)) {
            return;
        }
        
        const tab = document.createElement('div');
        tab.className = 'session-tab';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', 'false');
        tab.dataset.sessionId = sessionId;
        tab.draggable = true;
        
        // Determine display name:
        // 1. If session name is customized (not default "Session ..."), use it
        // 2. Otherwise, use folder name if available
        // 3. Fall back to session name
        const isDefaultSessionName = sessionName.startsWith('Session ') && sessionName.includes(':');
        const folderName = workingDir ? workingDir.split('/').pop() || '/' : null;
        const displayName = !isDefaultSessionName ? sessionName : (folderName || sessionName);
        
        // Tool type badge mapping
        const toolBadges = {
            claude: { label: 'C', color: '#d97706' },
            codex: { label: 'Cx', color: '#059669' },
            copilot: { label: 'Cp', color: '#6366f1' },
            gemini: { label: 'G', color: '#2563eb' },
            terminal: { label: '>_', color: '#71717a' },
        };
        const badge = toolBadges[toolType] || null;
        const badgeHtml = badge
            ? `<span class="tab-badge" style="background:${badge.color}" title="${toolType || ''}">${badge.label}</span>`
            : '';

        const statusLabel = status === 'active' ? 'Active' : status === 'error' ? 'Error' : 'Idle';
        tab.innerHTML = `
            <span class="tab-status-border ${status}" aria-hidden="true"></span>
            <span class="sr-only">${statusLabel}</span>
            <div class="tab-content">
                ${badgeHtml}
                <span class="tab-name" title="${_esc(sessionName)}">${_esc(displayName)}</span>
            </div>
            <span class="tab-close" title="Close tab" aria-label="Close ${_esc(sessionName)}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </span>
        `;
        
        // Tab click handler
        tab.addEventListener('click', async (e) => {
            if (!e.target.closest('.tab-close')) {
                await this.switchToTab(sessionId);
            }
        });
        
        // Close button handler
        const closeBtn = tab.querySelector('.tab-close');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeSession(sessionId);
        });
        
        // Double-click to rename
        tab.addEventListener('dblclick', (e) => {
            if (!e.target.closest('.tab-close')) {
                this.renameTab(sessionId);
            }
        });

        // Middle click to close (VS Code behavior)
        tab.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                this.closeSession(sessionId);
            }
        });

        // Context menu: Close Others, Split Right, Move to Split
        tab.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.openTabContextMenu(sessionId, e.clientX, e.clientY);
        });
        
        tabsContainer.appendChild(tab);
        this.tabs.set(sessionId, tab);
        if (!this.tabOrder.includes(sessionId)) {
            this.tabOrder.push(sessionId);
        }

        // Store session data with timestamp and activity tracking
        this.activeSessions.set(sessionId, {
            id: sessionId,
            name: sessionName,
            status: status,
            workingDir: workingDir,
            toolType: toolType,
            lastAccessed: Date.now(),
            lastActivity: Date.now(),
            unreadOutput: false,
            hasError: false
        });
        
        // Update overflow on mobile
        this.updateTabOverflow();
        this.updateOverflowMenu();

        // If this is the first tab and autoSwitch is enabled, make it active
        if (this.tabs.size === 1 && autoSwitch) {
            this.switchToTab(sessionId);
        }
    }

    async switchToTab(sessionId, options = {}) {
        if (!this.tabs.has(sessionId)) return;

        const { skipHistoryUpdate = false } = options;

        // Remove active class from all tabs
        this.tabs.forEach(t => {
            t.classList.remove('active');
            t.setAttribute('aria-selected', 'false');
        });

        // Add active class to selected tab
        const tab = this.tabs.get(sessionId);
        if (!tab) return;
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        this.activeTabId = sessionId;
        this.ensureTabVisible(sessionId);

        // Update last accessed timestamp and clear unread indicator
        const session = this.activeSessions.get(sessionId);
        if (session) {
            session.lastAccessed = Date.now();
            if (session.unreadOutput) this.updateUnreadIndicator(sessionId, false);
        }

        if (!skipHistoryUpdate) {
            this.updateTabHistory(sessionId);
        }

        if (window.innerWidth <= 820) {
            const tabIndex = this.getOrderedTabIds().indexOf(sessionId);
            if (tabIndex >= 2) this.reorderTabsByLastAccessed();
        }

        this.updateOverflowMenu();

        // If tile view is enabled, tabs target the active pane (VS Code-style)
        await this.claudeInterface.joinSession(sessionId);
        this.updateHeaderInfo(sessionId);

        const srSwitch = document.getElementById('srAnnounce');
        const switchSession = this.activeSessions.get(sessionId);
        if (srSwitch && switchSession) {
            srSwitch.textContent = `Switched to session: ${switchSession.name}`;
        }

        // Fit terminal to container and capture focus after tab switch
        requestAnimationFrame(() => {
            const container = document.getElementById('terminalContainer');
            if (!container || container.offsetHeight === 0) return;
            if (this.claudeInterface.fitTerminal) this.claudeInterface.fitTerminal();

            const overlay = document.getElementById('overlay');
            const overlayVisible = overlay && overlay.style.display !== 'none';
            const hasModal = document.querySelector('.session-modal.active, .settings-modal, .folder-browser-modal');
            const splitActive = this.claudeInterface.splitContainer?.enabled;
            if (!overlayVisible && !hasModal && !splitActive) {
                this.claudeInterface.terminal?.focus();
            }
        });
    }
    
    reorderTabsByLastAccessed() {
        const tabsContainer = document.getElementById('tabsContainer');
        if (!tabsContainer) return;

        // Get all tabs sorted by last accessed time (most recent first)
        const sortedIds = this.getOrderedTabIds()
            .sort((a, b) => {
                const sessionA = this.activeSessions.get(a);
                const sessionB = this.activeSessions.get(b);
                const timeA = sessionA ? sessionA.lastAccessed : 0;
                const timeB = sessionB ? sessionB.lastAccessed : 0;
                return timeB - timeA; // Most recent first
            });

        // Use DocumentFragment to batch DOM mutations into a single reflow
        const fragment = document.createDocumentFragment();
        sortedIds.forEach((sessionId) => {
            const tabElement = this.tabs.get(sessionId);
            if (tabElement) {
                fragment.appendChild(tabElement);
            }
        });
        tabsContainer.appendChild(fragment);

        this.tabOrder = sortedIds;

        // Update overflow on mobile
        this.updateTabOverflow();
    }

    closeSession(sessionId, { skipServerRequest = false, skipConfirmation = false } = {}) {
        const tab = this.tabs.get(sessionId);
        if (!tab) return;

        // Confirm before closing sessions with an active process
        if (!skipConfirmation && !skipServerRequest) {
            const session = this.activeSessions.get(sessionId);
            if (session && session.active) {
                if (!confirm('Close session? The running process will be stopped.')) {
                    return;
                }
            }
        }

        const orderedIds = this.getOrderedTabIds();
        const closedIndex = orderedIds.indexOf(sessionId);

        // Clear any pending notification timers before removing session data
        const session = this.activeSessions.get(sessionId);
        const closedName = session ? session.name : 'Session';
        if (session) {
            clearTimeout(session.idleTimeout);
            clearTimeout(session.workCompleteTimeout);
        }

        const srClose = document.getElementById('srAnnounce');
        if (srClose) srClose.textContent = `Session closed: ${closedName}`;

        // Remove tab
        tab.remove();
        this.tabs.delete(sessionId);
        this.activeSessions.delete(sessionId);
        this.tabOrder = orderedIds.filter(id => id !== sessionId);
        this.removeFromHistory(sessionId);

        // Update overflow on mobile
        this.updateTabOverflow();
        this.updateOverflowMenu();

        if (!skipServerRequest) {
            this._deletingSessionIds.add(sessionId);
            const authHeaders = window.authManager ? window.authManager.getAuthHeaders() : {};
            fetch(`/api/sessions/${sessionId}`, {
                method: 'DELETE',
                headers: authHeaders
            })
                .catch(err => console.error('Failed to delete session:', err));
        }

        // If this was the active tab, switch to another
        if (this.activeTabId === sessionId) {
            this.activeTabId = null;
            let fallbackId = this.tabHistory.find(id => this.tabs.has(id));
            if (!fallbackId && this.tabOrder.length > 0) {
                const nextIndex = closedIndex >= 0 ? Math.min(closedIndex, this.tabOrder.length - 1) : 0;
                fallbackId = this.tabOrder[nextIndex];
            }

            if (fallbackId) {
                this.switchToTab(fallbackId);
            }
        }

    }

    isUserDeletion(sessionId) {
        return this._deletingSessionIds.has(sessionId);
    }

    clearUserDeletion(sessionId) {
        this._deletingSessionIds.delete(sessionId);
    }

    renameTab(sessionId) {
        const tab = this.tabs.get(sessionId);
        if (!tab) return;
        
        const nameSpan = tab.querySelector('.tab-name');
        const currentName = nameSpan.textContent;
        
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.className = 'tab-name-input';
        input.style.width = '100%';
        
        nameSpan.replaceWith(input);
        input.focus();
        input.select();
        
        const saveNewName = () => {
            const newName = input.value.trim() || currentName;
            const newNameSpan = document.createElement('span');
            newNameSpan.className = 'tab-name';
            newNameSpan.textContent = newName;
            newNameSpan.title = newName;
            input.replaceWith(newNameSpan);
            
            // Update session data
            const session = this.activeSessions.get(sessionId);
            if (session) {
                session.name = newName;
            }
        };
        
        input.addEventListener('blur', saveNewName);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                saveNewName();
            } else if (e.key === 'Escape') {
                input.value = currentName;
                saveNewName();
            }
        });
    }

    // Close all other tabs except the given session
    closeOthers(sessionId) {
        const ids = this.getOrderedTabIds();
        ids.forEach(id => { if (id !== sessionId) this.closeSession(id); });
    }

    // Context menu for a session tab
    openTabContextMenu(sessionId, clientX, clientY) {
        // Remove existing menus
        document.querySelectorAll('.pane-session-menu').forEach(m => m.remove());
        const menu = document.createElement('div');
        menu.className = 'pane-session-menu';
        const addItem = (label, fn, disabled = false) => {
            const el = document.createElement('div');
            el.className = 'pane-session-item' + (disabled ? ' used' : '');
            el.textContent = label;
            if (!disabled) el.onclick = () => { try { fn(); } finally { menu.remove(); } };
            return el;
        };
        menu.appendChild(addItem('Close Others', () => this.closeOthers(sessionId)));
        document.body.appendChild(menu);
        menu.style.top = `${clientY + 4}px`;
        menu.style.left = `${clientX + 4}px`;
        const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close, true); } };
        setTimeout(() => document.addEventListener('mousedown', close, true), 0);
    }

    createNewSession() {
        // Set flag to indicate we're creating a new session
        if (this.claudeInterface) {
            this.claudeInterface.isCreatingNewSession = true;
            // Show the folder browser to let user pick a folder for the new session
            if (this.claudeInterface.showFolderBrowser) {
                this.claudeInterface.showFolderBrowser();
            }
        } else {
            // Fallback: show the folder browser modal directly
            document.getElementById('folderBrowserModal').classList.add('active');
        }
    }

    async quickCreateSession() {
        if (!this.claudeInterface) {
            this.createNewSession();
            return;
        }

        // Determine working directory from the active session
        let workingDir = null;

        if (this.activeTabId) {
            const activeSession = this.activeSessions.get(this.activeTabId);
            if (activeSession && activeSession.workingDir) {
                workingDir = activeSession.workingDir;
            }
        }

        if (!workingDir && this.claudeInterface) {
            workingDir = this.claudeInterface.selectedWorkingDir;
        }

        // No directory available — fall back to folder browser
        if (!workingDir) {
            this.createNewSession();
            return;
        }

        // Generate a name from the folder path
        const separator = workingDir.includes('\\') ? '\\' : '/';
        const folderName = workingDir.split(separator).filter(Boolean).pop() || 'Session';
        const name = `${folderName} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

        try {
            const response = await this.claudeInterface.authFetch('/api/sessions/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, workingDir })
            });

            if (!response.ok) throw new Error('Failed to create session');

            const data = await response.json();

            this.addTab(data.sessionId, name, 'idle', workingDir);
            await this.switchToTab(data.sessionId);

            if (this.claudeInterface && this.claudeInterface.loadSessions) {
                this.claudeInterface.loadSessions();
            }
        } catch (error) {
            console.error('Quick create session failed:', error);
            // Fall back to folder browser on error
            this.createNewSession();
        }
    }

    switchToNextTab() {
        if (this.tabHistory.length > 1) {
            const nextId = this.tabHistory.find((id) => id !== this.activeTabId && this.tabs.has(id));
            if (nextId) {
                this.switchToTab(nextId);
                return;
            }
        }

        const tabIds = this.getOrderedTabIds();
        if (tabIds.length === 0) return;
        const currentIndex = tabIds.indexOf(this.activeTabId);
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % tabIds.length : 0;
        this.switchToTab(tabIds[nextIndex]);
    }

    switchToPreviousTab() {
        const tabIds = this.getOrderedTabIds();
        if (tabIds.length === 0) return;
        const currentIndex = tabIds.indexOf(this.activeTabId);
        const prevIndex = currentIndex >= 0 ? (currentIndex - 1 + tabIds.length) % tabIds.length : tabIds.length - 1;
        this.switchToTab(tabIds[prevIndex]);
    }

    switchToTabByIndex(index) {
        const tabIds = this.getOrderedTabIds();
        if (index < tabIds.length) {
            this.switchToTab(tabIds[index]);
        }
    }


    updateHeaderInfo(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (session) {
            const workingDirEl = document.getElementById('workingDir');
            if (workingDirEl && session.workingDir) {
                workingDirEl.textContent = session.workingDir;
            }
        }
    }

    updateTabStatus(sessionId, status) {
        const tab = this.tabs.get(sessionId);
        if (tab) {
            // Update sr-only text for screen readers
            const srEl = tab.querySelector('.sr-only');
            if (srEl) {
                const label = status === 'active' ? 'Active' : status === 'error' ? 'Error' : 'Idle';
                srEl.textContent = label;
            }
            // Support both old .tab-status dot and new .tab-status-border
            const statusEl = tab.querySelector('.tab-status-border') || tab.querySelector('.tab-status');
            if (statusEl) {
                // Get current session info
                const session = this.activeSessions.get(sessionId);
                const wasActive = session && session.status === 'active';

                // Preserve unread class if it exists
                const hasUnread = statusEl.classList.contains('unread');
                const baseClass = statusEl.classList.contains('tab-status-border') ? 'tab-status-border' : 'tab-status';
                statusEl.className = `${baseClass} ${status}`;

                // When transitioning from active to idle for background tabs, mark as unread
                if (wasActive && status === 'idle' && sessionId !== this.activeTabId) {
                    statusEl.classList.add('unread');
                    if (session) {
                        session.unreadOutput = true;
                    }
                } else if (hasUnread) {
                    statusEl.classList.add('unread');
                }

                // Update visual indicator based on status
                if (status === 'active') {
                    statusEl.classList.add('pulse');
                } else {
                    statusEl.classList.remove('pulse');
                }
            }
            
            const session = this.activeSessions.get(sessionId);
            if (session) {
                session.status = status;
                session.lastActivity = Date.now();
                
                // Clear error state if status is not error
                if (status !== 'error') {
                    session.hasError = false;
                }
            }
        }
    }
    
    /**
     * Update tab title to reflect current activity based on output text patterns.
     * Throttled to once per 2 seconds to avoid excessive DOM updates.
     * @param {string} sessionId
     * @param {string} outputText - the latest output chunk (raw, may contain ANSI)
     */
    updateTabActivity(sessionId, outputText) {
        const session = this.activeSessions.get(sessionId);
        if (!session) return;

        // Throttle: skip if less than 2 seconds since last update for this session
        const now = Date.now();
        if (!this._tabActivityTimestamps) this._tabActivityTimestamps = new Map();
        const lastUpdate = this._tabActivityTimestamps.get(sessionId) || 0;
        if (now - lastUpdate < 2000) return;
        this._tabActivityTimestamps.set(sessionId, now);

        // Store the original session name on first call so it can be restored
        if (!session._originalName) {
            session._originalName = session.name;
        }

        // Strip ANSI escape codes for pattern matching
        const clean = outputText.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

        const agentName = this.getAlias(session.toolType || 'claude');
        let activityLabel = null;

        if (/\bthinking\b/i.test(clean)) {
            activityLabel = `${agentName}: Thinking...`;
        } else if (/\breading\b|\bReading file\b/i.test(clean)) {
            activityLabel = `${agentName}: Reading...`;
        } else if (/\brunning\b|\$\s|>\s/i.test(clean)) {
            activityLabel = `${agentName}: Running...`;
        }

        const tab = this.tabs.get(sessionId);
        if (!tab) return;
        const nameEl = tab.querySelector('.tab-name');
        if (!nameEl) return;

        if (activityLabel) {
            nameEl.textContent = activityLabel;
            nameEl.setAttribute('title', activityLabel);
        } else {
            // Restore original name when no activity pattern matches
            const originalName = session._originalName || session.name;
            nameEl.textContent = originalName;
            nameEl.setAttribute('title', originalName);
        }
    }

    /**
     * Restore tab title to the original session name (e.g. when session goes idle).
     * @param {string} sessionId
     */
    restoreTabTitle(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) return;
        const tab = this.tabs.get(sessionId);
        if (!tab) return;
        const nameEl = tab.querySelector('.tab-name');
        if (!nameEl) return;
        const originalName = session._originalName || session.name;
        nameEl.textContent = originalName;
        nameEl.setAttribute('title', originalName);
        // Clear throttle timestamp so the next activity update is immediate
        if (this._tabActivityTimestamps) {
            this._tabActivityTimestamps.delete(sessionId);
        }
    }

    markSessionActivity(sessionId, hasOutput = false, outputData = '') {
        const session = this.activeSessions.get(sessionId);
        if (!session) return;

        const previousActivity = session.lastActivity || 0;
        const wasActive = session.status === 'active';
        session.lastActivity = Date.now();

        // Update status to active if there's output
        if (hasOutput) {
            this.updateTabStatus(sessionId, 'active');

            // Update tab title with activity indicator
            if (outputData) {
                this.updateTabActivity(sessionId, outputData);
            }
            
            // Don't mark as unread immediately - wait for completion
            // This prevents the blue indicator from showing while Claude is still working
            
            // Clear any existing timeouts
            clearTimeout(session.idleTimeout);
            clearTimeout(session.workCompleteTimeout);
            
            // Set a 90-second timeout to detect when Claude has likely finished working
            session.workCompleteTimeout = setTimeout(() => {
                const currentSession = this.activeSessions.get(sessionId);
                if (currentSession && currentSession.status === 'active') {
                    // Claude has been idle for 90 seconds - likely finished working
                    this.updateTabStatus(sessionId, 'idle');
                    this.restoreTabTitle(sessionId);

                    // Only notify and mark as unread if Claude was previously active
                    if (wasActive) {
                        const sessionName = currentSession.name || 'Session';
                        const duration = Date.now() - previousActivity;
                        
                        // Mark as unread if this is a background tab (blue indicator)
                        if (sessionId !== this.activeTabId) {
                            currentSession.unreadOutput = true;
                            this.updateUnreadIndicator(sessionId, true);
                            
                            // Send notification that Claude appears to have finished
                            this.sendNotification({
                                title: `${sessionName} — ${this.getAlias(currentSession.toolType || 'claude')} appears finished`,
                                body: this._buildNotifBody(currentSession, duration),
                                sessionId,
                                type: 'idle',
                            });
                        }
                    }
                }
            }, this.idleTimeoutMs);
            
            // Keep the original 5-minute timeout for full idle state
            session.idleTimeout = setTimeout(() => {
                const currentSession = this.activeSessions.get(sessionId);
                if (currentSession && currentSession.status === 'idle') {
                    // Already marked as idle by the 90-second timeout, no need to do anything
                }
            }, 300000); // 5 minutes
        }
        
        // Check for command completion patterns
        if (hasOutput && outputData) {
            this.checkForCommandCompletion(sessionId, outputData, previousActivity);
        }
    }
    
    checkForCommandCompletion(sessionId, outputData, previousActivity) {
        const session = this.activeSessions.get(sessionId);
        if (!session) return;
        
        // Pattern matching for common completion indicators
        const completionPatterns = [
            /build\s+successful/i,
            /compilation\s+finished/i,
            /tests?\s+passed/i,
            /deployment\s+complete/i,
            /npm\s+install.*completed/i,
            /successfully\s+compiled/i,
            /✓\s+All\s+tests\s+passed/i,
            /Done\s+in\s+\d+\.\d+s/i
        ];
        
        const hasCompletion = completionPatterns.some(pattern => pattern.test(outputData));
        
        if (hasCompletion && sessionId !== this.activeTabId) {
            const duration = Date.now() - previousActivity;
            const sessionName = session.name || 'Session';
            
            // Extract a meaningful message from the output
            let message = 'Task completed successfully';
            if (/build\s+successful/i.test(outputData)) {
                message = 'Build completed successfully';
            } else if (/tests?\s+passed/i.test(outputData)) {
                message = 'All tests passed';
            } else if (/deployment\s+complete/i.test(outputData)) {
                message = 'Deployment completed';
            }
            
            // Mark tab as unread (blue indicator) for completed tasks
            session.unreadOutput = true;
            this.updateUnreadIndicator(sessionId, true);
            
            this.sendNotification({
                title: `${sessionName} — ${message}`,
                body: this._buildNotifBody(session, duration),
                sessionId,
                type: 'success',
            });
        }
    }
    
    setTabToolType(sessionId, toolType) {
        const tab = this.tabs.get(sessionId);
        if (!tab) return;
        const session = this.activeSessions.get(sessionId);
        if (session) session.toolType = toolType;

        // Add badge if not already present
        if (!tab.querySelector('.tab-badge')) {
            const toolBadges = {
                claude: { label: 'C', color: '#d97706' },
                codex: { label: 'Cx', color: '#059669' },
                copilot: { label: 'Cp', color: '#6366f1' },
                gemini: { label: 'G', color: '#2563eb' },
                terminal: { label: '>_', color: '#71717a' },
            };
            const badge = toolBadges[toolType];
            if (badge) {
                const badgeEl = document.createElement('span');
                badgeEl.className = 'tab-badge';
                badgeEl.style.background = badge.color;
                badgeEl.title = toolType;
                badgeEl.textContent = badge.label;
                const content = tab.querySelector('.tab-content');
                if (content) content.insertBefore(badgeEl, content.firstChild);
            }
        }
    }

    updateUnreadIndicator(sessionId, hasUnread) {
        const tab = this.tabs.get(sessionId);
        if (tab) {
            const statusEl = tab.querySelector('.tab-status-border') || tab.querySelector('.tab-status');
            if (hasUnread) {
                tab.classList.add('has-unread');
                if (statusEl) {
                    statusEl.classList.add('unread');
                }
            } else {
                tab.classList.remove('has-unread');
                if (statusEl) {
                    statusEl.classList.remove('unread');
                }
            }
        }
        
        const session = this.activeSessions.get(sessionId);
        if (session) {
            session.unreadOutput = hasUnread;
        }
    }
    
    markSessionError(sessionId, hasError = true) {
        const session = this.activeSessions.get(sessionId);
        if (session) {
            session.hasError = hasError;
            if (hasError) {
                this.updateTabStatus(sessionId, 'error');
                
                // Send notification for error in background session
                const sessionName = session.name || 'Session';
                this.sendNotification({
                    title: `${sessionName} — Error detected`,
                    body: this._buildNotifBody(session, 0),
                    sessionId,
                    type: 'error',
                });
            }
        }
    }

    getDragAfterElement(container, x) {
        const draggableElements = [...container.querySelectorAll('.session-tab:not(.dragging)')];
        
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = x - box.left - box.width / 2;
            
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }
}

// Export for use in app.js
if (typeof window !== 'undefined') {
    window.SessionTabManager = SessionTabManager;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SessionTabManager, _esc };
}
