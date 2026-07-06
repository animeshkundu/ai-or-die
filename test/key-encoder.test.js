'use strict';

// test/key-encoder.test.js — exhaustive byte-level tests for the mode-aware
// terminal key encoder (src/public/key-encoder.js). This is the executable
// source of truth for the key matrix in docs/specs/mobile-input.md.
//
// The encoder is pure and DOM-free, so it loads via require() with no jsdom.

const assert = require('assert');
const KeyEncoder = require('../src/public/key-encoder');

const NORMAL = { applicationCursorKeys: false };
const APPCURSOR = { applicationCursorKeys: true };

function enc(spec, modes) {
  return KeyEncoder.encode(spec, modes);
}

describe('key-encoder: cursor keys (mode-aware)', function () {
  it('emits CSI form in normal mode', function () {
    assert.strictEqual(enc({ key: 'up' }, NORMAL), '\x1b[A');
    assert.strictEqual(enc({ key: 'down' }, NORMAL), '\x1b[B');
    assert.strictEqual(enc({ key: 'right' }, NORMAL), '\x1b[C');
    assert.strictEqual(enc({ key: 'left' }, NORMAL), '\x1b[D');
    assert.strictEqual(enc({ key: 'home' }, NORMAL), '\x1b[H');
    assert.strictEqual(enc({ key: 'end' }, NORMAL), '\x1b[F');
  });

  it('emits SS3 form in application-cursor mode', function () {
    assert.strictEqual(enc({ key: 'up' }, APPCURSOR), '\x1bOA');
    assert.strictEqual(enc({ key: 'down' }, APPCURSOR), '\x1bOB');
    assert.strictEqual(enc({ key: 'right' }, APPCURSOR), '\x1bOC');
    assert.strictEqual(enc({ key: 'left' }, APPCURSOR), '\x1bOD');
    assert.strictEqual(enc({ key: 'home' }, APPCURSOR), '\x1bOH');
    assert.strictEqual(enc({ key: 'end' }, APPCURSOR), '\x1bOF');
  });

  it('forces CSI with a modifier param even in application-cursor mode', function () {
    // Any modifier => never SS3.
    assert.strictEqual(enc({ key: 'left', ctrl: true }, APPCURSOR), '\x1b[1;5D');
    assert.strictEqual(enc({ key: 'left', ctrl: true }, NORMAL), '\x1b[1;5D');
    assert.strictEqual(enc({ key: 'up', shift: true }, APPCURSOR), '\x1b[1;2A');
    assert.strictEqual(enc({ key: 'right', alt: true }, NORMAL), '\x1b[1;3C');
    // ctrl+shift = 1 + 1 + 4 = 6
    assert.strictEqual(enc({ key: 'end', ctrl: true, shift: true }, NORMAL), '\x1b[1;6F');
  });
});

describe('key-encoder: tilde keys', function () {
  it('emits base sequences', function () {
    assert.strictEqual(enc({ key: 'insert' }, NORMAL), '\x1b[2~');
    assert.strictEqual(enc({ key: 'delete' }, NORMAL), '\x1b[3~');
    assert.strictEqual(enc({ key: 'pageup' }, NORMAL), '\x1b[5~');
    assert.strictEqual(enc({ key: 'pagedown' }, NORMAL), '\x1b[6~');
  });

  it('is unaffected by application-cursor mode', function () {
    assert.strictEqual(enc({ key: 'delete' }, APPCURSOR), '\x1b[3~');
    assert.strictEqual(enc({ key: 'pageup' }, APPCURSOR), '\x1b[5~');
  });

  it('inserts the modifier param before the tilde', function () {
    assert.strictEqual(enc({ key: 'delete', ctrl: true }, NORMAL), '\x1b[3;5~');
    assert.strictEqual(enc({ key: 'pageup', shift: true }, NORMAL), '\x1b[5;2~');
  });
});

describe('key-encoder: function keys', function () {
  it('emits SS3 for F1-F4', function () {
    assert.strictEqual(enc({ key: 'f1' }, NORMAL), '\x1bOP');
    assert.strictEqual(enc({ key: 'f2' }, NORMAL), '\x1bOQ');
    assert.strictEqual(enc({ key: 'f3' }, NORMAL), '\x1bOR');
    assert.strictEqual(enc({ key: 'f4' }, NORMAL), '\x1bOS');
  });

  it('emits CSI-tilde for F5-F12', function () {
    assert.strictEqual(enc({ key: 'f5' }, NORMAL), '\x1b[15~');
    assert.strictEqual(enc({ key: 'f6' }, NORMAL), '\x1b[17~');
    assert.strictEqual(enc({ key: 'f7' }, NORMAL), '\x1b[18~');
    assert.strictEqual(enc({ key: 'f8' }, NORMAL), '\x1b[19~');
    assert.strictEqual(enc({ key: 'f9' }, NORMAL), '\x1b[20~');
    assert.strictEqual(enc({ key: 'f10' }, NORMAL), '\x1b[21~');
    assert.strictEqual(enc({ key: 'f11' }, NORMAL), '\x1b[23~');
    assert.strictEqual(enc({ key: 'f12' }, NORMAL), '\x1b[24~');
  });

  it('applies modifier params to function keys', function () {
    assert.strictEqual(enc({ key: 'f1', shift: true }, NORMAL), '\x1b[1;2P');
    assert.strictEqual(enc({ key: 'f5', ctrl: true }, NORMAL), '\x1b[15;5~');
  });
});

describe('key-encoder: tab / esc / enter / backspace', function () {
  it('Tab and Shift+Tab', function () {
    assert.strictEqual(enc({ key: 'tab' }, NORMAL), '\t');
    assert.strictEqual(enc({ key: 'tab', shift: true }, NORMAL), '\x1b[Z');
  });

  it('Esc, Enter, Backspace', function () {
    assert.strictEqual(enc({ key: 'escape' }, NORMAL), '\x1b');
    assert.strictEqual(enc({ key: 'enter' }, NORMAL), '\r');
    assert.strictEqual(enc({ key: 'backspace' }, NORMAL), '\x7f');
  });

  it('Alt prepends ESC on raw keys', function () {
    assert.strictEqual(enc({ key: 'enter', alt: true }, NORMAL), '\x1b\r');
    assert.strictEqual(enc({ key: 'escape', alt: true }, NORMAL), '\x1b\x1b');
  });
});

describe('key-encoder: character + Ctrl/Alt', function () {
  it('passes printable characters through', function () {
    assert.strictEqual(enc({ char: 'c' }, NORMAL), 'c');
    assert.strictEqual(enc({ char: '/' }, NORMAL), '/');
    assert.strictEqual(enc({ char: '@' }, NORMAL), '@');
  });

  it('maps Ctrl+letter to control codes', function () {
    assert.strictEqual(enc({ char: 'c', ctrl: true }, NORMAL), '\x03'); // Ctrl+C
    assert.strictEqual(enc({ char: 'C', ctrl: true }, NORMAL), '\x03');
    assert.strictEqual(enc({ char: 'r', ctrl: true }, NORMAL), '\x12'); // Ctrl+R
    assert.strictEqual(enc({ char: 'd', ctrl: true }, NORMAL), '\x04'); // Ctrl+D
    assert.strictEqual(enc({ char: 'z', ctrl: true }, NORMAL), '\x1a'); // Ctrl+Z
    assert.strictEqual(enc({ char: 'l', ctrl: true }, NORMAL), '\x0c'); // Ctrl+L
    assert.strictEqual(enc({ char: 'u', ctrl: true }, NORMAL), '\x15'); // Ctrl+U
    assert.strictEqual(enc({ char: 'a', ctrl: true }, NORMAL), '\x01'); // Ctrl+A
    assert.strictEqual(enc({ char: 'e', ctrl: true }, NORMAL), '\x05'); // Ctrl+E
    assert.strictEqual(enc({ char: 'k', ctrl: true }, NORMAL), '\x0b'); // Ctrl+K
    assert.strictEqual(enc({ char: 'w', ctrl: true }, NORMAL), '\x17'); // Ctrl+W
  });

  it('maps Ctrl+symbol control codes', function () {
    assert.strictEqual(enc({ char: '[', ctrl: true }, NORMAL), '\x1b'); // Ctrl+[ = ESC
    assert.strictEqual(enc({ char: '\\', ctrl: true }, NORMAL), '\x1c');
    assert.strictEqual(enc({ char: ']', ctrl: true }, NORMAL), '\x1d');
    assert.strictEqual(enc({ char: '_', ctrl: true }, NORMAL), '\x1f');
    assert.strictEqual(enc({ char: '@', ctrl: true }, NORMAL), '\x00'); // Ctrl+@ = NUL
    assert.strictEqual(enc({ char: ' ', ctrl: true }, NORMAL), '\x00'); // Ctrl+Space = NUL
    assert.strictEqual(enc({ char: '?', ctrl: true }, NORMAL), '\x7f'); // Ctrl+? = DEL
  });

  it('maps Alt+char (readline word ops) to ESC+char', function () {
    assert.strictEqual(enc({ char: 'b', alt: true }, NORMAL), '\x1bb'); // Alt+B word-back
    assert.strictEqual(enc({ char: 'f', alt: true }, NORMAL), '\x1bf'); // Alt+F word-forward
    assert.strictEqual(enc({ char: 'd', alt: true }, NORMAL), '\x1bd'); // Alt+D delete-word
  });

  it('leaves a non-control char unchanged under Ctrl', function () {
    // '5' has no control code; should pass through.
    assert.strictEqual(enc({ char: '5', ctrl: true }, NORMAL), '5');
  });
});

describe('key-encoder: bracketed paste', function () {
  it('wraps when bracketedPaste is on', function () {
    assert.strictEqual(
      KeyEncoder.wrapPaste('hi\nthere', { bracketedPaste: true }),
      '\x1b[200~hi\nthere\x1b[201~'
    );
  });
  it('passes through when off', function () {
    assert.strictEqual(KeyEncoder.wrapPaste('hi', { bracketedPaste: false }), 'hi');
    assert.strictEqual(KeyEncoder.wrapPaste('hi', undefined), 'hi');
  });
});

describe('key-encoder: unknown keys', function () {
  it('returns null for unknown key ids and empty specs', function () {
    assert.strictEqual(enc({ key: 'nope' }, NORMAL), null);
    assert.strictEqual(enc({}, NORMAL), null);
    assert.strictEqual(enc(null, NORMAL), null);
  });
});
