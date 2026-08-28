'use strict';

// terminal-copy.js unit coverage: logical xterm rows, result reasons, and
// non-mutating clipboard operations.
const assert = require('assert');
const TerminalCopy = require('../src/public/terminal-copy');

function fakeTerminal(lines, opts) {
  opts = opts || {};
  const physicalLines = lines.map((line) => {
    if (line == null) return null;
    if (typeof line === 'string') return { text: line, isWrapped: false };
    return {
      text: line.text || '',
      isWrapped: !!line.isWrapped,
      padding: line.padding || '',
    };
  });
  return {
    rows: opts.rows != null ? opts.rows : lines.length,
    getSelection: () => opts.selection != null ? opts.selection : '',
    buffer: {
      active: {
        viewportY: opts.viewportY || 0,
        length: opts.length != null ? opts.length : physicalLines.length,
        getLine: (y) => {
          const line = physicalLines[y];
          if (line == null) return null;
          return {
            isWrapped: line.isWrapped,
            translateToString: (trim) => trim ? line.text : line.text + (line.padding || ''),
          };
        },
      },
    },
  };
}


describe('terminal-copy: visible extraction', function () {
  it('joins visible rows and trims trailing blank logical rows', function () {
    const term = fakeTerminal(['error: boom', '  at foo.js:12', '', ''], { rows: 4 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'error: boom\n  at foo.js:12');
  });

  it('reconstructs wrapped physical rows without a newline', function () {
    const term = fakeTerminal([
      { text: 'foo', isWrapped: false },
      { text: 'bar', isWrapped: true },
      { text: 'next', isWrapped: false },
    ], { rows: 3 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'foobar\nnext');
  });

  it('uses trimmed translation for every physical row', function () {
    const calls = [];
    const term = fakeTerminal([
      { text: 'normal', isWrapped: false },
      { text: 'wrapped', isWrapped: true },
    ], { rows: 2 });
    const originalGetLine = term.buffer.active.getLine;
    term.buffer.active.getLine = (y) => {
      const line = originalGetLine(y);
      const originalTranslate = line.translateToString;
      line.translateToString = (trim) => {
        calls.push(trim);
        return originalTranslate(trim);
      };
      return line;
    };
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'normalwrapped');
    assert.deepStrictEqual(calls, [true, true]);
  });

  it('preserves a meaningful space before a wrapped continuation', function () {
    const term = fakeTerminal([
      { text: 'word ', isWrapped: false, padding: '   ' },
      { text: 'continuation', isWrapped: true, padding: ' ' },
    ], { rows: 2 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'word continuation');
  });

  it('joins a short wrapped row without null-cell padding', function () {
    const term = fakeTerminal([
      { text: 'head', isWrapped: false },
      { text: 'tail', isWrapped: true, padding: '      ' },
      'next',
    ], { rows: 3 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'headtail\nnext');
  });

  it('preserves meaningful printed spaces before a wrapped boundary', function () {
    const term = fakeTerminal([
      { text: 'head ', isWrapped: false },
      { text: 'tail', isWrapped: true, padding: '      ' },
      'next',
    ], { rows: 3 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'head tail\nnext');
  });

  it('reconstructs consecutive wrapped rows', function () {
    const term = fakeTerminal([
      { text: 'one', isWrapped: false },
      { text: 'two', isWrapped: true },
      { text: 'three', isWrapped: true },
      { text: 'four', isWrapped: false },
    ], { rows: 4 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'onetwothree\nfour');
  });

  it('starts a viewport in the middle of a wrapped logical line', function () {
    const term = fakeTerminal([
      { text: 'hidden', isWrapped: false },
      { text: 'fragment', isWrapped: true },
      { text: 'tail', isWrapped: true },
      { text: 'next', isWrapped: false },
    ], { rows: 3, viewportY: 1 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'fragmenttail\nnext');
  });

  it('preserves internal blank rows and trims trailing blank rows', function () {
    const term = fakeTerminal(['first', '', 'last', '', ''], { rows: 5 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'first\n\nlast');
  });

  it('preserves ANSI sequences across wrapped rows', function () {
    const term = fakeTerminal([
      '\\x1b[31mred\\x1b[0m',
      { text: '\\x1b[1mblue\\x1b[0m', isWrapped: true },
    ], { rows: 2 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), '\\x1b[31mred\\x1b[0m\\x1b[1mblue\\x1b[0m');
  });

  it('handles missing rows as logical boundaries', function () {
    const term = fakeTerminal(['line', null, 'next'], { rows: 3 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'line\n\nnext');
  });

  it('uses the active buffer length for full-buffer reconstruction', function () {
    const term = fakeTerminal(['before', 'visible', 'after'], { rows: 1, viewportY: 1 });
    assert.strictEqual(TerminalCopy.getBufferText(term), 'before\nvisible\nafter');
  });

  it('accepts non-Promise clipboard writers', async function () {
    const result = await TerminalCopy.copyVisible(fakeTerminal(['text'], { rows: 1 }), {
      clipboard: { writeText() {} },
    });
    assert.deepStrictEqual(result, { ok: true, source: 'screen' });
  });

  it('returns an extraction error for malformed rows', async function () {
    const result = await TerminalCopy.copyVisible({
      rows: 1,
      getSelection: () => '',
      buffer: { active: { getLine: () => ({}) } },
    }, { clipboard: { writeText() {} } });
    assert.deepStrictEqual(result, { ok: false, reason: 'error' });
  });

  it('never mutates selection or viewport during copy', async function () {
    let clears = 0;
    const term = fakeTerminal(['text'], { rows: 1, viewportY: 0, selection: 'selected' });
    term.clearSelection = () => { clears++; };
    await TerminalCopy.copyVisible(term, { clipboard: { writeText() {} } });
    assert.strictEqual(clears, 0);
    assert.strictEqual(term.buffer.active.viewportY, 0);
  });

  it('reports sync and async clipboard failures', async function () {
    const term = fakeTerminal(['text'], { rows: 1 });
    assert.deepStrictEqual(await TerminalCopy.copyVisible(term, {
      clipboard: { writeText() { throw new Error('denied'); } },
    }), { ok: false, reason: 'denied' });
    assert.deepStrictEqual(await TerminalCopy.copyVisible(term, {
      clipboard: { writeText: async () => { throw new Error('denied'); } },
    }), { ok: false, reason: 'denied' });
  });

  it('starts a viewport in the middle of a wrapped logical line', function () {
    const term = fakeTerminal([
      { text: 'hidden', isWrapped: false },
      { text: 'fragment', isWrapped: true },
      { text: 'tail', isWrapped: true },
      { text: 'next', isWrapped: false },
    ], { rows: 3, viewportY: 1 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'fragmenttail\nnext');
  });

  it('preserves internal blank logical rows', function () {
    const term = fakeTerminal(['first', '', 'last', '', ''], { rows: 5 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'first\n\nlast');
  });

  it('respects viewportY and terminal.rows', function () {
    const term = fakeTerminal(['top0', 'top1', 'a', 'b', 'after'], { rows: 2, viewportY: 2 });
    assert.strictEqual(TerminalCopy.getVisibleText(term), 'a\nb');
  });

  it('returns empty text for unavailable inspection APIs', function () {
    assert.strictEqual(TerminalCopy.getVisibleText(null), '');
    assert.strictEqual(TerminalCopy.getVisibleText({}), '');
  });
});

describe('terminal-copy: selection', function () {
  it('prefers a live selection', function () {
    const term = fakeTerminal(['screen'], { selection: 'picked' });
    assert.deepStrictEqual(TerminalCopy.getSelectionOrVisible(term), {
      text: 'picked', source: 'selection',
    });
  });

  it('preserves a whitespace-only selection', function () {
    const term = fakeTerminal(['screen'], { selection: ' ' });
    assert.deepStrictEqual(TerminalCopy.getSelectionOrVisible(term), {
      text: ' ', source: 'selection',
    });
  });

  it('falls back to visible screen when selection is empty', function () {
    const term = fakeTerminal(['screen'], { rows: 1 });
    assert.deepStrictEqual(TerminalCopy.getSelectionOrVisible(term), {
      text: 'screen', source: 'screen',
    });
  });
});

describe('terminal-copy: structured clipboard results', function () {
  it('copies visible selection or screen', async function () {
    let written = null;
    const term = fakeTerminal(['screen'], { rows: 1, selection: 'picked' });
    const result = await TerminalCopy.copyVisible(term, {
      clipboard: { writeText: (text) => { written = text; } },
    });
    assert.deepStrictEqual(result, { ok: true, source: 'selection' });
    assert.strictEqual(written, 'picked');
  });

  it('reports empty content', async function () {
    const result = await TerminalCopy.copyVisible(fakeTerminal([''], { rows: 1 }), {
      clipboard: { writeText() {} },
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'empty' });
  });

  it('reports unavailable clipboard', async function () {
    const result = await TerminalCopy.copyVisible(fakeTerminal(['text'], { rows: 1 }), {});
    assert.deepStrictEqual(result, { ok: false, reason: 'unavailable' });
  });

  it('reports synchronous and asynchronous clipboard denial', async function () {
    const term = fakeTerminal(['text'], { rows: 1 });
    assert.deepStrictEqual(await TerminalCopy.copyVisible(term, {
      clipboard: { writeText() { throw new Error('denied'); } },
    }), { ok: false, reason: 'denied' });
    assert.deepStrictEqual(await TerminalCopy.copyVisible(term, {
      clipboard: { writeText: async () => { throw new Error('denied'); } },
    }), { ok: false, reason: 'denied' });
  });

  it('reports extraction errors instead of rejecting', async function () {
    const terminal = {
      rows: 1,
      getSelection: () => '',
      buffer: { active: { length: 1, getLine: () => ({}) } },
    };
    assert.deepStrictEqual(await TerminalCopy.copyVisible(terminal, {
      clipboard: { writeText() {} },
    }), { ok: false, reason: 'error' });
  });

  it('does not clear selection or change viewport', async function () {
    let clears = 0;
    const term = fakeTerminal(['visible'], { selection: 'selected', rows: 1, viewportY: 2 });
    term.clearSelection = () => { clears++; };
    await TerminalCopy.copyVisible(term, { clipboard: { writeText() {} } });
    assert.strictEqual(clears, 0);
    assert.strictEqual(term.buffer.active.viewportY, 2);
  });
});

describe('terminal-copy: selection-only operation', function () {
  it('does not fall back to the screen', async function () {
    const result = await TerminalCopy.copySelection(fakeTerminal(['screen'], { rows: 1 }), {
      clipboard: { writeText() {} },
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'empty' });
  });
});

describe('terminal-copy: full active buffer operation', function () {
  it('traverses active.length and uses source buffer', async function () {
    let written = null;
    const term = fakeTerminal(['before', 'visible', 'after'], { rows: 1, viewportY: 1 });
    const result = await TerminalCopy.copyBuffer(term, {
      clipboard: { writeText: (text) => { written = text; } },
    });
    assert.deepStrictEqual(result, { ok: true, source: 'buffer' });
    assert.strictEqual(written, 'before\nvisible\nafter');
  });

  it('reconstructs consecutive wrapped rows', function () {
    const term = fakeTerminal([
      { text: 'one', isWrapped: false },
      { text: 'two', isWrapped: true },
      { text: 'three', isWrapped: true },
      { text: 'four', isWrapped: false },
    ], { rows: 1 });
    assert.strictEqual(TerminalCopy.getBufferText(term), 'onetwothree\nfour');
  });
});

describe('terminal-copy: reason constants', function () {
  it('exposes the exact failure taxonomy', function () {
    assert.deepStrictEqual(TerminalCopy.REASONS, {
      EMPTY: 'empty', UNAVAILABLE: 'unavailable', DENIED: 'denied', ERROR: 'error',
    });
    assert.strictEqual(TerminalCopy.REASON_EMPTY, 'empty');
    assert.strictEqual(TerminalCopy.REASON_UNAVAILABLE, 'unavailable');
    assert.strictEqual(TerminalCopy.REASON_DENIED, 'denied');
    assert.strictEqual(TerminalCopy.REASON_ERROR, 'error');
  });
});
