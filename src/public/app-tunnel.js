'use strict';

/**
 * App-level Dev Tunnel client-side UI.
 * Manages the toolbar button state, status banner, and REST/WS communication.
 */
(function () {
  class AppTunnelUI {
    constructor(options = {}) {
      this.app = options.app;
      this.button = document.getElementById('appTunnelBtn');
      this.banner = document.getElementById('appTunnelBanner');

      this.status = 'unknown'; // unknown | running | restarting | stopped | error
      this.publicUrl = null;
      this._bannerDismissed = false;
      this._restartLocked = false;

      // Fetch initial status
      this._fetchStatus();
    }

    /**
     * Toggle: show banner if running, otherwise do nothing (tunnel is server-managed).
     */
    toggle() {
      if (this.status === 'running' || this.status === 'restarting') {
        this._bannerDismissed = false;
        this._renderBanner();
      } else {
        // Not configured or stopped — fetch fresh status
        this._fetchStatus().then(() => {
          if (this.publicUrl) {
            this._bannerDismissed = false;
            this._renderBanner();
          }
        });
      }
    }

    /**
     * Restart the tunnel via REST API.
     */
    async restart() {
      if (this._restartLocked) return;

      this._restartLocked = true;
      this.status = 'restarting';
      this._updateButton();
      this._renderBanner();

      // Disable button for 10 seconds
      if (this.button) this.button.disabled = true;
      setTimeout(() => {
        this._restartLocked = false;
        if (this.button) this.button.disabled = false;
      }, 10000);

      try {
        const fetchFn = this.app && this.app.authFetch
          ? (url, opts) => this.app.authFetch(url, opts)
          : (url, opts) => fetch(url, opts);

        await fetchFn('/api/tunnel/restart', { method: 'POST' });
        // Server responds 202 immediately; tunnel status updates arrive via WS
      } catch (err) {
        console.error('[app-tunnel] Restart request failed:', err);
        // Expected when called from a remote client through the tunnel
        // WS reconnection will handle recovery
      }
    }

    /**
     * Copy the public URL to clipboard.
     */
    copyUrl() {
      if (!this.publicUrl) return;
      navigator.clipboard.writeText(this.publicUrl).then(() => {
        const copyBtn = this.banner && this.banner.querySelector('.vst-copy-btn');
        if (copyBtn) {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 2000);
        }
      });
    }

    /**
     * Open the public URL in a new tab.
     */
    openUrl() {
      if (this.publicUrl) {
        window.open(this.publicUrl, '_blank', 'noopener');
      }
    }

    /**
     * Dismiss the banner without changing state.
     */
    dismiss() {
      this._bannerDismissed = true;
      if (this.banner) this.banner.classList.remove('visible');
    }

    /**
     * Handle incoming WebSocket messages.
     */
    handleMessage(data) {
      if (data.type === 'app_tunnel_status') {
        if (data.error) {
          this.status = 'error';
          this._lastError = data.error;
        } else {
          this.status = data.running ? 'running' : 'stopped';
        }
        this.publicUrl = data.publicUrl || null;
        this._updateButton();
        if (!this._bannerDismissed) this._renderBanner();
      } else if (data.type === 'app_tunnel_restarting') {
        this.status = 'restarting';
        this.publicUrl = null;
        this._updateButton();
        if (!this._bannerDismissed) this._renderBanner();
      }
    }

    /**
     * Fetch tunnel status via REST.
     */
    async _fetchStatus() {
      try {
        const fetchFn = this.app && this.app.authFetch
          ? (url, opts) => this.app.authFetch(url, opts)
          : (url, opts) => fetch(url, opts);

        const res = await fetchFn('/api/tunnel/status');
        if (res.ok) {
          const data = await res.json();
          this.status = data.running ? 'running' : 'stopped';
          this.publicUrl = data.publicUrl || null;
          this._updateButton();
        }
      } catch {
        // Ignore fetch errors (e.g., server not reachable)
      }
    }

    _updateButton() {
      if (!this.button) return;
      this.button.classList.remove('running', 'starting', 'error');
      if (this.status === 'running') {
        this.button.classList.add('running');
      } else if (this.status === 'restarting') {
        this.button.classList.add('starting');
      } else if (this.status === 'error') {
        this.button.classList.add('error');
      }
      // Hide button entirely when tunnel is not configured
      this.button.style.display = (this.status === 'stopped' || this.status === 'unknown') && !this.publicUrl
        ? 'none' : '';
    }

    _renderBanner() {
      if (!this.banner) return;

      if ((this.status === 'stopped' || this.status === 'unknown') && !this.publicUrl) {
        this.banner.classList.remove('visible');
        return;
      }

      if (this._bannerDismissed) {
        this.banner.classList.remove('visible');
        return;
      }

      this.banner.classList.add('visible');

      if (this.status === 'restarting') {
        this._renderRestartingBanner();
      } else if (this.status === 'error') {
        this._renderErrorBanner();
      } else if (this.status === 'running' && this.publicUrl) {
        this._renderRunningBanner();
      }
    }

    _renderRunningBanner() {
      const shortUrl = this.publicUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, '');
      this.banner.innerHTML = `
        <span class="vst-icon running">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
        </span>
        <span class="vst-message">
          Tunnel:
          <span class="vst-url" title="${this._escapeHtml(this.publicUrl)}">${this._escapeHtml(shortUrl)}</span>
        </span>
        <div class="vst-actions">
          <button class="vst-btn vst-copy-btn">Copy URL</button>
          <button class="vst-btn primary vst-open-btn">Open</button>
          <button class="vst-btn vst-restart-btn">Restart Tunnel</button>
        </div>
        <button class="vst-close vst-dismiss-btn" title="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
      this._bindBannerEvents();
    }

    _renderErrorBanner() {
      const msg = this._lastError || 'Tunnel restart failed';
      this.banner.innerHTML = `
        <span class="vst-icon error">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </span>
        <span class="vst-message">${this._escapeHtml(msg)}</span>
        <div class="vst-actions">
          <button class="vst-btn vst-restart-btn">Retry</button>
        </div>
        <button class="vst-close vst-dismiss-btn" title="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
      this._bindBannerEvents();
    }

    _renderRestartingBanner() {
      this.banner.innerHTML = `
        <span class="vst-spinner"></span>
        <span class="vst-message">Restarting tunnel...</span>
        <button class="vst-close vst-dismiss-btn" title="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
      this._bindBannerEvents();
    }

    _bindBannerEvents() {
      if (!this.banner) return;
      const self = this;

      const copyBtn = this.banner.querySelector('.vst-copy-btn');
      if (copyBtn) copyBtn.addEventListener('click', () => self.copyUrl());

      const openBtn = this.banner.querySelector('.vst-open-btn');
      if (openBtn) openBtn.addEventListener('click', () => self.openUrl());

      const restartBtn = this.banner.querySelector('.vst-restart-btn');
      if (restartBtn) restartBtn.addEventListener('click', () => self.restart());

      const dismissBtn = this.banner.querySelector('.vst-dismiss-btn');
      if (dismissBtn) dismissBtn.addEventListener('click', () => self.dismiss());

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
    window.AppTunnelUI = AppTunnelUI;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AppTunnelUI };
  }
})();
