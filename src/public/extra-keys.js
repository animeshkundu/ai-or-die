'use strict';

class ExtraKeys {
  constructor(options = {}) {
    this.app = options.app;
    this.container = null;
    this.ctrlActive = false;
    this.altActive = false;
    this._visible = false;
    this._row2 = null;
    this._resizeHandler = null;
    this._build();
  }

  _build() {
    this.container = document.createElement('div');
    this.container.className = 'extra-keys-bar';
    this.container.setAttribute('aria-label', 'Terminal modifier keys');

    const row1Keys = [
      { label: 'Tab', data: '\t' },
      { label: 'Ctrl', modifier: 'ctrl' },
      { label: 'Alt', modifier: 'alt' },
      { label: 'Esc', data: '\x1b' },
      { label: 'Home', data: '\x1b[H' },
      { label: 'End', data: '\x1b[F' },
      { label: 'PgUp', data: '\x1b[5~' },
      { label: 'PgDn', data: '\x1b[6~' },
      { label: '\u2190', data: '\x1b[D', aria: 'Left arrow' },
      { label: '\u2192', data: '\x1b[C', aria: 'Right arrow' },
      { label: '\u2191', data: '\x1b[A', aria: 'Up arrow' },
      { label: '\u2193', data: '\x1b[B', aria: 'Down arrow' },
      { label: '\u21E9', dismiss: true, aria: 'Dismiss keyboard' },
    ];

    const row2Keys = [
      { label: '|', data: '|' },
      { label: '/', data: '/' },
      { label: '\\', data: '\\' },
      { label: '-', data: '-' },
      { label: '_', data: '_' },
      { label: '~', data: '~' },
      { label: '`', data: '`' },
      { label: '{', data: '{' },
      { label: '}', data: '}' },
      { label: '[', data: '[' },
      { label: ']', data: ']' },
      { label: '(', data: '(' },
      { label: ')', data: ')' },
      { label: ';', data: ';' },
      { label: ':', data: ':' },
      { label: '=', data: '=' },
      { label: '+', data: '+' },
      { label: '&', data: '&' },
      { label: '@', data: '@' },
    ];

    const row1 = this._buildRow(row1Keys);
    row1.setAttribute('aria-label', 'Modifiers and navigation');
    this.container.appendChild(row1);

    this._row2 = this._buildRow(row2Keys);
    this._row2.setAttribute('aria-label', 'Symbols');
    this.container.appendChild(this._row2);

    document.body.appendChild(this.container);

    this._resizeHandler = () => this._updateRow2Visibility();
    window.addEventListener('resize', this._resizeHandler);
  }

  _buildRow(keys) {
    const row = document.createElement('div');
    row.className = 'extra-keys-row';

    keys.forEach(key => {
      const btn = document.createElement('button');
      btn.className = 'extra-key';
      btn.textContent = key.label;
      btn.setAttribute('aria-label', key.aria || key.label);

      if (key.dismiss) {
        btn.classList.add('extra-key-dismiss');
        btn.addEventListener('click', () => this._dismiss());
      } else if (key.modifier) {
        btn.classList.add('extra-key-modifier');
        btn.dataset.modifier = key.modifier;
        btn.addEventListener('click', () => this._toggleModifier(key.modifier, btn));
      } else {
        btn.addEventListener('click', () => this._sendKey(key.data));
      }

      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
      row.appendChild(btn);
    });

    return row;
  }

  _dismiss() {
    if (this.app && this.app.terminal && this.app.terminal.textarea) {
      this.app.terminal.textarea.blur();
    }
  }

  _sendKey(data) {
    if (!this.app) return;
    if ('vibrate' in navigator) try { navigator.vibrate(10); } catch (_) {}
    let toSend = data;

    // Apply Ctrl modifier
    if (this.ctrlActive) {
      if (data.length === 1) {
        // Single printable char → control code (Ctrl+C = \x03, etc.)
        const code = data.charCodeAt(0);
        if (code >= 97 && code <= 122) toSend = String.fromCharCode(code - 96); // a-z
        else if (code >= 65 && code <= 90) toSend = String.fromCharCode(code - 64); // A-Z
      } else if (data.startsWith('\x1b[') && data.length >= 3) {
        // CSI sequences (arrows, Home, End, PgUp, PgDn) → add Ctrl modifier parameter
        // e.g., \x1b[D (Left) → \x1b[1;5D (Ctrl+Left)
        const lastChar = data[data.length - 1];
        if (/[A-D]/.test(lastChar)) {
          // Arrow keys: \x1b[A-D → \x1b[1;5A-D
          toSend = '\x1b[1;5' + lastChar;
        } else if (data.endsWith('~')) {
          // PgUp/PgDn: \x1b[5~ → \x1b[5;5~, \x1b[6~ → \x1b[6;5~
          toSend = data.slice(0, -1) + ';5~';
        } else {
          // Home/End: \x1b[H → \x1b[1;5H, \x1b[F → \x1b[1;5F
          toSend = '\x1b[1;5' + lastChar;
        }
      }
      this.ctrlActive = false;
      if (this._ctrlTimeout) { clearTimeout(this._ctrlTimeout); this._ctrlTimeout = null; }
      this._updateModifierVisual('ctrl');
      if (this.app._ctrlModifierPending) this.app._ctrlModifierPending = false;
    }

    // Apply Alt modifier
    if (this.altActive) {
      // Prepend ESC for Alt: Alt+x = \x1b x, Alt+Left = \x1b \x1b[D
      toSend = '\x1b' + toSend;
      this.altActive = false;
      if (this._altTimeout) { clearTimeout(this._altTimeout); this._altTimeout = null; }
      this._updateModifierVisual('alt');
    }

    this.app.send({ type: 'input', data: toSend });
    if (this.app.terminal) this.app.terminal.focus();
  }

  _toggleModifier(modifier, btn) {
    if (modifier === 'ctrl') {
      this.ctrlActive = !this.ctrlActive;
      this._updateModifierVisual('ctrl');
      if (this.ctrlActive && this.app) {
        this._interceptNextKey();
        this._ctrlTimeout = setTimeout(() => {
          this.ctrlActive = false;
          this._ctrlTimeout = null;
          this._updateCtrlVisual();
        }, 5000);
      } else if (this._ctrlTimeout) {
        clearTimeout(this._ctrlTimeout);
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
    }
  }

  _interceptNextKey() {
    if (!this.app || !this.app.terminal) return;
    this.app._ctrlModifierPending = true;
  }

  _updateModifierVisual(modifier) {
    const btns = this.container.querySelectorAll('.extra-key-modifier');
    btns.forEach(btn => {
      if (btn.dataset.modifier === modifier) {
        const isActive = modifier === 'ctrl' ? this.ctrlActive : this.altActive;
        btn.classList.toggle('active', isActive);
      }
    });
  }

  // Backward-compatible alias used by app.js
  _updateCtrlVisual() {
    this._updateModifierVisual('ctrl');
  }

  _updateRow2Visibility() {
    if (!this._row2 || !this._visible) return;
    const termEl = document.getElementById('terminal');
    const height = termEl ? termEl.offsetHeight : window.innerHeight;
    if (height > 400) {
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
    this._updateModifierVisual('ctrl');
    this._updateModifierVisual('alt');
  }

  get visible() { return this._visible; }
}

if (typeof window !== 'undefined') {
  window.ExtraKeys = ExtraKeys;
}
