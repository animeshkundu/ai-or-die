'use strict';

const assert = require('assert');
const {
  attachClipboardHandler,
  normalizeLineEndings,
  wrapBracketedPaste,
  presentCopyResult,
  writeSelectedText,
} = require('../src/public/clipboard-handler');

function keyEvent(overrides) {
  return Object.assign({
    type: 'keydown', ctrlKey: false, metaKey: false, shiftKey: false, key: '',
  }, overrides);
}

function fakeTerminal(selection) {
  let handler;
  let clears = 0;
  return {
    attachCustomKeyEventHandler: (fn) => { handler = fn; },
    hasSelection: () => !!selection,
    getSelection: () => selection,
    clearSelection: () => { clears++; },
    invoke: (event) => handler(event),
    get clears() { return clears; },
  };
}

describe('clipboard-handler keyboard copy', function () {
  let originalWindow;
  let originalNavigator;

  beforeEach(function () {
    originalWindow = global.window;
    originalNavigator = global.navigator;
    global.window = { feedback: { warning() {} }, showCopiedFeedback() {}, TerminalCopy: null };
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: () => Promise.resolve() } },
    });
  });

  afterEach(function () {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  });

  it('passes no-selection Ctrl+C through for SIGINT', function () {
    const terminal = fakeTerminal('');
    attachClipboardHandler(terminal, () => {});
    assert.strictEqual(terminal.invoke(keyEvent({ ctrlKey: true, key: 'c' })), true);
    assert.strictEqual(terminal.clears, 0);
  });

  it('clears selection only after async copy succeeds', async function () {
    let resolveWrite;
    global.navigator.clipboard.writeText = () => new Promise((resolve) => { resolveWrite = resolve; });
    const terminal = fakeTerminal('picked');
    attachClipboardHandler(terminal, () => {});
    assert.strictEqual(terminal.invoke(keyEvent({ ctrlKey: true, key: 'c' })), false);
    assert.strictEqual(terminal.clears, 0);
    resolveWrite();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(terminal.clears, 1);
  });

  it('retains selection after denied or unavailable clipboard access', async function () {
    for (const clipboard of [
      { writeText: () => Promise.reject(new Error('denied')) },
      {},
    ]) {
      Object.defineProperty(global, 'navigator', { configurable: true, value: { clipboard } });
      const terminal = fakeTerminal('picked');
      attachClipboardHandler(terminal, () => {});
      assert.strictEqual(terminal.invoke(keyEvent({ metaKey: true, key: 'c' })), false);
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(terminal.clears, 0);
    }
  });

  it('handles synchronous clipboard failure without throwing', async function () {
    global.navigator.clipboard.writeText = () => { throw new Error('denied'); };
    const terminal = fakeTerminal('picked');
    attachClipboardHandler(terminal, () => {});
    assert.doesNotThrow(() => terminal.invoke(keyEvent({ ctrlKey: true, key: 'c' })));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(terminal.clears, 0);
  });

  it('uses selection-only semantics for Ctrl+Shift+C', async function () {
    const terminal = fakeTerminal('picked');
    attachClipboardHandler(terminal, () => {});
    assert.strictEqual(terminal.invoke(keyEvent({ ctrlKey: true, shiftKey: true, key: 'C' })), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(terminal.clears, 1);
  });

  it('consumes Ctrl+Shift+C without selection', function () {
    const terminal = fakeTerminal('');
    attachClipboardHandler(terminal, () => {});
    assert.strictEqual(terminal.invoke(keyEvent({ ctrlKey: true, shiftKey: true, key: 'C' })), false);
  });

  it('keeps paste shortcuts available and ignores keyup', function () {
    const terminal = fakeTerminal('');
    attachClipboardHandler(terminal, () => {});
    assert.strictEqual(terminal.invoke(keyEvent({ ctrlKey: true, key: 'v' })), false);
    assert.strictEqual(terminal.invoke(keyEvent({ ctrlKey: true, shiftKey: true, key: 'V' })), false);
    assert.strictEqual(terminal.invoke(keyEvent({ type: 'keyup', ctrlKey: true, key: 'c' })), true);
  });

  it('does not clear selection before a pending write resolves', async function () {
    let resolveWrite;
    global.navigator.clipboard.writeText = () => new Promise((resolve) => { resolveWrite = resolve; });
    const terminal = fakeTerminal('picked');
    attachClipboardHandler(terminal, () => {});
    terminal.invoke(keyEvent({ ctrlKey: true, key: 'c' }));
    await Promise.resolve();
    assert.strictEqual(terminal.clears, 0);
    resolveWrite();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(terminal.clears, 1);
  });
});

describe('clipboard-handler result presentation', function () {
  it('distinguishes success, empty, unavailable, denied, and error', function () {
    const calls = [];
    const feedback = {
      success: (message) => calls.push(['success', message]),
      warning: (message) => calls.push(['warning', message]),
    };
    presentCopyResult({ ok: true, source: 'screen' }, feedback);
    presentCopyResult({ ok: false, reason: 'empty' }, feedback);
    presentCopyResult({ ok: false, reason: 'unavailable' }, feedback);
    presentCopyResult({ ok: false, reason: 'denied' }, feedback);
    presentCopyResult({ ok: false, reason: 'error' }, feedback);
    assert.deepStrictEqual(calls, [
      ['success', 'Copied screen'],
      ['warning', 'Nothing to copy'],
      ['warning', 'Clipboard access denied'],
      ['warning', 'Clipboard access denied'],
      ['warning', 'Unable to read terminal output'],
    ]);
  });
});

describe('clipboard-handler safe writer', function () {
  it('handles synchronous success and failure', async function () {
    assert.deepStrictEqual(await writeSelectedText('x', { clipboard: { writeText: () => {} } }),
      { ok: true, source: 'selection' });
    assert.deepStrictEqual(await writeSelectedText('x', {
      clipboard: { writeText: () => { throw new Error('no'); } },
    }), { ok: false, reason: 'denied' });
  });
});

describe('clipboard-handler pure functions', function () {
  describe('normalizeLineEndings', function () {
    it('converts CRLF to CR', function () {
      assert.strictEqual(normalizeLineEndings('line1\r\nline2\r\n'), 'line1\rline2\r');
    });

    it('converts LF to CR', function () {
      assert.strictEqual(normalizeLineEndings('line1\nline2\n'), 'line1\rline2\r');
    });

    it('leaves CR unchanged', function () {
      assert.strictEqual(normalizeLineEndings('line1\rline2\r'), 'line1\rline2\r');
    });

    it('handles mixed endings, empty text, and plain text', function () {
      assert.strictEqual(normalizeLineEndings('a\r\nb\nc\r'), 'a\rb\rc\r');
      assert.strictEqual(normalizeLineEndings(''), '');
      assert.strictEqual(normalizeLineEndings('hello world'), 'hello world');
    });
  });

  describe('wrapBracketedPaste', function () {
    it('wraps text with bracketed-paste markers', function () {
      assert.strictEqual(wrapBracketedPaste('hello'), '\x1b[200~hello\x1b[201~');
      assert.strictEqual(wrapBracketedPaste(''), '\x1b[200~\x1b[201~');
    });

    it('preserves existing escape sequences', function () {
      const text = '\x1b[31mred\x1b[0m';
      assert.strictEqual(wrapBracketedPaste(text), '\x1b[200~\x1b[31mred\x1b[0m\x1b[201~');
    });
  });
});
