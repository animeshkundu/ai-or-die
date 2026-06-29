'use strict';

// Per-session transcript buffer backed by a headless xterm terminal.
//
// Raw PTY output is a stream of terminal *rendering instructions* — carriage
// returns, cursor moves, spinners, alternate-screen redraws. Feeding the raw
// bytes (even after a regex ANSI strip) to a summarizer produces garbage: a
// spinner that rewrites one line 50 times becomes 50 copies of that line.
//
// Instead we replay the bytes through @xterm/headless, which maintains the
// real screen + scrollback exactly as the user sees it, and read back the
// *rendered* recent lines. This also transparently handles multi-byte UTF-8
// sequences that arrive split across PTY chunks.

const { Terminal } = require('@xterm/headless');

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_SCROLLBACK = 500;
const DEFAULT_MAX_DELTA_LINES = 80;

class TranscriptBuffer {
  constructor(options = {}) {
    this._maxDeltaLines = options.maxDeltaLines || DEFAULT_MAX_DELTA_LINES;
    this._term = new Terminal({
      cols: options.cols || DEFAULT_COLS,
      rows: options.rows || DEFAULT_ROWS,
      scrollback: options.scrollback || DEFAULT_SCROLLBACK,
      allowProposedApi: true,
    });

    // onLineFeed fires once per actual line feed (LF). Carriage-return-only
    // redraws (spinners, progress bars) do NOT fire it, so this is a clean
    // monotonic count of committed lines — exactly the signal the volume
    // trigger wants, immune to spinner churn.
    this._linesProduced = 0;
    this._consumedLines = 0;
    this._dirty = false;
    this._term.onLineFeed(() => {
      this._linesProduced++;
    });
  }

  /** Feed a chunk of raw PTY output. Non-blocking (xterm parses async). */
  write(data) {
    if (!data || !data.length) return;
    this._dirty = true;
    this._term.write(data);
  }

  /** Match the headless terminal width to the live PTY so wrapping agrees. */
  resize(cols, rows) {
    if (cols > 0 && rows > 0) this._term.resize(cols, rows);
  }

  /** Any output written since the last snapshot()? (gate for "new output"). */
  hasNew() {
    return this._dirty;
  }

  /** Committed lines (LFs) since the last snapshot() — drives the volume trigger. */
  newLineCount() {
    return this._linesProduced - this._consumedLines;
  }

  /**
   * Drain pending writes, then return the last `maxLines` rendered, non-empty
   * trailing lines as plain text. Resets the new-output counters.
   * @param {number} [maxLines]
   * @returns {Promise<string>}
   */
  async snapshot(maxLines) {
    const limit = maxLines || this._maxDeltaLines;
    await this._drain();

    const buf = this._term.buffer.active;
    const cursorRow = buf.baseY + buf.cursorY; // absolute buffer row of the cursor

    const rowText = (i) => {
      const line = buf.getLine(i);
      return line ? line.translateToString(true) : '';
    };

    // Walk up from the cursor to the last non-empty rendered row, so a trailing
    // blank cursor line (or several) doesn't eat into the window.
    let lastNonEmpty = cursorRow;
    while (lastNonEmpty >= 0 && rowText(lastNonEmpty) === '') lastNonEmpty--;

    let result = '';
    if (lastNonEmpty >= 0) {
      const start = Math.max(0, lastNonEmpty - limit + 1);
      const lines = [];
      for (let i = start; i <= lastNonEmpty; i++) lines.push(rowText(i));
      result = lines.join('\n');
    }

    this._consumedLines = this._linesProduced;
    this._dirty = false;
    return result;
  }

  /**
   * Like snapshot() but does NOT reset the new-output counters — a read-only
   * view of the rendered tail for repaint-on-join, so it never steals delta
   * lines from the sticky-note volume trigger.
   * @param {number} [maxLines]
   * @returns {Promise<string>}
   */
  async peek(maxLines) {
    const limit = maxLines || this._maxDeltaLines;
    await this._drain();
    const buf = this._term.buffer.active;
    const cursorRow = buf.baseY + buf.cursorY;
    const rowText = (i) => {
      const line = buf.getLine(i);
      return line ? line.translateToString(true) : '';
    };
    let lastNonEmpty = cursorRow;
    while (lastNonEmpty >= 0 && rowText(lastNonEmpty) === '') lastNonEmpty--;
    if (lastNonEmpty < 0) return '';
    const start = Math.max(0, lastNonEmpty - limit + 1);
    const lines = [];
    for (let i = start; i <= lastNonEmpty; i++) lines.push(rowText(i));
    return lines.join('\n');
  }

  /** Resolve once xterm has parsed everything written so far. */
  _drain() {
    return new Promise((resolve) => this._term.write('', resolve));
  }

  dispose() {
    try {
      this._term.dispose();
    } catch {
      /* already disposed */
    }
  }
}

module.exports = TranscriptBuffer;
