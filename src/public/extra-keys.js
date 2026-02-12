'use strict';

class ExtraKeys {
  constructor(options = {}) {
    this.app = options.app;
    this.container = null;
    this.ctrlActive = false;
    this._visible = false;
    this._build();
  }

  _build() {
    this.container = document.createElement('div');
    this.container.className = 'extra-keys-bar';
    this.container.setAttribute('aria-label', 'Terminal modifier keys');

    const keys = [
      { label: 'Tab', data: '\t' },
      { label: 'Ctrl', modifier: true },
      { label: 'Esc', data: '\x1b' },
      { label: '\u2190', data: '\x1b[D', aria: 'Left arrow' },
      { label: '\u2192', data: '\x1b[C', aria: 'Right arrow' },
      { label: '\u2191', data: '\x1b[A', aria: 'Up arrow' },
      { label: '\u2193', data: '\x1b[B', aria: 'Down arrow' },
      { label: '|', data: '|' },
      { label: '/', data: '/' },
      { label: '-', data: '-' },
      { label: '~', data: '~' },
      { label: '_', data: '_' },
    ];

    keys.forEach(key => {
      const btn = document.createElement('button');
      btn.className = 'extra-key';
      btn.textContent = key.label;
      btn.setAttribute('aria-label', key.aria || key.label);
      if (key.modifier) {
        btn.classList.add('extra-key-modifier');
        btn.addEventListener('click', () => this._toggleCtrl(btn));
      } else {
        btn.addEventListener('click', () => this._sendKey(key.data));
      }
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
      this.container.appendChild(btn);
    });

    document.body.appendChild(this.container);
  }

  _sendKey(data) {
    if (!this.app) return;
    let toSend = data;
    if (this.ctrlActive) {
      // Apply Ctrl modifier: convert single printable char to control code
      if (data.length === 1) {
        const code = data.charCodeAt(0);
        if (code >= 97 && code <= 122) toSend = String.fromCharCode(code - 96); // a-z
        else if (code >= 65 && code <= 90) toSend = String.fromCharCode(code - 64); // A-Z
      }
      this.ctrlActive = false;
      this._updateCtrlVisual();
      if (this.app._ctrlModifierPending) this.app._ctrlModifierPending = false;
    }
    this.app.send({ type: 'input', data: toSend });
    if (this.app.terminal) this.app.terminal.focus();
  }

  _toggleCtrl(btn) {
    this.ctrlActive = !this.ctrlActive;
    this._updateCtrlVisual();
    if (this.ctrlActive && this.app) {
      this._interceptNextKey();
    }
  }

  _interceptNextKey() {
    if (!this.app || !this.app.terminal) return;
    this.app._ctrlModifierPending = true;
  }

  _updateCtrlVisual() {
    const ctrlBtn = this.container.querySelector('.extra-key-modifier');
    if (ctrlBtn) {
      ctrlBtn.classList.toggle('active', this.ctrlActive);
    }
  }

  show() {
    if (this._visible) return;
    this._visible = true;
    this.container.classList.add('visible');
  }

  hide() {
    if (!this._visible) return;
    this._visible = false;
    this.container.classList.remove('visible');
    this.ctrlActive = false;
    this._updateCtrlVisual();
  }

  get visible() { return this._visible; }
}

if (typeof window !== 'undefined') {
  window.ExtraKeys = ExtraKeys;
}
