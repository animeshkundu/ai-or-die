'use strict';

// extra-keys.js — the on-screen "extra keys" bar shown above the mobile soft
// keyboard (Compose mode). Renders modifier + navigation keys the iOS keyboard
// lacks and streams the correct bytes to the pty.
//
// Key encoding is delegated to KeyEncoder (key-encoder.js) so synthetic presses
// are MODE-AWARE: arrows emit SS3 (ESC O A) under application-cursor mode and
// CSI (ESC [ A) otherwise, matching what a physical key would send through
// xterm's own encoder. Do not hardcode raw escape bytes here.
// See docs/specs/mobile-input.md and ADR-0037.

class ExtraKeys {
  constructor(options = {}) {
    this.app = options.app;
    this.container = null;
    this.ctrlActive = false;
    this.altActive = false;
    this.shiftActive = false;
    this._visible = false;
    this._row2 = null;
    this._resizeHandler = null;
    this._build();
  }

  _build() {
    this.container = document.createElement('div');
    this.container.className = 'extra-keys-bar';
    this.container.setAttribute('aria-label', 'Terminal modifier keys');

    // Semantic key specs (not raw bytes): { key } for named keys, { char } for
    // literals, plus optional fixed modifiers (ctrl/alt/shift) for dedicated
    // combo keys like one-tap Ctrl+C and Shift+Tab. KeyEncoder turns these into
    // the correct sequence for the terminal's current modes.
    const row1Keys = [
      { label: 'Cp', title: 'Copy selection', handler: 'copy' },
      { label: 'Pst', title: 'Paste clipboard', handler: 'paste' },
      { label: '^C', char: 'c', ctrl: true, aria: 'Ctrl C interrupt', title: 'Ctrl+C — interrupt' },
      { label: 'Esc', key: 'escape' },
      { label: 'Tab', key: 'tab' },
      { label: '⇤Tab', key: 'tab', shift: true, aria: 'Shift Tab', title: 'Shift+Tab — cycle mode' },
      { label: 'Ctrl', modifier: 'ctrl' },
      { label: 'Alt', modifier: 'alt' },
      { label: 'Shift', modifier: 'shift' },
      { label: 'Home', key: 'home' },
      { label: 'End', key: 'end' },
      { label: 'PgUp', key: 'pageup' },
      { label: 'PgDn', key: 'pagedown' },
      { label: '←', key: 'left', aria: 'Left arrow', title: 'Left arrow' },
      { label: '→', key: 'right', aria: 'Right arrow', title: 'Right arrow' },
      { label: '↑', key: 'up', aria: 'Up arrow', title: 'Up arrow' },
      { label: '↓', key: 'down', aria: 'Down arrow', title: 'Down arrow' },
      { label: '⇩', dismiss: true, aria: 'Dismiss keyboard', title: 'Dismiss keyboard' },
    ];

    const row2Keys = ['|', '/', '\\', '-', '_', '~', '`', '{', '}', '[', ']',
      '(', ')', ';', ':', '=', '+', '&', '@', '!', '#'].map((c) => ({ label: c, char: c }));

    const row1 = this._buildRow(row1Keys);
    row1.setAttribute('aria-label', 'Modifiers and navigation');
    this.container.appendChild(row1);

    this._row2 = this._buildRow(row2Keys);
    this._row2.setAttribute('aria-label', 'Symbols');
    this.container.appendChild(this._row2);

    document.body.appendChild(this.container);

    this._resizeHandler = () => this._updateRow2Visibility();
    window.addEventListener('resize', this._resizeHandler);
    this._orientationHandler = () => {
      setTimeout(() => this._updateRow2Visibility(), 300);
    };
    window.addEventListener('orientationchange', this._orientationHandler);
    // NOTE: intentionally no visualViewport listener here. The soft-keyboard
    // transition is owned by app.js's single coalesced keyboard controller,
    // which refreshes row-2 visibility centrally (avoids a competing viewport
    // read during the keyboard slide). Rotation is covered by resize +
    // orientationchange above. See ADR-0037.
  }

  _buildRow(keys) {
    const row = document.createElement('div');
    row.className = 'extra-keys-row';

    keys.forEach((key) => {
      const btn = document.createElement('button');
      btn.className = 'extra-key';
      btn.textContent = key.label;
      btn.setAttribute('aria-label', key.aria || key.label);
      if (key.title) btn.setAttribute('title', key.title);

      let action;
      if (key.dismiss) {
        btn.classList.add('extra-key-dismiss');
        action = () => this._dismiss();
      } else if (key.handler) {
        btn.classList.add('extra-key-clipboard');
        action = () => {
          if (key.handler === 'copy') this._handleCopy();
          else if (key.handler === 'paste') this._handlePaste();
        };
      } else if (key.modifier) {
        btn.classList.add('extra-key-modifier');
        btn.dataset.modifier = key.modifier;
        action = () => this._toggleModifier(key.modifier, btn);
      } else {
        action = () => this._pressKey(key);
      }

      this._bindActivate(btn, action);
      row.appendChild(btn);
    });

    return row;
  }

  // Bind a tap/click action that ALSO fires on touch. Preventing default on
  // touchstart (to keep the terminal focused / soft keyboard up) suppresses the
  // emulated `click` on iOS WebKit, so the action must run from `touchend` too.
  // A guard prevents a double-fire when both touchend and a later click arrive.
  _bindActivate(btn, action) {
    let lastTouch = 0;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      lastTouch = Date.now();
      action();
    }, { passive: false });
    btn.addEventListener('click', () => {
      // Ignore only the emulated click that trails a real touch (within 700ms);
      // a genuine later click (mouse / keyboard Enter) still fires the action.
      if (Date.now() - lastTouch < 700) return;
      action();
    });
  }

  _dismiss() {
    if (this.app && this.app.terminal && this.app.terminal.textarea) {
      this.app.terminal.textarea.blur();
    }
  }

  async _handleCopy() {
    if ('vibrate' in navigator) try { navigator.vibrate(10); } catch (_) {}
    const term = this.app && this.app.terminal;
    const TC = (typeof window !== 'undefined' && window.TerminalCopy)
      || (typeof TerminalCopy !== 'undefined' ? TerminalCopy : null); // eslint-disable-line no-undef
    if (!term || !TC) {
      if (window.feedback) window.feedback.warning('Nothing to copy');
      return;
    }
    // Copy the live selection, or (on the mobile Canvas renderer, where there is
    // no long-press selection) fall back to the visible screen text.
    const res = await TC.copyVisible(term);
    if (window.feedback) {
      if (res.ok) window.feedback.success(res.source === 'selection' ? 'Copied' : 'Copied screen');
      else window.feedback.warning('Nothing to copy');
    }
  }

  async _handlePaste() {
    if ('vibrate' in navigator) try { navigator.vibrate(10); } catch (_) {}
    try {
      const text = await navigator.clipboard.readText();
      if (text && this.app && this.app.send) {
        // Wrap in bracketed paste when the TUI has it enabled so multi-line
        // pastes are not executed line-by-line.
        const enc = this._encoder();
        const modes = this._terminalModes();
        const data = enc ? enc.wrapPaste(text, modes) : text;
        this.app.send({ type: 'input', data });
        if (window.feedback) window.feedback.success('Pasted');
      }
    } catch (err) {
      if (window.feedback) window.feedback.warning('Clipboard access denied');
    }
  }

  _encoder() {
    if (typeof window !== 'undefined' && window.KeyEncoder) return window.KeyEncoder;
    if (typeof KeyEncoder !== 'undefined') return KeyEncoder; // eslint-disable-line no-undef
    return null;
  }

  _terminalModes() {
    const term = this.app && this.app.terminal;
    const modes = {};
    if (term && term.modes) {
      modes.applicationCursorKeys = !!term.modes.applicationCursorKeysMode;
      modes.bracketedPaste = !!term.modes.bracketedPasteMode;
    }
    return modes;
  }

  // Build the byte sequence for a key press, merging the key's own fixed
  // modifiers with the active sticky modifiers, then encoding mode-aware.
  _encodeKey(key) {
    const enc = this._encoder();
    if (!enc) return null;
    const spec = {
      ctrl: !!key.ctrl || this.ctrlActive,
      alt: !!key.alt || this.altActive,
      shift: !!key.shift || this.shiftActive,
    };
    if (key.key) spec.key = key.key;
    else if (key.char != null) spec.char = key.char;
    else return null;
    return enc.encode(spec, this._terminalModes());
  }

  _pressKey(key) {
    if (!this.app) return;
    const bytes = this._encodeKey(key);
    if (bytes == null) return;
    if ('vibrate' in navigator) try { navigator.vibrate(10); } catch (_) {}
    this.app.send({ type: 'input', data: bytes });
    this._consumeStickyModifiers();
    if (this.app.terminal) this.app.terminal.focus();
  }

  // Clear any sticky modifier that was active after it has been applied to a key.
  _consumeStickyModifiers() {
    if (this.ctrlActive) this._consumeCtrl();
    if (this.altActive) {
      this.altActive = false;
      if (this._altTimeout) { clearTimeout(this._altTimeout); this._altTimeout = null; }
      this._updateModifierVisual('alt');
    }
    if (this.shiftActive) {
      this.shiftActive = false;
      if (this._shiftTimeout) { clearTimeout(this._shiftTimeout); this._shiftTimeout = null; }
      this._updateModifierVisual('shift');
    }
  }

  // Atomically clear the sticky Ctrl state — ctrlActive, its 5s timeout, the
  // app.js soft-keyboard pending flag, and the visual. Used by both the bar and
  // app.js's onData Ctrl path so a stale timeout can't cancel a later Ctrl.
  _consumeCtrl() {
    this.ctrlActive = false;
    if (this._ctrlTimeout) { clearTimeout(this._ctrlTimeout); this._ctrlTimeout = null; }
    if (this.app && this.app._ctrlModifierPending) this.app._ctrlModifierPending = false;
    this._updateModifierVisual('ctrl');
  }

  _toggleModifier(modifier, btn) {
    if (modifier === 'ctrl') {
      this.ctrlActive = !this.ctrlActive;
      this._updateModifierVisual('ctrl');
      if (this.ctrlActive && this.app) {
        // Also intercept the next SOFT-keyboard letter (app.js onData path).
        this._interceptNextKey();
        this._ctrlTimeout = setTimeout(() => {
          this.ctrlActive = false;
          this._ctrlTimeout = null;
          if (this.app && this.app._ctrlModifierPending) this.app._ctrlModifierPending = false;
          this._updateModifierVisual('ctrl');
        }, 5000);
      } else if (this._ctrlTimeout) {
        clearTimeout(this._ctrlTimeout);
        this._ctrlTimeout = null;
        if (this.app && this.app._ctrlModifierPending) this.app._ctrlModifierPending = false;
      }
    } else if (modifier === 'alt') {
      this.altActive = !this.altActive;
      this._updateModifierVisual('alt');
      if (this.altActive) {
        this._altTimeout = setTimeout(() => {
          this.altActive = false;
          this._updateModifierVisual('alt');
          this._altTimeout = null;
        }, 5000);
      } else if (this._altTimeout) {
        clearTimeout(this._altTimeout);
        this._altTimeout = null;
      }
    } else if (modifier === 'shift') {
      this.shiftActive = !this.shiftActive;
      this._updateModifierVisual('shift');
      if (this.shiftActive) {
        this._shiftTimeout = setTimeout(() => {
          this.shiftActive = false;
          this._updateModifierVisual('shift');
          this._shiftTimeout = null;
        }, 5000);
      } else if (this._shiftTimeout) {
        clearTimeout(this._shiftTimeout);
        this._shiftTimeout = null;
      }
    }
  }

  _interceptNextKey() {
    if (!this.app || !this.app.terminal) return;
    this.app._ctrlModifierPending = true;
  }

  _updateModifierVisual(modifier) {
    const btns = this.container.querySelectorAll('.extra-key-modifier');
    btns.forEach((btn) => {
      if (btn.dataset.modifier === modifier) {
        let isActive = false;
        if (modifier === 'ctrl') isActive = this.ctrlActive;
        else if (modifier === 'alt') isActive = this.altActive;
        else if (modifier === 'shift') isActive = this.shiftActive;
        btn.classList.toggle('active', isActive);
      }
    });
  }

  // Backward-compatible alias used by app.js (soft-keyboard Ctrl path).
  _updateCtrlVisual() {
    this._updateModifierVisual('ctrl');
  }

  _updateRow2Visibility() {
    if (!this._row2 || !this._visible) return;
    const vpHeight = window.visualViewport
      ? window.visualViewport.height
      : window.innerHeight;
    const isLandscape = window.innerWidth > window.innerHeight;
    const threshold = isLandscape ? 280 : 400;
    if (vpHeight > threshold) {
      this._row2.classList.remove('extra-keys-row-hidden');
    } else {
      this._row2.classList.add('extra-keys-row-hidden');
    }
  }

  show() {
    if (this._visible) return;
    this._visible = true;
    this.container.classList.add('visible');
    this._updateRow2Visibility();
  }

  hide() {
    if (!this._visible) return;
    this._visible = false;
    this.container.classList.remove('visible');
    this.ctrlActive = false;
    if (this._ctrlTimeout) { clearTimeout(this._ctrlTimeout); this._ctrlTimeout = null; }
    this.altActive = false;
    if (this._altTimeout) { clearTimeout(this._altTimeout); this._altTimeout = null; }
    this.shiftActive = false;
    if (this._shiftTimeout) { clearTimeout(this._shiftTimeout); this._shiftTimeout = null; }
    if (this.app && this.app._ctrlModifierPending) this.app._ctrlModifierPending = false;
    this._updateModifierVisual('ctrl');
    this._updateModifierVisual('alt');
    this._updateModifierVisual('shift');
  }

  // Tear down all window-level listeners. Safe to call more than once. Guards
  // against listener accumulation if ExtraKeys is ever re-instantiated.
  destroy() {
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    if (this._orientationHandler) window.removeEventListener('orientationchange', this._orientationHandler);
    if (this._vvHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._vvHandler);
    }
    if (this._ctrlTimeout) { clearTimeout(this._ctrlTimeout); this._ctrlTimeout = null; }
    if (this._altTimeout) { clearTimeout(this._altTimeout); this._altTimeout = null; }
    if (this._shiftTimeout) { clearTimeout(this._shiftTimeout); this._shiftTimeout = null; }
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this._resizeHandler = this._orientationHandler = this._vvHandler = null;
  }

  get visible() { return this._visible; }
}

if (typeof window !== 'undefined') {
  window.ExtraKeys = ExtraKeys;
}

if (typeof module === 'object' && module.exports) {
  module.exports = ExtraKeys;
}
