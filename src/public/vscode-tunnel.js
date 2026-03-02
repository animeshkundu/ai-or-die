'use strict';

/**
 * VS Code Tunnel client-side UI.
 * Manages the toolbar button state, status banner, and WebSocket communication.
 */
(function () {
  class VSCodeTunnelUI {
    constructor(options = {}) {
      this.app = options.app;
      this.button = document.getElementById('vscodeTunnelBtn');
      this.banner = document.getElementById('vscodeTunnelBanner');

      this.status = 'stopped'; // stopped | starting | running | degraded | error
      this.url = null;
      this.localUrl = null;
      this.publicUrl = null;
      this.authUrl = null;
      this.deviceCode = null;
      this._bannerDismissed = false;
      this._autoCollapseTimer = null;
      this._autoCollapseRemaining = 0;
    }

    /**
     * Toggle tunnel: start if stopped, show banner if running.
     */
    toggle() {
      if (this.status === 'stopped' || this.status === 'error') {
        this.start();
      } else if (this.status === 'running' || this.status === 'starting' || this.status === 'degraded') {
        // Re-show the banner if dismissed
        if (this._bannerDismissed) {
          this._bannerDismissed = false;
          this._renderBanner();
        } else {
          // Show current status banner
          this._renderBanner();
        }
      }
    }

    /**
     * Send start command via WebSocket.
     */
    start() {
      if (!this.app) return;
      this._setStatus('starting');
      this._bannerDismissed = false;
      this._renderBanner();
      this.app.send({ type: 'start_vscode_tunnel' });
    }

    /**
     * Send stop command via WebSocket.
     */
    stop() {
      if (!this.app) return;
      this.app.send({ type: 'stop_vscode_tunnel' });
      this._setStatus('stopped');
      this.url = null;
      this.localUrl = null;
      this.publicUrl = null;
      this.authUrl = null;
      this.deviceCode = null;
      this._renderBanner();
    }

    /**
     * Copy the tunnel URL to clipboard.
     */
    copyUrl() {
      if (!this.url) return;
      navigator.clipboard.writeText(this.url).then(() => {
        // Brief visual feedback on the copy button
        const copyBtn = this.banner && this.banner.querySelector('.vst-copy-btn');
        if (copyBtn) {
          const original = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = original; }, 1500);
        }
      });
    }

    /**
     * Open the tunnel URL in a new tab.
     */
    openUrl() {
      if (!this.url) return;
      window.open(this.url, '_blank');
    }

    /**
     * Handle incoming WebSocket messages for VS Code tunnel events.
     */
    handleMessage(data) {
      switch (data.type) {
        case 'vscode_tunnel_started':
          this.url = data.url;
          this.localUrl = data.localUrl || null;
          this.publicUrl = data.publicUrl || null;
          this._setStatus('running');
          this._bannerDismissed = false;
          this._renderBanner();
          // Auto-copy URL and schedule banner collapse
          if (this.url) {
            navigator.clipboard.writeText(this.url).catch(() => {});
          }
          this._scheduleAutoCollapse();
          break;

        case 'vscode_tunnel_status':
          this._setStatus(data.status);
          if (data.url) this.url = data.url;
          if (data.localUrl !== undefined) this.localUrl = data.localUrl;
          if (data.publicUrl !== undefined) this.publicUrl = data.publicUrl;
          if (data.status === 'stopped') {
            this.url = null;
            this.localUrl = null;
            this.publicUrl = null;
            this.authUrl = null;
            this.deviceCode = null;
          }
          this._renderBanner();
          break;

        case 'vscode_tunnel_auth':
          this.authUrl = data.authUrl;
          this.deviceCode = data.deviceCode;
          this._setStatus('starting');
          this._bannerDismissed = false;
          this._renderBanner();
          break;

        case 'vscode_tunnel_error':
          this._setStatus('error');
          this._bannerDismissed = false;
          this._renderError(data.message || data.error, data.install);
          break;
      }
    }

    /**
     * Dismiss the banner without stopping the tunnel.
     */
    dismiss() {
      this._bannerDismissed = true;
      this._clearAutoCollapse();
      if (this.banner) {
        this.banner.classList.remove('visible');
      }
      this._updateStatusIndicator();
    }

    // ── Private ──────────────────────────────────────────────

    _setStatus(status) {
      this.status = status;
      this._updateButton();
      this._updateStatusIndicator();
      // Cancel auto-collapse if status changes away from running
      if (status !== 'running' && this._autoCollapseTimer) {
        this._clearAutoCollapse();
      }
    }

    _scheduleAutoCollapse() {
      this._clearAutoCollapse();
      // Banners with action buttons never auto-dismiss
      if (this._bannerHasActions()) return;
      this._autoCollapseRemaining = 20000;
      this._autoCollapseStart = Date.now();
      this._autoCollapseTimer = setTimeout(() => {
        this._autoCollapseTimer = null;
        this._autoCollapseRemaining = 0;
        if (this.status === 'running' || this.status === 'starting' || this.status === 'degraded') {
          this.dismiss();
        }
      }, this._autoCollapseRemaining);
    }

    _clearAutoCollapse() {
      if (this._autoCollapseTimer) {
        clearTimeout(this._autoCollapseTimer);
        this._autoCollapseTimer = null;
      }
      this._autoCollapseRemaining = 0;
    }

    /**
     * Check whether the current banner contains action buttons (stop, auth, install, etc.).
     * Banners with actions should NOT auto-dismiss per WCAG 2.2.1.
     */
    _bannerHasActions() {
      if (!this.banner) return false;
      return !!(
        this.banner.querySelector('.vst-stop-btn') ||
        this.banner.querySelector('.vst-retry-btn') ||
        this.banner.querySelector('.vst-open-btn') ||
        this.banner.querySelector('.vst-copy-btn')
      );
    }

    /**
     * Bind mouseenter/mouseleave on the banner to pause/resume auto-collapse timer.
     */
    _bindBannerHoverPause() {
      if (!this.banner) return;
      const self = this;
      this.banner.addEventListener('mouseenter', () => {
        if (self._autoCollapseTimer && self._autoCollapseRemaining > 0) {
          clearTimeout(self._autoCollapseTimer);
          self._autoCollapseTimer = null;
          var elapsed = Date.now() - (self._autoCollapseStart || Date.now());
          self._autoCollapseRemaining = Math.max(0, self._autoCollapseRemaining - elapsed);
        }
      });
      this.banner.addEventListener('mouseleave', () => {
        if (self._autoCollapseRemaining > 0 && !self._autoCollapseTimer && !self._bannerDismissed) {
          self._autoCollapseStart = Date.now();
          self._autoCollapseTimer = setTimeout(() => {
            self._autoCollapseTimer = null;
            self._autoCollapseRemaining = 0;
            if (self.status === 'running' || self.status === 'starting' || self.status === 'degraded') {
              self.dismiss();
            }
          }, self._autoCollapseRemaining);
        }
      });
    }

    /**
     * Create or update a status indicator button in #statusIndicators.
     * Shows the tunnel state when the banner is dismissed or stopped.
     */
    _updateStatusIndicator() {
      var container = document.getElementById('statusIndicators');
      if (!container) return;

      var btn = container.querySelector('#vstStatusIndicator');

      // Remove indicator when stopped
      if (this.status === 'stopped') {
        if (btn) btn.remove();
        return;
      }

      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'vstStatusIndicator';
        btn.className = 'status-indicator';
        btn.addEventListener('click', () => {
          this._bannerDismissed = false;
          this._renderBanner();
        });
        container.appendChild(btn);
        this._bindBannerHoverPause();
      }

      // Determine status class and icon
      btn.classList.remove('status-healthy', 'status-warning', 'status-error', 'status-loading');
      var label, svg;
      switch (this.status) {
        case 'running':
          btn.classList.add('status-healthy');
          label = 'VS Code Tunnel: running';
          svg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
          break;
        case 'degraded':
          btn.classList.add('status-warning');
          label = 'VS Code Tunnel: reconnecting';
          svg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
          break;
        case 'error':
          btn.classList.add('status-error');
          label = 'VS Code Tunnel: error';
          svg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
          break;
        case 'starting':
        case 'restarting':
          btn.classList.add('status-loading');
          label = 'VS Code Tunnel: starting';
          svg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
          break;
        default:
          label = 'VS Code Tunnel';
          svg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
      }
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
      btn.innerHTML = svg;

      // Only show indicator when banner is dismissed and tunnel is active
      btn.style.display = (this._bannerDismissed && this.status !== 'stopped') ? '' : 'none';
    }

    _updateButton() {
      if (!this.button) return;
      this.button.classList.remove('starting', 'running', 'error');
      if (this.status !== 'stopped') {
        const btnClass = (this.status === 'restarting' || this.status === 'degraded')
          ? 'starting' : this.status;
        this.button.classList.add(btnClass);
      }
    }

    _renderBanner() {
      if (!this.banner) return;

      if (this.status === 'stopped' || this._bannerDismissed) {
        this.banner.classList.remove('visible');
        return;
      }

      this.banner.classList.add('visible');

      if (this.status === 'starting' && this.authUrl) {
        this._renderAuthBanner();
      } else if (this.status === 'starting' || this.status === 'restarting') {
        this._renderStartingBanner();
      } else if (this.status === 'degraded') {
        this._renderDegradedBanner();
      } else if (this.status === 'running' && this.url) {
        this._renderRunningBanner();
      }
    }

    _renderStartingBanner() {
      const msg = this.status === 'restarting'
        ? 'Reconnecting VS Code Tunnel...'
        : 'Starting VS Code Tunnel...';
      this.banner.innerHTML = `
        <span class="vst-spinner"></span>
        <span class="vst-message">${msg}</span>
        <div class="vst-actions">
          <button class="vst-btn danger vst-stop-btn">Cancel</button>
        </div>
        <button class="vst-close vst-dismiss-btn" title="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
      this._bindBannerEvents();
    }

    _renderAuthBanner() {
      const codeHtml = this.deviceCode
        ? ` and enter code <span class="vst-auth-code">${this._escapeHtml(this.deviceCode)}</span>`
        : '';
      this.banner.innerHTML = `
        <span class="vst-spinner"></span>
        <span class="vst-message">
          Authentication required. Open
          <a href="${this._escapeHtml(this.authUrl)}" target="_blank" rel="noopener">${this._escapeHtml(this.authUrl)}</a>${codeHtml}
        </span>
        <div class="vst-actions">
          <button class="vst-btn primary" onclick="window.open('${this._escapeHtml(this.authUrl)}', '_blank')">Open Auth Page</button>
          <button class="vst-btn danger vst-stop-btn">Cancel</button>
        </div>
        <button class="vst-close vst-dismiss-btn" title="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
      this._bindBannerEvents();
    }

    _renderRunningBanner() {
      const displayUrl = this.url || '';
      const shortUrl = displayUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, '');
      this.banner.innerHTML = `
        <span class="vst-icon running">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"/>
            <polyline points="8 6 2 12 8 18"/>
          </svg>
        </span>
        <span class="vst-message">
          Connected &mdash;
          <span class="vst-url" title="${this._escapeHtml(displayUrl)}">${this._escapeHtml(shortUrl)}</span>
          <span style="color:var(--status-success);font-size:var(--text-sm);margin-left:6px">URL copied</span>
        </span>
        <div class="vst-actions">
          <button class="vst-btn vst-copy-btn">Copy URL</button>
          <button class="vst-btn primary vst-open-btn">Open</button>
          <button class="vst-btn danger vst-stop-btn">Stop</button>
        </div>
        <button class="vst-close vst-dismiss-btn" title="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
      this._bindBannerEvents();
    }

    _renderDegradedBanner() {
      this.banner.innerHTML = `
        <span class="vst-spinner"></span>
        <span class="vst-message">VS Code Tunnel reconnecting... Server running locally.</span>
        <div class="vst-actions">
          <button class="vst-btn danger vst-stop-btn">Stop</button>
        </div>
        <button class="vst-close vst-dismiss-btn" title="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
      this._bindBannerEvents();
    }

    _renderError(message, installInfo) {
      const isNotFound = message === 'not_found' || (message && message.includes('not found'));

      if (isNotFound && installInfo) {
        this._renderNotFoundInstall(installInfo);
        return;
      }

      let msgHtml;
      if (isNotFound) {
        msgHtml = `Required CLI not found. Install <a href="https://code.visualstudio.com/download" target="_blank" rel="noopener">VS Code</a> (<code>code</code>) and <code>devtunnel</code> CLI.`;
      } else {
        msgHtml = `VS Code Tunnel error: ${this._escapeHtml(message)}`;
      }

      this.banner.classList.add('visible');
      this.banner.innerHTML = `
        <span class="vst-icon error">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </span>
        <span class="vst-message">${msgHtml}</span>
        <div class="vst-actions">
          <button class="vst-btn vst-retry-btn">Retry</button>
        </div>
        <button class="vst-close vst-dismiss-btn" title="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
      this._bindBannerEvents();
    }

    _renderNotFoundInstall(installInfo) {
      let methodsHtml = '';
      for (const method of (installInfo.methods || [])) {
        if (method.command) {
          const escaped = this._escapeHtml(method.command);
          methodsHtml += `<div class="vst-install-method">
            <code class="vst-install-cmd">${escaped}</code>
            <button class="vst-btn vst-copy-cmd-btn" data-cmd="${escaped}">Copy</button>
          </div>`;
          if (method.note) {
            methodsHtml += `<div class="vst-install-note">${this._escapeHtml(method.note)}</div>`;
          }
        } else if (method.url) {
          methodsHtml += `<div class="vst-install-method">
            <a href="${this._escapeHtml(method.url)}" target="_blank" rel="noopener">${this._escapeHtml(method.label)}</a>
          </div>`;
          if (method.note) {
            methodsHtml += `<div class="vst-install-note">${this._escapeHtml(method.note)}</div>`;
          }
        }
      }

      this.banner.classList.add('visible');
      this.banner.innerHTML = `
        <span class="vst-icon error">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </span>
        <div class="vst-message vst-install-panel">
          <div>VS Code CLI (<code>code</code>) not found.</div>
          <div class="vst-install-methods">${methodsHtml}</div>
        </div>
        <div class="vst-actions">
          <button class="vst-btn vst-retry-btn">Re-check</button>
        </div>
        <button class="vst-close vst-dismiss-btn" title="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;

      // Wire up copy buttons
      this.banner.querySelectorAll('.vst-copy-cmd-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(btn.dataset.cmd).then(() => {
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
          });
        });
      });

      this._bindBannerEvents();
    }

    _bindBannerEvents() {
      if (!this.banner) return;
      const self = this;

      const stopBtn = this.banner.querySelector('.vst-stop-btn');
      if (stopBtn) stopBtn.addEventListener('click', () => self.stop());

      const copyBtn = this.banner.querySelector('.vst-copy-btn');
      if (copyBtn) copyBtn.addEventListener('click', () => self.copyUrl());

      const openBtn = this.banner.querySelector('.vst-open-btn');
      if (openBtn) openBtn.addEventListener('click', () => self.openUrl());

      const retryBtn = this.banner.querySelector('.vst-retry-btn');
      if (retryBtn) retryBtn.addEventListener('click', () => self.start());

      const dismissBtn = this.banner.querySelector('.vst-dismiss-btn');
      if (dismissBtn) dismissBtn.addEventListener('click', () => self.dismiss());

      // Click on URL to copy
      const urlEl = this.banner.querySelector('.vst-url');
      if (urlEl) urlEl.addEventListener('click', () => self.copyUrl());
    }

    _escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  }

  // Export
  if (typeof window !== 'undefined') {
    window.VSCodeTunnelUI = VSCodeTunnelUI;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { VSCodeTunnelUI };
  }
})();
