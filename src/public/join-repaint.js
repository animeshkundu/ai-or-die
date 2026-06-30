'use strict';

/**
 * chooseJoinRepaint — decide how to repaint the shared terminal on (re)join.
 *
 * This is the crux of the #131 fix. The server may send a `renderedSnapshot`
 * (rendered PLAIN TEXT via translateToString — no cursor/SGR/scroll state) and
 * the raw `outputBuffer` (the real ANSI byte chunks). Writing the plain-text
 * snapshot under a LIVE agent TUI leaves the cursor on the wrong row and the
 * next incremental redraw collides with stale content (the garble regression).
 *
 * Rules:
 *   - LIVE session (active): replay the raw outputBuffer (real ANSI) so the
 *     live TUI redraw aligns. NEVER the plain-text snapshot. → 'buffer'
 *     (or 'clear' when the buffer is empty — a brand-new just-started session).
 *   - NON-live session (exited/idle): the plain-text snapshot is safe (nothing
 *     redraws on top) and fixes blank-on-refresh (#131's legitimate goal). →
 *     'snapshot', falling back to 'buffer' then 'clear'.
 *
 * Returns one of: 'buffer' | 'snapshot' | 'clear'.
 */
(function (global) {
  function chooseJoinRepaint(message) {
    const hasBuffer = !!(message && message.outputBuffer && message.outputBuffer.length > 0);
    const hasSnapshot = !!(message && message.renderedSnapshot);
    if (message && message.active) {
      return hasBuffer ? 'buffer' : 'clear';
    }
    if (hasSnapshot) return 'snapshot';
    if (hasBuffer) return 'buffer';
    return 'clear';
  }

  global.chooseJoinRepaint = chooseJoinRepaint;
  if (typeof module !== 'undefined' && module.exports) module.exports = { chooseJoinRepaint };
})(typeof window !== 'undefined' ? window : globalThis);
