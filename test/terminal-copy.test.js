'use strict';

// test/terminal-copy.test.js — pure buffer-text extraction for mobile copy.

const assert = require('assert');
const TerminalCopy = require('../src/public/terminal-copy');

// Minimal fake xterm terminal: a buffer of lines with translateToString.
function fakeTerminal(lines, opts) {
  opts = opts || {};
  return {
    rows: opts.rows != null ? opts.rows : lines.length,
    getSelection: () => opts.selection || '',
    buffer: {
      active: {
        viewportY: opts.viewportY || 0,
        getLine: (y) => {
          const s = lines[y];
          if (s == null) return null;
          return { translateToString: (_trim) => s };
        },
      },
    },
  };
}

describe('terminal-copy: getVisibleText', function () {
  it('joins the visible rows and trims trailing blank lines', function () {
    const term = fakeTerminal(['error: boom', '  at foo.js:12', '', ''], { rows: 4 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'error: boom\n  at foo.js:12');
  });

  it('respects viewportY (scrollback offset)', function () {
    const term = fakeTerminal(['top0', 'top1', 'a', 'b'], { rows: 2, viewportY: 2 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'a\nb');
  });

  it('returns empty string when buffer is unavailable', function () {
    assert.strictEqual(TerminalCopy.getVisibleText(null), '');
    assert.strictEqual(TerminalCopy.getVisibleText({}), '');
  });
});

describe('terminal-copy: getSelectionOrVisible', function () {
  it('prefers a live selection', function () {
    const term = fakeTerminal(['x', 'y'], { selection: 'picked' });
    assert.deepStrictEqual(TerminalCopy.getSelectionOrVisible(term), { text: 'picked', source: 'selection' });
  });
  it('falls back to the visible screen', function () {
    const term = fakeTerminal(['line'], { rows: 1 });
    assert.deepStrictEqual(TerminalCopy.getSelectionOrVisible(term), { text: 'line', source: 'screen' });
  });
});

describe('terminal-copy: copyVisible', function () {
  it('writes to the clipboard and reports the source', async function () {
    let written = null;
    const nav = { clipboard: { writeText: async (t) => { written = t; } } };
    const term = fakeTerminal(['hello'], { rows: 1 });
    const res = await TerminalCopy.copyVisible(term, nav);
    assert.deepStrictEqual(res, { ok: true, source: 'screen' });
    assert.strictEqual(written, 'hello');
  });

  it('reports failure when nothing to copy', async function () {
    const nav = { clipboard: { writeText: async () => {} } };
    const term = fakeTerminal([''], { rows: 1 });
    const res = await TerminalCopy.copyVisible(term, nav);
    assert.deepStrictEqual(res, { ok: false });
  });

  it('reports failure when clipboard is unavailable', async function () {
    const term = fakeTerminal(['hello'], { rows: 1 });
    const res = await TerminalCopy.copyVisible(term, {});
    assert.deepStrictEqual(res, { ok: false });
  });
});
