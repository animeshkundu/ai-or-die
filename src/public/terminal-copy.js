'use strict';

// terminal-copy.js — extract text from the xterm buffer for copying on mobile.
//
// The mobile terminal uses the Canvas renderer, where long-press text selection
// is unavailable. This lets a user lift the visible screen (an error line, a
// path) onto the clipboard to paste into the composer. getVisibleText is pure
// and unit-tested; copyVisible performs the clipboard write.
// See docs/specs/mobile-input.md, ADR-0037.

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined' && root) root.TerminalCopy = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  // Return the text of the currently visible rows of an xterm terminal, with
  // trailing blank lines trimmed. Safe against missing buffer APIs.
  function getVisibleText(terminal) {
    if (!terminal || !terminal.buffer || !terminal.buffer.active) return '';
    var buf = terminal.buffer.active;
    if (typeof buf.getLine !== 'function') return '';
    var rows = terminal.rows || 24;
    var start = buf.viewportY || 0;
    var lines = [];
    for (var i = 0; i < rows; i++) {
      var line = buf.getLine(start + i);
      var text = (line && typeof line.translateToString === 'function')
        ? line.translateToString(true) : '';
      lines.push(text);
    }
    // Trim trailing empty lines but keep internal blank lines.
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('\n');
  }

  // Return the current selection if any, else the visible screen text.
  function getSelectionOrVisible(terminal) {
    var sel = terminal && typeof terminal.getSelection === 'function' ? terminal.getSelection() : '';
    if (sel) return { text: sel, source: 'selection' };
    return { text: getVisibleText(terminal), source: 'screen' };
  }

  // Copy the selection-or-visible text to the clipboard. Returns a promise that
  // resolves to { ok, source } or { ok:false }.
  function copyVisible(terminal, nav) {
    var n = nav || (typeof navigator !== 'undefined' ? navigator : null);
    var picked = getSelectionOrVisible(terminal);
    if (!picked.text) return Promise.resolve({ ok: false });
    if (!n || !n.clipboard || !n.clipboard.writeText) return Promise.resolve({ ok: false });
    return n.clipboard.writeText(picked.text)
      .then(function () { return { ok: true, source: picked.source }; })
      .catch(function () { return { ok: false }; });
  }

  return { getVisibleText: getVisibleText, getSelectionOrVisible: getSelectionOrVisible, copyVisible: copyVisible };
});
