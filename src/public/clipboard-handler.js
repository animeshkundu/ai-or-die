/**
 * Normalize line endings for terminal paste.
 * Converts Windows \r\n and Unix \n to terminal-standard \r.
 * @param {string} text - Raw clipboard text
 * @returns {string} Text with normalized line endings
 */
function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
}

/**
 * Wrap text in bracketed paste escape sequences.
 * Shell programs that support bracketed paste mode accumulate all data
 * between ESC[200~ and ESC[201~ as a single paste, rather than
 * executing each line individually.
 * @param {string} text - Text to wrap
 * @returns {string} Wrapped text
 */
function wrapBracketedPaste(text) {
  return '\x1b[200~' + text + '\x1b[201~';
}

/**
 * Show a brief "Copied" feedback indicator via inline badge callback.
 * Decoupled from DOM — app.js wires window.showCopiedFeedback to the badge.
 */
function showCopiedToast() {
  if (typeof window !== 'undefined' && window.showCopiedFeedback) {
    window.showCopiedFeedback();
  }
  // Screen reader announcement
  var sr = typeof document !== 'undefined' ? document.getElementById('srAnnounce') : null;
  if (sr) sr.textContent = 'Copied to clipboard';
}

/**
 * Attach keyboard copy/paste shortcuts to an xterm.js terminal.
 *
 * Shortcuts:
 *   Ctrl+C / Cmd+C  — copy selection (or SIGINT if no selection)
 *   Ctrl+V / Cmd+V  — paste from clipboard (native browser paste)
 *   Ctrl+Shift+C    — copy selection (Linux convention)
 *   Ctrl+Shift+V    — paste from clipboard (Linux convention)
 *
 * @param {Terminal} terminal - xterm.js Terminal instance (requires allowProposedApi: true)
 * @param {function(string): void} sendFn - Callback to send text as terminal input via WebSocket
 */
function attachClipboardHandler(terminal, sendFn) {
  if (!terminal || typeof terminal.attachCustomKeyEventHandler !== 'function') {
    console.warn('attachClipboardHandler: terminal missing or unsupported');
    return;
  }

  terminal.attachCustomKeyEventHandler((e) => {
    // Only intercept keydown, not keyup
    if (e.type !== 'keydown') return true;

    const mod = e.ctrlKey || e.metaKey;

    // Ctrl+C / Cmd+C: copy if selection exists, else let xterm send SIGINT
    if (mod && e.key === 'c' && !e.shiftKey) {
      if (terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection()).then(showCopiedToast).catch(() => {});
        terminal.clearSelection();
        return false; // prevent xterm from sending \x03
      }
      return true; // no selection — let xterm send SIGINT
    }

    // Ctrl+V / Cmd+V: let browser handle native paste
    // Returning false means xterm does NOT call preventDefault().
    // Browser fires native paste event → xterm captures it →
    // applies bracketed paste wrapping → fires onData → normal flow.
    if (mod && e.key === 'v' && !e.shiftKey) {
      return false;
    }

    // Ctrl+Shift+C: copy (Linux terminal convention)
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
      if (terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection()).then(showCopiedToast).catch(() => {});
        terminal.clearSelection();
      }
      return false;
    }

    // Ctrl+Shift+V: paste (Linux terminal convention)
    if (e.ctrlKey && e.shiftKey && e.key === 'V') {
      return false; // let browser handle native paste
    }

    return true; // all other keys — let xterm handle normally
  });
}

// Attach utility functions as static properties for use by context menu
attachClipboardHandler.normalizeLineEndings = normalizeLineEndings;
attachClipboardHandler.wrapBracketedPaste = wrapBracketedPaste;
attachClipboardHandler.showCopiedToast = showCopiedToast;

// Browser: expose on window
if (typeof window !== 'undefined') {
  window.attachClipboardHandler = attachClipboardHandler;
}

// Node.js: CommonJS export for unit testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { attachClipboardHandler, normalizeLineEndings, wrapBracketedPaste, showCopiedToast };
}
