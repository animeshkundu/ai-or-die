'use strict';

// InputSender — shared helpers for the terminal -> server input path.
//
// Mouse motion from xterm arrives on the same onData as keystrokes as SGR
// reports (`ESC[<Cb;Cx;CyM/m`). At drag/scroll rates (100+ events/s) each
// report must not become its own WebSocket message + geometry transaction.
// These pure functions let main + split panes share one policy:
//
//   - filterFocusBytes: strip focus-tracking sequences (main did this;
//     splits did not — parity).
//   - isPureMotion: true when a batch holds ONLY pointer-motion reports, so
//     the sender may downgrade the geometry claim (no owner flap) without
//     changing PTY byte order.
//   - compressMotion: collapse consecutive motion reports to the latest,
//     preserving every non-motion byte (button edges, keys, scroll ticks)
//     in order. Position-convergent: the TUI ends at the same cell, but
//     intermediate cells of a fast drag are intentionally not all delivered
//     (cell-paint-on-drag apps may show line gaps — accepted tradeoff for
//     the wire-rate budget; see history).
//
// NOTE: over-cap truncation lives ONLY in src/server.js
// (truncateInputAtBoundary, incl. OSC handling) — the client never
// truncates. The SGR-motion pattern is intentionally mirrored in
// src/base-bridge.js (isPureMotionInput) for the writeQueue bound; the two
// regexes must stay byte-identical (motion = Cb 32-63 + 'M').
//
// SGR button codes: 0-2 press (M), 3 release (m), 32-63 drag/motion (M),
// 64/65 wheel (M). Only 32-63+M is compressible motion; wheel ticks and
// edges are discrete actions and are always preserved.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InputSender = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const FOCUS_RE = /\x1b\[\[?[IO]/g;
  // One SGR mouse report: ESC [ < Cb ; Cx ; Cy M|m
  const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  const MOTION_ONLY_RE = /^(?:\x1b\[<(?:3[2-9]|[4-5][0-9]|6[0-3]);\d+;\d+M)+$/;

  function filterFocusBytes(data) {
    if (typeof data !== 'string' || !data) return data;
    return data.replace(FOCUS_RE, '');
  }

  function isMotionCode(cb, suffix) {
    const n = Number(cb);
    return suffix === 'M' && n >= 32 && n <= 63;
  }

  function isPureMotion(text) {
    return typeof text === 'string' && text.length > 0 && MOTION_ONLY_RE.test(text);
  }

  // Collapse runs of consecutive motion reports to the latest report.
  // Any non-motion byte (keys, edges, wheel, release) flushes the pending
  // motion first, so relative order is preserved exactly.
  function compressMotion(text) {
    if (typeof text !== 'string' || !text) return text;
    SGR_RE.lastIndex = 0;
    let out = '';
    let pendingMotion = null;
    let lastIndex = 0;
    let m;
    const flush = () => {
      if (pendingMotion !== null) {
        out += pendingMotion;
        pendingMotion = null;
      }
    };
    // Reset global regex state for re-entrant safety.
    const re = new RegExp(SGR_RE.source, 'g');
    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIndex) {
        // Gap of non-SGR bytes: flush motion, keep gap verbatim.
        flush();
        out += text.slice(lastIndex, m.index);
      }
      if (isMotionCode(m[1], m[4])) {
        pendingMotion = m[0]; // supersede earlier motion in this run
      } else {
        flush();
        out += m[0];
      }
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < text.length) {
      flush();
      out += text.slice(lastIndex);
    } else {
      flush();
    }
    return out;
  }

  return { filterFocusBytes, isPureMotion, compressMotion };
});
