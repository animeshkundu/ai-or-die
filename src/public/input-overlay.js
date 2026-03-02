/**
 * InputOverlay — Type-ahead input overlay for composing multi-line text
 * before sending to the terminal. Supports Insert (paste-only) and Send
 * (paste + Enter) modes with bracketed paste handling.
 */

class InputOverlay {
  constructor(app) {
    this.app = app;
    this._open = false;
    this._targetSendFn = null;
    this._targetTerminal = null;
    this._targetSocket = null;
    this._initDOM();
    this._bindKeys();
  }

  // ── DOM setup ────────────────────────────────────────────────

  _initDOM() {
    this._backdrop = document.getElementById('inputOverlayBackdrop');
    this._overlay = document.getElementById('inputOverlay');
    this._textarea = document.getElementById('inputOverlayText');
    this._charCount = document.getElementById('inputCharCount');
    this._voiceBtn = document.getElementById('inputOverlayVoice');
    this._triggerBtn = document.getElementById('inputOverlayBtn');

    // Footer buttons
    var cancelBtn = this._overlay.querySelector('.input-overlay-cancel');
    var insertBtn = this._overlay.querySelector('.input-overlay-insert');
    var sendBtn = this._overlay.querySelector('.input-overlay-send');

    this._insertBtn = insertBtn;
    this._sendBtn = sendBtn;

    // Event wiring
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.hide());
    if (insertBtn) insertBtn.addEventListener('click', () => this._deliverText('insert'));
    if (sendBtn) sendBtn.addEventListener('click', () => this._deliverText('send'));
    if (this._triggerBtn) this._triggerBtn.addEventListener('click', () => this.toggle());
    if (this._voiceBtn) this._voiceBtn.addEventListener('click', () => this._toggleVoice());

    // Textarea: update char count and disable/enable buttons
    if (this._textarea) {
      this._textarea.addEventListener('input', () => this._updateCharCount());
      // Ctrl+Enter = Insert, Ctrl+Shift+Enter = Send, Shift+Enter = newline (default)
      this._textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.hide();
          return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
          e.preventDefault();
          this._deliverText('send');
          return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this._deliverText('insert');
          return;
        }
      });
    }

    // Backdrop click closes overlay
    if (this._backdrop) {
      this._backdrop.addEventListener('click', () => this.hide());
    }

    this._updateCharCount();
  }

  // ── Keyboard shortcut: Ctrl+Shift+Space (capture phase) ──────

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        this.toggle();
      }
    }, true);
  }

  // ── Show / Hide / Toggle ─────────────────────────────────────

  toggle() {
    if (this._open) {
      this.hide();
    } else {
      this.show();
    }
  }

  show() {
    if (this._open) return;
    this._open = true;

    // Capture target terminal/socket from the active pane at open time
    this._captureTarget();

    // Show DOM
    if (this._backdrop) this._backdrop.style.display = '';
    if (this._overlay) this._overlay.style.display = '';

    // Clear textarea
    if (this._textarea) {
      this._textarea.value = '';
      this._textarea.focus();
    }
    this._updateCharCount();

    // Redirect voice to overlay
    if (this.app) this.app._voiceTarget = 'overlay';

    // Suppress plan detection while overlay is active
    if (this.app && this.app.planDetector) {
      this.app.planDetector._suppressDetection = true;
    }

    // Update voice button state
    this._syncVoiceState();
  }

  hide() {
    if (!this._open) return;
    this._open = false;

    // Hide DOM
    if (this._backdrop) this._backdrop.style.display = 'none';
    if (this._overlay) this._overlay.style.display = 'none';

    // Restore voice target
    if (this.app) this.app._voiceTarget = 'terminal';

    // Unsuppress plan detection
    if (this.app && this.app.planDetector) {
      this.app.planDetector._suppressDetection = false;
    }

    // Release target references
    this._targetSendFn = null;
    this._targetTerminal = null;
    this._targetSocket = null;

    // Refocus terminal
    if (this.app && this.app.terminal) {
      this.app.terminal.focus();
    }
  }

  // ── Target capture ───────────────────────────────────────────

  _captureTarget() {
    // Use split pane if available, otherwise main terminal
    var paneIndex = (this.app && typeof this.app._lastFocusedPaneIndex === 'number')
      ? this.app._lastFocusedPaneIndex
      : 0;

    if (this.app && this.app.splitContainer && this.app.splitContainer.splits &&
        this.app.splitContainer.splits.length > 0 && paneIndex > 0) {
      var split = this.app.splitContainer.splits[paneIndex];
      if (split && split.terminal && split.socket) {
        this._targetTerminal = split.terminal;
        this._targetSocket = split.socket;
        this._targetSendFn = function(msg) {
          if (split.socket && split.socket.readyState === WebSocket.OPEN) {
            split.socket.send(JSON.stringify(msg));
          }
        };
        return;
      }
    }

    // Default: main terminal
    var app = this.app;
    this._targetTerminal = app ? app.terminal : null;
    this._targetSocket = app ? app.socket : null;
    this._targetSendFn = function(msg) {
      if (app) app.send(msg);
    };
  }

  // ── Text delivery ────────────────────────────────────────────

  _deliverText(mode) {
    if (!this._textarea || !this._textarea.value.trim()) return;
    var raw = this._textarea.value;
    var terminal = this._targetTerminal;
    var sendFn = this._targetSendFn;

    if (!sendFn) return;

    // Check connection
    var sock = this._targetSocket;
    if (!sock || sock.readyState !== WebSocket.OPEN) {
      if (window.feedback) window.feedback.warning('Not connected — text not sent');
      return;
    }

    var bpm = terminal && terminal.modes && terminal.modes.bracketedPasteMode;

    var normalizeLineEndings = (typeof attachClipboardHandler !== 'undefined' && attachClipboardHandler.normalizeLineEndings)
      ? attachClipboardHandler.normalizeLineEndings
      : function(t) { return t.replace(/\r\n/g, '\r').replace(/\n/g, '\r'); };
    var wrapBracketedPaste = (typeof attachClipboardHandler !== 'undefined' && attachClipboardHandler.wrapBracketedPaste)
      ? attachClipboardHandler.wrapBracketedPaste
      : function(t) { return '\x1b[200~' + t + '\x1b[201~'; };

    var data;
    if (mode === 'insert') {
      if (bpm) {
        data = wrapBracketedPaste(normalizeLineEndings(raw));
      } else {
        // Collapse newlines to spaces — no way to insert without executing in raw mode
        data = raw.replace(/[\r\n]+/g, ' ');
      }
    } else {
      // Send mode: paste + Enter
      var normalized = normalizeLineEndings(raw);
      data = bpm ? wrapBracketedPaste(normalized) : normalized;
      data = data + '\r';
    }

    sendFn({ type: 'input', data: data });

    // Clear and close
    this._textarea.value = '';
    this._updateCharCount();
    this.hide();
  }

  // ── Character count ──────────────────────────────────────────

  _updateCharCount() {
    var ta = this._textarea;
    var el = this._charCount;
    if (ta && el) {
      var len = ta.value.length;
      el.textContent = len > 1000 ? Math.round(len / 1024) + 'KB' : len;
      el.classList.toggle('charcount-warn', len > 204800);
    }

    // Disable buttons when empty
    var empty = !ta || ta.value.length === 0;
    if (this._insertBtn) this._insertBtn.disabled = empty;
    if (this._sendBtn) this._sendBtn.disabled = empty;
  }

  // ── Voice toggle ─────────────────────────────────────────────

  _toggleVoice() {
    if (!this.app || !this.app.voiceController) return;
    // Delegate to the header voice button click to reuse existing start/stop logic
    var headerBtn = document.getElementById('voiceInputBtn');
    if (headerBtn) headerBtn.click();
    // Sync recording state after a tick
    var self = this;
    setTimeout(function() { self._syncVoiceState(); }, 100);
  }

  _syncVoiceState() {
    if (!this._voiceBtn) return;
    var headerBtn = document.getElementById('voiceInputBtn');
    var recording = headerBtn && headerBtn.classList.contains('recording');
    this._voiceBtn.classList.toggle('recording', !!recording);

    // Hide voice button if voice is not configured
    if (!this.app || !this.app.voiceController) {
      this._voiceBtn.style.display = 'none';
    } else {
      this._voiceBtn.style.display = '';
    }
  }
}

// Dual-export: browser + Node
if (typeof window !== 'undefined') {
  window.InputOverlay = InputOverlay;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { InputOverlay };
}
