// src/osc7-parser.js — In-band CWD signal extractor for OSC 7 sequences.
//
// OSC 7 (Operating System Command, payload 7) is the de-facto cross-vendor
// protocol shells use to broadcast their current working directory: the byte
// sequence `ESC ] 7 ; file://<host><path> BEL` (or with `ESC \` as the
// String Terminator instead of BEL). Every modern terminal emulator parses
// it — VTE/GNOME Terminal, iTerm2, WezTerm, Konsole, Tilix — and that's
// what we leverage here. See ADR-0019 for the full rationale (vs PID
// polling / static-only) and the cross-platform path-handling story.
//
// Responsibilities:
//
//   1. Maintain a small per-instance pending buffer (cap 4 KB) so OSC 7
//      sequences split across PTY chunks resolve correctly.
//   2. Match `\x1b]7;file://...` framing with either BEL (`\x07`) or ST
//      (`\x1b\\`) terminator.
//   3. Decode the matched URI via Node's built-in `url.fileURLToPath()`.
//      This handles POSIX (`file:///Users/foo`), Windows drive
//      (`file:///C:/Users/foo` → `C:\Users\foo`), and Windows UNC
//      (`file://server/share/foo` → `\\server\share\foo`) uniformly.
//   4. Tolerate junk: malformed URIs, non-`file://` schemes, missing
//      terminators, and overflow are all silent skips. Never throws on
//      input — production runs inside the PTY data hot path.
//
// Non-responsibilities:
//
//   - Sandbox enforcement (caller's `validatePath()`).
//   - WebSocket emit (caller decides on change).
//   - Stripping the OSC 7 bytes from the output stream (we deliberately
//      DO NOT strip — xterm.js silently ignores unknown OSC sequences and
//      preserving the bytes keeps parity with native terminals).

'use strict';

const url = require('url');

const PREFIX = '\x1b]7;';
const PREFIX_LEN = PREFIX.length; // 4 bytes
const BEL = '\x07';
const ST = '\x1b\\';
const MAX_PENDING = 4096;

class Osc7Parser {
  constructor() {
    /**
     * Pending byte buffer between feeds. Holds whatever could not yet be
     * resolved to a complete OSC 7 sequence — typically a partial sequence
     * straddling a PTY chunk boundary. Capped at MAX_PENDING; on overflow
     * the buffer is dropped and we resync at the next OSC 7 prefix.
     */
    this._buf = '';
  }

  /**
   * Feed one PTY data chunk (or any string) into the parser. Returns an
   * array of zero or more decoded absolute paths (in whatever form
   * `url.fileURLToPath()` produces on the host platform).
   *
   * Safe to call with empty / null / undefined input — returns [].
   *
   * @param {string} chunk - Raw PTY bytes as a string. Multi-byte UTF-8 is
   *   passed through unchanged; the OSC 7 framing bytes (ESC, BEL, ;,
   *   file://) are all single-byte ASCII so per-character indexing is safe.
   * @returns {string[]} Decoded paths, in feed order. Empty array if no
   *   complete sequence resolved this call.
   */
  feed(chunk) {
    if (!chunk) return [];
    if (typeof chunk !== 'string') chunk = String(chunk);
    this._buf += chunk;

    const results = [];

    // Loop: each iteration either consumes one complete OSC 7 sequence,
    // drops leading non-OSC bytes, or breaks out (no more starts found,
    // or pending an unfinished sequence).
    while (true) {
      const start = this._buf.indexOf(PREFIX);
      if (start < 0) {
        // No OSC 7 prefix anywhere in the pending buffer. Drop everything
        // — the bytes are plain output, retaining them serves no purpose
        // and would let plain output drive the buffer to MAX_PENDING.
        // Keep only the trailing 3 bytes in case a prefix straddles
        // chunks (`\x1b]7` + `;file://...` arriving in two feeds).
        this._buf = this._buf.length > PREFIX_LEN - 1
          ? this._buf.slice(-(PREFIX_LEN - 1))
          : this._buf;
        // If even the truncated tail doesn't start with `\x1b`, drop it too.
        if (this._buf.indexOf('\x1b') < 0) this._buf = '';
        break;
      }

      // Drop bytes before the prefix — they're plain output, not part of
      // any OSC 7 sequence we care about.
      if (start > 0) this._buf = this._buf.slice(start);

      // Search for the terminator AFTER the prefix bytes. Either BEL or
      // ST may close the sequence; take whichever appears first.
      const bel = this._buf.indexOf(BEL, PREFIX_LEN);
      const st = this._buf.indexOf(ST, PREFIX_LEN);

      let term = -1;
      let termLen = 0;
      if (bel >= 0 && (st < 0 || bel < st)) {
        term = bel;
        termLen = 1;
      } else if (st >= 0) {
        term = st;
        termLen = 2;
      }

      if (term < 0) {
        // Unterminated sequence — keep pending and wait for more bytes.
        // Overflow guard: if the in-flight sequence exceeds the cap, drop
        // and resync. A 4 KB OSC 7 path is pathological anyway (POSIX
        // PATH_MAX is 4096, Windows MAX_PATH is 260) — anything larger is
        // either a buggy emitter or an attacker probing the parser.
        if (this._buf.length > MAX_PENDING) this._buf = '';
        break;
      }

      // Extract the body between prefix and terminator, advance past the
      // terminator, and try to decode.
      const body = this._buf.slice(PREFIX_LEN, term);
      this._buf = this._buf.slice(term + termLen);

      // OSC 7 only meaningfully carries `file://` URIs. Other OSC 7
      // payloads (some shells emit non-CWD info on the same channel) are
      // silently ignored — same posture xterm.js takes.
      if (!body.startsWith('file://')) continue;

      try {
        const p = url.fileURLToPath(body);
        results.push(p);
      } catch (_) {
        // Malformed URI (invalid host segment, bad percent encoding, etc.).
        // Silent drop — there's no recovery path inside a PTY data stream.
        // Optional debug:
        if (process.env.DEBUG) {
          // eslint-disable-next-line no-console
          console.warn('osc7-parser: skipped malformed body:', JSON.stringify(body));
        }
      }
    }

    return results;
  }

  /**
   * Reset the pending buffer. Called when a session is destroyed so the
   * parser doesn't leak unfinished bytes across session lifetimes.
   */
  reset() {
    this._buf = '';
  }

  /**
   * Inspection helper for tests — returns the current pending buffer
   * length without exposing the contents.
   */
  _bufLength() {
    return this._buf.length;
  }
}

module.exports = Osc7Parser;
module.exports.MAX_PENDING = MAX_PENDING;
