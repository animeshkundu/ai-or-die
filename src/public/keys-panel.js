'use strict';

// keys-panel.js — the "all keys" control surface for Control mode (soft keyboard
// DOWN, full screen for reading). A launcher FAB opens a grid of every terminal
// key the iOS soft keyboard lacks: navigation, editing, Ctrl/Alt combos, and
// function keys. Taps send bytes straight to the pty via app.send — no terminal
// focus is taken, so opening/using the panel never pops the soft keyboard and
// never causes a keyboard-dismiss flicker.
//
// Encoding is delegated to KeyEncoder so sequences are mode-aware (SS3 vs CSI).
// This panel is deliberately NOT a focus trap (see ADR-0037): grabbing focus
// would blur the xterm textarea and fight the two-mode model.
// See docs/specs/mobile-input.md.

class KeysPanel {
  constructor(options = {}) {
    this.app = options.app;
    this._open = false;
    this._build();
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

  _sections() {
    return [
      { title: 'Navigation', keys: [
        { label: '←', key: 'left', aria: 'Left arrow' },
        { label: '↓', key: 'down', aria: 'Down arrow' },
        { label: '↑', key: 'up', aria: 'Up arrow' },
        { label: '→', key: 'right', aria: 'Right arrow' },
        { label: 'Home', key: 'home' },
        { label: 'End', key: 'end' },
        { label: 'PgUp', key: 'pageup', aria: 'Page up' },
        { label: 'PgDn', key: 'pagedown', aria: 'Page down' },
      ] },
      { title: 'Editing', keys: [
        { label: 'Esc', key: 'escape' },
        { label: 'Tab', key: 'tab' },
        { label: '⇤ Tab', key: 'tab', shift: true, aria: 'Shift Tab (cycle mode)' },
        { label: 'Enter', key: 'enter' },
        { label: 'Bksp', key: 'backspace', aria: 'Backspace' },
        { label: 'Del', key: 'delete', aria: 'Delete' },
        { label: 'Ins', key: 'insert', aria: 'Insert' },
      ] },
      { title: 'Control', keys: [
        { label: '^C', char: 'c', ctrl: true, aria: 'Ctrl C interrupt' },
        { label: '^D', char: 'd', ctrl: true, aria: 'Ctrl D EOF' },
        { label: '^Z', char: 'z', ctrl: true, aria: 'Ctrl Z suspend' },
        { label: '^R', char: 'r', ctrl: true, aria: 'Ctrl R search' },
        { label: '^L', char: 'l', ctrl: true, aria: 'Ctrl L clear' },
        { label: '^U', char: 'u', ctrl: true, aria: 'Ctrl U clear line' },
        { label: '^A', char: 'a', ctrl: true, aria: 'Ctrl A line start' },
        { label: '^E', char: 'e', ctrl: true, aria: 'Ctrl E line end' },
        { label: '^K', char: 'k', ctrl: true, aria: 'Ctrl K kill line' },
        { label: '^W', char: 'w', ctrl: true, aria: 'Ctrl W delete word' },
      ] },
      { title: 'Word', keys: [
        { label: '⌥B', char: 'b', alt: true, aria: 'Alt B word back' },
        { label: '⌥F', char: 'f', alt: true, aria: 'Alt F word forward' },
        { label: '⌥D', char: 'd', alt: true, aria: 'Alt D delete word forward' },
        { label: '⌥⌫', key: 'backspace', alt: true, aria: 'Alt Backspace delete word back' },
      ] },
      { title: 'Function', keys: [
        { label: 'F1', key: 'f1' }, { label: 'F2', key: 'f2' }, { label: 'F3', key: 'f3' },
        { label: 'F4', key: 'f4' }, { label: 'F5', key: 'f5' }, { label: 'F6', key: 'f6' },
        { label: 'F7', key: 'f7' }, { label: 'F8', key: 'f8' }, { label: 'F9', key: 'f9' },
        { label: 'F10', key: 'f10' }, { label: 'F11', key: 'f11' }, { label: 'F12', key: 'f12' },
      ] },
    ];
  }

  _build() {
    // Launcher FAB — always reachable in Control mode.
    this.fab = document.createElement('button');
    this.fab.id = 'keysPanelBtn';
    this.fab.type = 'button';
    this.fab.className = 'keys-panel-fab';
    this.fab.textContent = '⌨';
    this.fab.setAttribute('aria-label', 'Terminal keys');
    this.fab.setAttribute('title', 'Terminal keys');
    this.fab.addEventListener('click', () => this.toggle());

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'keys-panel__backdrop';
    this.backdrop.addEventListener('click', () => this.hide());

    this.panel = document.createElement('div');
    this.panel.id = 'keysPanel';
    this.panel.className = 'keys-panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Terminal keys');
    this.panel.setAttribute('aria-hidden', 'true');

    const header = document.createElement('div');
    header.className = 'keys-panel__header';
    const title = document.createElement('span');
    title.className = 'keys-panel__title';
    title.textContent = 'Terminal keys';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'keys-panel__close';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.hide());
    header.appendChild(title);
    header.appendChild(close);
    this.panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'keys-panel__body';

    // Utility: copy the visible terminal screen (Control mode is where you read
    // output). Uses TerminalCopy; falls back to the visible buffer on the mobile
    // Canvas renderer where long-press selection is unavailable.
    const util = document.createElement('div');
    util.className = 'keys-panel__util';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'keys-panel__util-btn';
    copyBtn.textContent = '⧉ Copy screen';
    copyBtn.setAttribute('aria-label', 'Copy visible screen');
    this._bindActivate(copyBtn, () => this._copyScreen());
    util.appendChild(copyBtn);
    body.appendChild(util);

    this._sections().forEach((section) => body.appendChild(this._buildSection(section)));
    this.panel.appendChild(body);

    document.body.appendChild(this.fab);
    document.body.appendChild(this.backdrop);
    document.body.appendChild(this.panel);
  }

  _buildSection(section) {
    const wrap = document.createElement('div');
    wrap.className = 'keys-panel__section';
    const h = document.createElement('div');
    h.className = 'keys-panel__section-title';
    h.textContent = section.title;
    wrap.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'keys-panel__grid';
    section.keys.forEach((def) => grid.appendChild(this._makeKey(def)));
    wrap.appendChild(grid);
    return wrap;
  }

  _makeKey(def) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'keys-panel__key';
    btn.textContent = def.label;
    btn.setAttribute('aria-label', def.aria || def.label);
    if (def.title) btn.setAttribute('title', def.title);
    // Keep native focus where it is (do NOT blur the terminal / pop the keyboard).
    this._bindActivate(btn, () => this._press(def));
    return btn;
  }

  // Fire the action on touch as well as click. Preventing default on touchstart
  // (to avoid focus theft) suppresses the emulated click on iOS WebKit, so the
  // action runs from touchend; a guard prevents a double-fire.
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
      // Ignore only the emulated click trailing a real touch (within 700ms); a
      // genuine later click (mouse / keyboard Enter) still fires the action.
      if (Date.now() - lastTouch < 700) return;
      action();
    });
  }

  _press(def) {
    const enc = this._encoder();
    if (!enc || !this.app || !this.app.send) return;
    const spec = { ctrl: !!def.ctrl, alt: !!def.alt, shift: !!def.shift };
    if (def.key) spec.key = def.key;
    else if (def.char != null) spec.char = def.char;
    else return;
    const bytes = enc.encode(spec, this._terminalModes());
    if (bytes == null) return;
    if ('vibrate' in navigator) try { navigator.vibrate(8); } catch (_) {}
    this.app.send({ type: 'input', data: bytes });
    // Intentionally do NOT call terminal.focus(): Control mode is keyboard-down.
  }

  _copyScreen() {
    const TC = (typeof window !== 'undefined' && window.TerminalCopy)
      || (typeof TerminalCopy !== 'undefined' ? TerminalCopy : null); // eslint-disable-line no-undef
    const term = this.app && this.app.terminal;
    if (!TC || !term) return;
    Promise.resolve(TC.copyVisible(term)).then((res) => {
      if (window.feedback) {
        if (res && res.ok) window.feedback.success('Copied screen');
        else window.feedback.warning('Nothing to copy');
      }
    });
  }

  show() {
    if (this._open) return;
    this._open = true;
    this.panel.classList.add('keys-panel--open');
    this.backdrop.classList.add('keys-panel__backdrop--open');
    this.panel.setAttribute('aria-hidden', 'false');
    this.fab.classList.add('keys-panel-fab--active');
  }

  hide() {
    if (!this._open) return;
    this._open = false;
    this.panel.classList.remove('keys-panel--open');
    this.backdrop.classList.remove('keys-panel__backdrop--open');
    this.panel.setAttribute('aria-hidden', 'true');
    this.fab.classList.remove('keys-panel-fab--active');
  }

  toggle() {
    if (this._open) this.hide();
    else this.show();
  }

  destroy() {
    [this.fab, this.backdrop, this.panel].forEach((el) => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    this.fab = this.backdrop = this.panel = null;
  }

  get open() { return this._open; }
}

if (typeof window !== 'undefined') {
  window.KeysPanel = KeysPanel;
}

if (typeof module === 'object' && module.exports) {
  module.exports = KeysPanel;
}
