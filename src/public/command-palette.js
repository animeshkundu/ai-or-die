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

    // '?' key opens keyboard shortcuts when terminal is NOT focused
    document.addEventListener('keydown', (e) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const active = document.activeElement;
        const isInput = active && (
          active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          active.isContentEditable
        );
        const isTerminal = active && active.closest('.xterm');
        if (!isInput && !isTerminal) {
          e.preventDefault();
          this._showShortcutsModal();
        }
      }
    });
  }

  _showShortcutsModal() {
    const modal = document.getElementById('shortcutsModal');
    if (!modal) return;
    modal.classList.add('active');

    // Bind close handlers once
    if (!modal._bound) {
      modal._bound = true;
      const closeBtn = document.getElementById('closeShortcutsBtn');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => modal.classList.remove('active'));
      }
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) {
          modal.classList.remove('active');
        }
      });
    }
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
            description: `Switch to the "${session.name}" session`,
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
      description: 'Create a new terminal session quickly',
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
      description: 'Create a new terminal session with folder picker',
      section: 'Sessions',
      handler: () => {
        const app = window.app;
        if (app && app.sessionTabManager) {
          app.sessionTabManager.createNewSession();
        }
      }
    });

    // --- Close current session ---
    actions.push({
      id: 'close-session',
      title: 'Close Current Session',
      description: 'Close the currently active session tab',
      section: 'Sessions',
      handler: () => {
        document.querySelector('.session-tab.active .tab-close')?.click();
      }
    });

    // --- Rename session ---
    actions.push({
      id: 'rename-session',
      title: 'Rename Session',
      description: 'Rename the currently active session',
      section: 'Sessions',
      handler: () => {
        const tab = document.querySelector('.session-tab.active .tab-name');
        if (tab) {
          const dblclick = new MouseEvent('dblclick', { bubbles: true });
          tab.dispatchEvent(dblclick);
        }
      }
    });

    // --- Restart Dev Tunnel ---
    actions.push({
      id: 'restart-tunnel',
      title: 'Restart Dev Tunnel',
      description: 'Restart the development tunnel connection',
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
      { value: 'midnight', label: 'Midnight', description: 'Dark theme with deep black background' },
      { value: 'classic-dark', label: 'Classic Dark', description: 'Traditional dark color scheme' },
      { value: 'classic-light', label: 'Classic Light', description: 'Clean light color scheme' },
      { value: 'monokai', label: 'Monokai', description: 'Warm dark theme inspired by Sublime Text' },
      { value: 'nord', label: 'Nord', description: 'Arctic blue-tinted dark theme' },
      { value: 'solarized-dark', label: 'Solarized Dark', description: 'Balanced dark theme with warm accents' },
      { value: 'solarized-light', label: 'Solarized Light', description: 'Balanced light theme with warm accents' },
    ];

    for (const theme of themes) {
      actions.push({
        id: `theme-${theme.value}`,
        title: `Theme: ${theme.label}`,
        description: theme.description,
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

          // Update ninja-keys dark/light class
          this._syncThemeClass(theme.value);
        }
      });
    }

    // --- Actions ---
    actions.push({
      id: 'open-settings',
      title: 'Open Settings',
      description: 'Open the application settings panel',
      section: 'Actions',
      handler: () => {
        const btn = document.getElementById('settingsBtn');
        if (btn) btn.click();
      }
    });

    actions.push({
      id: 'clear-terminal',
      title: 'Clear Terminal',
      description: 'Clear the terminal screen',
      section: 'Actions',
      handler: () => {
        if (app.terminal) app.terminal.clear();
      }
    });

    actions.push({
      id: 'toggle-file-browser',
      title: 'Toggle File Browser',
      description: 'Show or hide the file browser sidebar',
      section: 'Actions',
      hotkey: 'ctrl+b',
      handler: () => {
        if (app.toggleFileBrowser) app.toggleFileBrowser();
      }
    });

    actions.push({
      id: 'open-file-by-path',
      title: 'Open File by Path...',
      description: 'Open a file using its full path',
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
      description: 'Upload a file to the current working directory',
      section: 'Actions',
      handler: () => {
        if (app.toggleFileBrowser) {
          app.toggleFileBrowser();
          setTimeout(() => {
            if (app._fileBrowserPanel) app._fileBrowserPanel.openFilePicker();
          }, 300);
        }
      }
    });

    actions.push({
      id: 'search-terminal',
      title: 'Search Terminal',
      description: 'Find text in the terminal output',
      section: 'Actions',
      hotkey: 'ctrl+f',
      handler: () => {
        const bar = document.getElementById('terminalSearchBar');
        const input = document.getElementById('termSearchInput');
        if (bar && input) {
          bar.style.display = 'flex';
          input.focus();
          input.select();
        }
      }
    });

    actions.push({
      id: 'copy-output',
      title: 'Copy Terminal Output',
      description: 'Select and copy all terminal content to clipboard',
      section: 'Actions',
      handler: () => {
        if (app.terminal) {
          app.terminal.selectAll();
          document.execCommand('copy');
          app.terminal.clearSelection();
        }
      }
    });

    actions.push({
      id: 'reconnect',
      title: 'Reconnect',
      description: 'Reconnect the WebSocket connection to the server',
      section: 'Actions',
      handler: () => {
        if (app.reconnect) app.reconnect();
      }
    });

    // VS Code Tunnel commands
    actions.push({
      id: 'vscode-tunnel-start',
      title: 'VS Code Tunnel: Start',
      description: 'Start a VS Code development tunnel',
      section: 'Actions',
      hotkey: 'ctrl+shift+v',
      handler: () => {
        if (app.toggleVSCodeTunnel) app.toggleVSCodeTunnel();
      }
    });

    actions.push({
      id: 'vscode-tunnel-stop',
      title: 'VS Code Tunnel: Stop',
      description: 'Stop the running VS Code tunnel',
      section: 'Actions',
      handler: () => {
        if (app.stopVSCodeTunnel) app.stopVSCodeTunnel();
      }
    });

    actions.push({
      id: 'vscode-tunnel-copy-url',
      title: 'VS Code Tunnel: Copy URL',
      description: 'Copy the VS Code tunnel URL to clipboard',
      section: 'Actions',
      handler: () => {
        if (app.copyVSCodeTunnelUrl) app.copyVSCodeTunnelUrl();
      }
    });

    actions.push({
      id: 'voice-input',
      title: 'Voice Input: Toggle Recording',
      description: 'Start or stop voice-to-text input',
      section: 'Actions',
      hotkey: 'ctrl+shift+m',
      handler: () => {
        if (app.voiceController) app.voiceController.toggleRecording();
      }
    });

    // --- Help ---
    actions.push({
      id: 'keyboard-shortcuts',
      title: 'Keyboard Shortcuts',
      description: 'Show all available keyboard shortcuts',
      section: 'Help',
      handler: () => {
        this._showShortcutsModal();
      }
    });

    this.ninja.data = actions;
  }

  _syncThemeClass(themeValue) {
    if (!this.ninja) return;
    const lightThemes = ['classic-light', 'solarized-light'];
    if (lightThemes.includes(themeValue)) {
      this.ninja.classList.remove('dark');
    } else {
      this.ninja.classList.add('dark');
    }
  }
}

// Instantiate globally so app.js can access it
window.commandPaletteManager = new CommandPaletteManager();
