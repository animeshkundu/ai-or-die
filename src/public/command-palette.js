/**
 * Command Palette — powered by ninja-keys Web Component.
 * Provides Ctrl+K quick-action search: switch sessions, change theme,
 * open settings, toggle split view, clear terminal.
 */
class CommandPaletteManager {
  constructor() {
    this.ninja = null;
    this.app = null;
    // Wait for both DOM and ninja-keys custom element to be defined
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._init());
    } else {
      this._init();
    }
  }

  _init() {
    // ninja-keys is loaded as a module; the custom element may not be
    // defined immediately. Poll briefly to find it.
    const tryBind = () => {
      this.ninja = document.querySelector('ninja-keys');
      if (this.ninja) {
        this._bindActions();
        this._setupKeyboard();
      } else {
        // Retry until the web component is ready (max ~3s)
        setTimeout(tryBind, 200);
      }
    };
    tryBind();
  }

  _setupKeyboard() {
    // Intercept Ctrl+K to open the palette when terminal has focus
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        if (this.ninja) this.ninja.open();
      }
    }, true); // capture phase so it fires before xterm
  }

  _bindActions() {
    // Re-bind whenever the palette is opened so session list is fresh
    if (this.ninja) {
      this.ninja.addEventListener('open', () => this.refreshActions());
    }
    this.refreshActions();
  }

  refreshActions() {
    if (!this.ninja) return;
    const app = window.app;
    if (!app) return;

    const actions = [];

    // --- Session switching ---
    if (app.sessionTabManager) {
      const sessions = app.sessionTabManager.activeSessions;
      if (sessions && sessions.size > 0) {
        sessions.forEach((session, id) => {
          actions.push({
            id: `session-${id}`,
            title: `Switch to: ${session.name}`,
            section: 'Sessions',
            handler: () => {
              app.sessionTabManager.switchToTab(id);
            }
          });
        });
      }
    }

    // --- New session ---
    actions.push({
      id: 'new-session',
      title: 'New Session',
      section: 'Sessions',
      hotkey: 'ctrl+t',
      handler: () => {
        const btn = document.getElementById('tabNewBtn');
        if (btn) btn.click();
      }
    });

    // --- New session (choose folder) ---
    actions.push({
      id: 'new-session-browse',
      title: 'New Session (Choose Folder)',
      section: 'Sessions',
      handler: () => {
        const app = window.app;
        if (app && app.sessionTabManager) {
          app.sessionTabManager.createNewSession();
        }
      }
    });

    // --- Restart Dev Tunnel ---
    actions.push({
      id: 'restart-tunnel',
      title: 'Restart Dev Tunnel',
      section: 'Server',
      handler: () => {
        const app = window.app;
        if (app && app.restartAppTunnel) {
          app.restartAppTunnel();
        }
      }
    });

    // --- Theme switching ---
    const themes = [
      { value: 'midnight', label: 'Midnight' },
      { value: 'classic-dark', label: 'Classic Dark' },
      { value: 'classic-light', label: 'Classic Light' },
      { value: 'monokai', label: 'Monokai' },
      { value: 'nord', label: 'Nord' },
      { value: 'solarized-dark', label: 'Solarized Dark' },
      { value: 'solarized-light', label: 'Solarized Light' },
    ];

    for (const theme of themes) {
      actions.push({
        id: `theme-${theme.value}`,
        title: `Theme: ${theme.label}`,
        section: 'Appearance',
        handler: () => {
          if (theme.value === 'midnight') {
            document.documentElement.removeAttribute('data-theme');
          } else {
            document.documentElement.setAttribute('data-theme', theme.value);
          }
          // Persist the choice
          try {
            const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
            settings.theme = theme.value;
            localStorage.setItem('cc-web-settings', JSON.stringify(settings));
            if (app.applySettings) app.applySettings(settings);
          } catch (_) { /* ignore */ }
        }
      });
    }

    // --- Actions ---
    actions.push({
      id: 'open-settings',
      title: 'Open Settings',
      section: 'Actions',
      handler: () => {
        const btn = document.getElementById('settingsBtn');
        if (btn) btn.click();
      }
    });

    actions.push({
      id: 'clear-terminal',
      title: 'Clear Terminal',
      section: 'Actions',
      handler: () => {
        if (app.terminal) app.terminal.clear();
      }
    });

    actions.push({
      id: 'toggle-file-browser',
      title: 'Toggle File Browser',
      section: 'Actions',
      hotkey: 'ctrl+b',
      handler: () => {
        if (app.toggleFileBrowser) app.toggleFileBrowser();
      }
    });

    actions.push({
      id: 'open-file-by-path',
      title: 'Open File by Path...',
      section: 'Actions',
      hotkey: 'ctrl+shift+o',
      handler: () => {
        const filePath = prompt('Enter file path:');
        if (filePath && app.openFileInViewer) app.openFileInViewer(filePath);
      }
    });

    actions.push({
      id: 'upload-file',
      title: 'Upload File',
      section: 'Actions',
      handler: () => {
        if (app.toggleFileBrowser) {
          app.toggleFileBrowser();
          // Open file picker after panel opens
          setTimeout(() => {
            if (app._fileBrowserPanel) app._fileBrowserPanel._openFilePicker();
          }, 300);
        }
      }
    });

    // VS Code Tunnel commands
    actions.push({
      id: 'vscode-tunnel-start',
      title: 'VS Code Tunnel: Start',
      section: 'Actions',
      hotkey: 'ctrl+shift+v',
      handler: () => {
        if (app.toggleVSCodeTunnel) app.toggleVSCodeTunnel();
      }
    });

    actions.push({
      id: 'vscode-tunnel-stop',
      title: 'VS Code Tunnel: Stop',
      section: 'Actions',
      handler: () => {
        if (app.stopVSCodeTunnel) app.stopVSCodeTunnel();
      }
    });

    actions.push({
      id: 'vscode-tunnel-copy-url',
      title: 'VS Code Tunnel: Copy URL',
      section: 'Actions',
      handler: () => {
        if (app.copyVSCodeTunnelUrl) app.copyVSCodeTunnelUrl();
      }
    });

    actions.push({
      id: 'voice-input',
      title: 'Voice Input: Toggle Recording',
      section: 'Actions',
      hotkey: 'ctrl+shift+m',
      handler: () => {
        if (app.voiceController) app.voiceController.toggleRecording();
      }
    });

    this.ninja.data = actions;
  }
}

// Instantiate globally so app.js can access it
window.commandPaletteManager = new CommandPaletteManager();
