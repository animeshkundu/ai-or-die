'use strict';

// terminal-copy.js — canonical text extraction and clipboard operations for
// xterm terminals. This module deliberately has no UI dependencies: callers
// decide how to present the structured result to users.

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined' && root) root.TerminalCopy = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  var REASONS = Object.freeze({
    EMPTY: 'empty',
    UNAVAILABLE: 'unavailable',
    DENIED: 'denied',
    ERROR: 'error',
  });

  function failure(reason) {
    return { ok: false, reason: reason };
  }

  function success(source) {
    return { ok: true, source: source };
  }

  function numberOr(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function nonNegativeInteger(value, fallback) {
    return Math.max(0, Math.floor(numberOr(value, fallback)));
  }

  function activeBufferOrThrow(terminal) {
    var buffer = terminal && terminal.buffer && terminal.buffer.active;
    if (!buffer || typeof buffer.getLine !== 'function') {
      throw new Error('Active terminal buffer is unavailable');
    }
    return buffer;
  }

  function rowText(line) {
    if (!line) return '';
    if (typeof line.translateToString !== 'function') {
      throw new Error('Terminal buffer line cannot be translated to text');
    }
    // `true` removes null-cell padding while preserving meaningful printed
    // spaces. Wrapped rows are joined separately below, so padding must not
    // become part of the copied logical line.
    var text = line.translateToString(true);
    if (typeof text !== 'string') {
      throw new Error('Terminal buffer line returned non-string text');
    }
    return text;
  }

  // Reconstruct logical lines from physical xterm rows. Continuation rows are
  // marked by BufferLine.isWrapped and must be concatenated without a newline.
  // `translateToString(false)` preserves the padding needed to rejoin a wrapped
  // row exactly; normal rows use `true` to omit terminal padding.
  function extractRows(buffer, start, count) {
    var logicalLines = [];
    var current = null;

    for (var offset = 0; offset < count; offset++) {
      var line = buffer.getLine(start + offset);
      var text = rowText(line);

      if (line && line.isWrapped) {
        // A viewport may begin in the middle of a wrapped line. Treat that
        // visible fragment as the start of the first logical line.
        current = current === null ? text : current + text;
      } else {
        if (current !== null) logicalLines.push(current);
        current = text;
      }
    }
    if (current !== null) logicalLines.push(current);

    // Blank rows at the bottom are viewport padding. Internal blank rows and
    // all leading whitespace are meaningful and remain untouched.
    while (logicalLines.length && logicalLines[logicalLines.length - 1].trim() === '') {
      logicalLines.pop();
    }
    return logicalLines.join('\n');
  }

  function visibleRows(terminal) {
    var rows = nonNegativeInteger(terminal && terminal.rows, 24);
    return rows || 24;
  }

  function extractVisibleText(terminal) {
    var buffer = activeBufferOrThrow(terminal);
    var start = nonNegativeInteger(buffer.viewportY, 0);
    return extractRows(buffer, start, visibleRows(terminal));
  }

  function extractBufferText(terminal) {
    var buffer = activeBufferOrThrow(terminal);
    var length = numberOr(buffer.length, NaN);
    if (!Number.isFinite(length) || length < 0) {
      throw new Error('Active terminal buffer length is unavailable');
    }
    return extractRows(buffer, 0, Math.floor(length));
  }

  // Safe text-only accessors are useful to callers that want to inspect a
  // terminal without surfacing an exception. Copy operations below retain the
  // distinction between extraction failure and valid empty output.
  function getVisibleText(terminal) {
    try {
      return extractVisibleText(terminal);
    } catch (_) {
      return '';
    }
  }

  function getBufferText(terminal) {
    try {
      return extractBufferText(terminal);
    } catch (_) {
      return '';
    }
  }

  function readSelection(terminal) {
    if (!terminal || typeof terminal.getSelection !== 'function') return '';
    var selection = terminal.getSelection();
    return typeof selection === 'string' ? selection : '';
  }

  function getSelection(terminal) {
    try {
      return readSelection(terminal);
    } catch (_) {
      return '';
    }
  }

  function getSelectionOrVisible(terminal) {
    var selection = '';
    try {
      // A missing selection API means there is simply no selection. A present
      // API that throws is treated the same way for this text-only accessor;
      // copyVisible still reports extraction errors from malformed terminals.
      if (terminal && typeof terminal.getSelection === 'function') {
        selection = readSelection(terminal);
      }
    } catch (_) {
      selection = '';
    }
    // Do not trim: a whitespace-only selection is still user-selected.
    if (selection.length > 0) return { text: selection, source: 'selection' };
    try {
      return { text: extractVisibleText(terminal), source: 'screen' };
    } catch (_) {
      return { text: '', source: 'screen' };
    }
  }

  function getNavigator(nav) {
    // `undefined` means use the browser global; null is an intentional
    // injection used by callers/tests to represent an unavailable clipboard.
    if (typeof nav !== 'undefined') return nav;
    return typeof navigator !== 'undefined' ? navigator : null;
  }

  // Handle both browser Promise-returning Clipboard APIs and synchronous test
  // doubles. Synchronous throws and rejected writes are expected failures.
  async function writeText(text, source, nav) {
    var n = getNavigator(nav);
    if (!n || !n.clipboard || typeof n.clipboard.writeText !== 'function') {
      return failure(REASONS.UNAVAILABLE);
    }
    try {
      var pending = n.clipboard.writeText(text);
      if (pending && typeof pending.then === 'function') await pending;
      return success(source);
    } catch (_) {
      return failure(REASONS.DENIED);
    }
  }

  function copyPicked(picked, nav) {
    if (!picked.text) return Promise.resolve(failure(REASONS.EMPTY));
    return writeText(picked.text, picked.source, nav);
  }

  // Copy the current selection, or the visible active buffer when there is no
  // selection. This is the explicit copy affordance used by menus and mobile.
  async function copyVisible(terminal, nav) {
    try {
      var selection = '';
      if (terminal && typeof terminal.getSelection === 'function') {
        selection = readSelection(terminal);
      }
      var picked = selection.length > 0
        ? { text: selection, source: 'selection' }
        : { text: extractVisibleText(terminal), source: 'screen' };
      return await copyPicked(picked, nav);
    } catch (_) {
      return failure(REASONS.ERROR);
    }
  }

  // Copy only an existing selection. Keyboard Ctrl/Cmd+C uses this operation
  // so a missing selection can continue through xterm as SIGINT.
  async function copySelection(terminal, nav) {
    try {
      return await copyPicked({ text: readSelection(terminal), source: 'selection' }, nav);
    } catch (_) {
      return failure(REASONS.ERROR);
    }
  }

  // Copy the complete active buffer, including scrollback. Source `buffer`
  // distinguishes this from visible-screen and selection copy.
  async function copyBuffer(terminal, nav) {
    try {
      return await copyPicked({ text: extractBufferText(terminal), source: 'buffer' }, nav);
    } catch (_) {
      return failure(REASONS.ERROR);
    }
  }

  return {
    REASONS: REASONS,
    REASON_EMPTY: REASONS.EMPTY,
    REASON_UNAVAILABLE: REASONS.UNAVAILABLE,
    REASON_DENIED: REASONS.DENIED,
    REASON_ERROR: REASONS.ERROR,
    getVisibleText: getVisibleText,
    getBufferText: getBufferText,
    getFullBufferText: getBufferText,
    getSelection: getSelection,
    getSelectionOrVisible: getSelectionOrVisible,
    copyVisible: copyVisible,
    copySelection: copySelection,
    copyBuffer: copyBuffer,
  };
});
