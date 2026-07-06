'use strict';

/*
 * key-encoder.js — pure, DOM-free terminal key encoder.
 *
 * Produces the correct byte sequence for a semantic key press given the current
 * terminal modes. This is the single source of truth for on-screen keys (the
 * extra-keys bar and the keys panel) so synthetic presses match what a physical
 * key would emit through xterm's own encoder.
 *
 * Mode-awareness (the reason this module exists):
 *  - Cursor keys (arrows, Home, End) are SS3-form (ESC O x) when the TUI has
 *    enabled DECCKM application-cursor mode, and CSI-form (ESC [ x) otherwise.
 *    Any modifier forces CSI with a modifier parameter (ESC [ 1 ; m x) — never SS3.
 *  - Paste is wrapped in bracketed-paste markers when bracketedPasteMode is on.
 *
 * Modifier parameter: m = 1 + shift(1) + alt(2) + ctrl(4), emitted only when m > 1.
 * See docs/specs/mobile-input.md for the full matrix; test/key-encoder.test.js
 * asserts every row in both cursor modes.
 *
 * UMD: exposes window.KeyEncoder in the browser and module.exports under Node.
 */

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined' && root) root.KeyEncoder = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  var ESC = '\x1b';

  // Cursor / navigation keys: final char, SS3-or-CSI selection by mode.
  var CURSOR = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
  // "tilde" keys: ESC [ <num> ~ , modifier inserted as ESC [ <num> ; m ~
  var TILDE = {
    insert: 2, delete: 3, pageup: 5, pagedown: 6,
    f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24,
  };
  // SS3 function keys F1-F4: ESC O <final> , modified as ESC [ 1 ; m <final>
  var SS3F = { f1: 'P', f2: 'Q', f3: 'R', f4: 'S' };

  function modParam(mods) {
    return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
  }

  function applyAlt(seq, mods) {
    return mods.alt ? ESC + seq : seq;
  }

  // Control byte for Ctrl+<char>. Returns null when the char has no control code.
  function ctrlByte(ch) {
    if (!ch || ch.length !== 1) return null;
    var code = ch.charCodeAt(0);
    if (code >= 97 && code <= 122) return String.fromCharCode(code - 96); // a-z -> 1..26
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);  // @A-Z[\]^_ -> 0..31
    if (ch === '?') return '\x7f'; // Ctrl+? -> DEL
    if (ch === ' ') return '\x00'; // Ctrl+Space -> NUL
    return null;
  }

  function encodeChar(ch, mods) {
    var out = ch;
    if (mods.ctrl) {
      var c = ctrlByte(ch);
      if (c != null) out = c;
    }
    if (mods.alt) out = ESC + out;
    return out;
  }

  function encodeCursor(final, mods, appCursor) {
    var m = modParam(mods);
    if (m > 1) return ESC + '[1;' + m + final;
    if (appCursor) return ESC + 'O' + final;
    return ESC + '[' + final;
  }

  function encodeTilde(num, mods) {
    var m = modParam(mods);
    if (m > 1) return ESC + '[' + num + ';' + m + '~';
    return ESC + '[' + num + '~';
  }

  function encodeSs3F(final, mods) {
    var m = modParam(mods);
    if (m > 1) return ESC + '[1;' + m + final;
    return ESC + 'O' + final;
  }

  /**
   * encode(spec, modes) -> byte string (or null for an unknown key).
   *   spec: { key: '<named>', ctrl, alt, shift } OR { char: '<single char>', ctrl, alt, shift }
   *   modes: { applicationCursorKeys?: bool }
   */
  function encode(spec, modes) {
    if (!spec) return null;
    modes = modes || {};
    var appCursor = !!modes.applicationCursorKeys;
    var mods = { ctrl: !!spec.ctrl, alt: !!spec.alt, shift: !!spec.shift };

    if (spec.char != null && String(spec.char).length) {
      return encodeChar(String(spec.char), mods);
    }

    if (!spec.key) return null;
    var key = String(spec.key).toLowerCase();

    if (CURSOR[key]) return encodeCursor(CURSOR[key], mods, appCursor);
    if (TILDE[key] != null) return encodeTilde(TILDE[key], mods);
    if (SS3F[key]) return encodeSs3F(SS3F[key], mods);

    switch (key) {
      case 'tab':
        if (mods.shift) return ESC + '[Z';
        return applyAlt('\t', mods);
      case 'esc':
      case 'escape':
        return applyAlt(ESC, mods);
      case 'enter':
      case 'return':
        return applyAlt('\r', mods);
      case 'backspace':
        return applyAlt('\x7f', mods);
      case 'space':
        return encodeChar(' ', mods);
      default:
        return null;
    }
  }

  /** Wrap pasted text in bracketed-paste markers when the mode is active. */
  function wrapPaste(text, modes) {
    if (modes && modes.bracketedPaste) return ESC + '[200~' + text + ESC + '[201~';
    return text;
  }

  return { encode: encode, wrapPaste: wrapPaste, ctrlByte: ctrlByte, modParam: modParam };
});
