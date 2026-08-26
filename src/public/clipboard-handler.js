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
 * Present a canonical terminal-copy result without making the copy utility
 * depend on the application's feedback/UI implementation.
 * @param {{ok: boolean, source?: string, reason?: string}} result
 * @param {{success?: function(string): void, warning?: function(string): void, error?: function(string): void}} feedback
 * @param {{success?: function(): void, denied?: function(string): void, empty?: function(): void}} [hooks]
 */
function presentCopyResult(result, feedback, hooks) {
  hooks = hooks || {};
  if (result && result.ok) {
    if (typeof hooks.success === 'function') {
      hooks.success(result.source);
    } else if (feedback && typeof feedback.success === 'function') {
      feedback.success(result.source === 'screen' ? 'Copied screen' : 'Copied');
    } else {
      showCopiedToast();
    }
    return;
  }
  var reason = result && result.reason;
  if (reason === 'empty') {
    if (typeof hooks.empty === 'function') hooks.empty();
    else if (feedback && typeof feedback.warning === 'function') feedback.warning('Nothing to copy');
    return;
  }
  var message = reason === 'error'
    ? 'Unable to read terminal output'
    : 'Clipboard access denied';
  if (typeof hooks.denied === 'function') hooks.denied(reason);
  else if (feedback && typeof feedback.warning === 'function') feedback.warning(message);
  else if (typeof window !== 'undefined' && typeof window.showClipboardError === 'function') {
    window.showClipboardError(message);
  }
}

function copyResultPresenter(result, feedback, hooks) {
  return presentCopyResult(result, feedback, hooks);
}

// Small fallback for pages where terminal-copy.js is unavailable. The normal
// path uses TerminalCopy.copySelection, but keyboard copy must remain safe when
// scripts load out of order or a browser has a partial Clipboard API.
function writeSelectedText(text, nav) {
  if (!text) return Promise.resolve({ ok: false, reason: 'empty' });
  if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') {
    return Promise.resolve({ ok: false, reason: 'unavailable' });
  }
  try {
    var pending = nav.clipboard.writeText(text);
    return pending && typeof pending.then === 'function'
      ? pending.then(function () { return { ok: true, source: 'selection' }; })
        .catch(function () { return { ok: false, reason: 'denied' }; })
      : Promise.resolve({ ok: true, source: 'selection' });
  } catch (_) {
    return Promise.resolve({ ok: false, reason: 'denied' });
  }
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

    // Ctrl+C / Cmd+C: copy if selection exists, else let xterm send SIGINT.
    // Keep the copy promise in this user-gesture handler, but clear selection
    // only after a successful write so failed clipboard access is recoverable.
    if (mod && e.key === 'c' && !e.shiftKey) {
      if (terminal.hasSelection()) {
        const TC = (typeof window !== 'undefined' && window.TerminalCopy)
          || (typeof TerminalCopy !== 'undefined' ? TerminalCopy : null); // eslint-disable-line no-undef
        const nav = typeof navigator !== 'undefined' ? navigator : null;
        const copyPromise = TC && typeof TC.copySelection === 'function'
          ? TC.copySelection(terminal, nav)
          : writeSelectedText(terminal.getSelection(), nav);
        Promise.resolve(copyPromise)
          .then((result) => {
            if (result && result.ok) {
              terminal.clearSelection();
              showCopiedToast();
            } else {
              presentCopyResult(result, typeof window !== 'undefined' ? window.feedback : null);
            }
          })
          .catch(() => {
            presentCopyResult({ ok: false, reason: 'denied' },
              typeof window !== 'undefined' ? window.feedback : null);
          });
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

    // Ctrl+Shift+C: copy (Linux terminal convention). Unlike Ctrl+C, this
    // shortcut always belongs to copy and therefore is consumed with or without
    // a selection, but selection clearing still waits for write success.
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
      if (terminal.hasSelection()) {
        const TC = (typeof window !== 'undefined' && window.TerminalCopy)
          || (typeof TerminalCopy !== 'undefined' ? TerminalCopy : null); // eslint-disable-line no-undef
        const nav = typeof navigator !== 'undefined' ? navigator : null;
        const copyPromise = TC && typeof TC.copySelection === 'function'
          ? TC.copySelection(terminal, nav)
          : writeSelectedText(terminal.getSelection(), nav);
        Promise.resolve(copyPromise).then((result) => {
          if (result && result.ok) {
            terminal.clearSelection();
            showCopiedToast();
          } else {
            presentCopyResult(result, typeof window !== 'undefined' ? window.feedback : null);
          }
        }).catch(() => {
          presentCopyResult({ ok: false, reason: 'denied' },
            typeof window !== 'undefined' ? window.feedback : null);
        });
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
attachClipboardHandler.presentCopyResult = presentCopyResult;
attachClipboardHandler.copyResultPresenter = copyResultPresenter;
attachClipboardHandler.writeSelectedText = writeSelectedText;

// Browser: expose the shared presenter as well as the keyboard handler so
// every explicit copy affordance can use the same result-to-feedback mapping.
if (typeof window !== 'undefined') {
  window.attachClipboardHandler = attachClipboardHandler;
  window.presentCopyResult = presentCopyResult;
}

// Node.js: CommonJS export for unit testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    attachClipboardHandler,
    normalizeLineEndings,
    wrapBracketedPaste,
    showCopiedToast,
    presentCopyResult,
    copyResultPresenter,
    writeSelectedText,
  };
}
