'use strict';

// osc52-handler.js — bridge TUI clipboard (OSC 52) to the browser clipboard.
//
// Problem: a fullscreen TUI (opencode, etc.) running on the REMOTE host copies
// via OSC 52 (`ESC ] 52 ; c ; <base64> BEL`). That sequence sets the *host*
// clipboard — useless when the user sits at a different machine's browser.
// xterm.js deliberately ignores OSC 52, so without a bridge the app's
// "copied to clipboard" toast lies: nothing lands on the user's machine.
// This module snoops the decoded PTY output stream for OSC 52 set-clipboard
// sequences and forwards them to navigator.clipboard.writeText.
//
// Security posture (mirrors mainstream emulators):
//   - Pc `c` (system clipboard), empty Pc, and Pc `p` (primary selection,
//     mapped to the system clipboard — browsers have no primary selection)
//     are honored. `s` and others are ignored.
//   - Queries (`Pd == ?`) are IGNORED and never answered: replying would
//     exfiltrate the user's local clipboard to the remote process.
//   - tmux/screen DCS passthrough wraps (`ESC P tmux ; <inner> ESC \`, with
//     inner ESCs doubled) are unwrapped before scanning, so copies survive
//     a multiplexer between the app and the PTY master.
//   - Payload capped (OSC52_MAX_B64 base64 chars); oversized sequences are
//     dropped, never written.
//   - Clipboard write failures (denied permission, insecure http://,
//     unfocused document) surface via onDenied; nothing throws into the
//     terminal write path.
// Wiring: app.js feeds live decoded output chunks into the shared bridge in
// _flushWritesChunk; splits.js does the same per pane. Join-replay bytes are
// deliberately NOT bridged (a rejoin must not re-copy stale payloads).

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined' && root) {
    root.Osc52Handler = api;
    root.Osc52Parser = api.Osc52Parser;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  // ~384KB decoded text cap per copy; larger copies are almost certainly a
  // runaway or abuse, not a user copy action.
  var OSC52_MAX_B64 = 512 * 1024;
  // Longest tail retained across chunks awaiting sequence completion. Sized
  // to cover a max-size copy inside tmux DCS wrapping, not just a short
  // prefix: DCS blocks for large copies legitimately span many chunks.
  var OSC52_CARRY_MAX = OSC52_MAX_B64 + 1024;
  var B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
  // A trailing fragment that could still grow into `ESC ] 52 ; ...`.
  var PARTIAL_RE = /^\x1b(\]?(5?(2?(;?([cps]?;?[A-Za-z0-9+/=]*?)?)?)?)?)?$/;
  var COMPLETE_RE = /\x1b\]52;([cps]?);([A-Za-z0-9+/=\s]*|\?)(?:\x07|\x1b\\)/g;
  // tmux/screen DCS passthrough wrap around an OSC 52 sequence. Inner ESCs
  // are doubled by the multiplexer and restored on unwrap. Unwrapped with a
  // small scanner (not a lazy regex) so an ST-terminated inner sequence —
  // whose doubled `ESC ESC \` contains a fake `ESC \` terminator — cannot
  // truncate the match early.
  var TMUX_PFX = '\x1bPtmux;';
  function unwrapTmuxDcs(buf) {
    var start = buf.indexOf(TMUX_PFX);
    if (start === -1) return buf;
    var out = '';
    var i = 0;
    while (true) {
      start = buf.indexOf(TMUX_PFX, i);
      if (start === -1) { out += buf.slice(i); break; }
      out += buf.slice(i, start);
      var j = start + TMUX_PFX.length;
      var inner = '';
      var closed = false;
      while (j < buf.length) {
        var ch = buf[j];
        if (ch === '\x1b') {
          if (buf[j + 1] === '\x1b') { inner += '\x1b'; j += 2; continue; }
          if (buf[j + 1] === '\\') { j += 2; closed = true; break; }
          inner += ch; j += 1; continue; // malformed lone ESC: keep scanning
        }
        inner += ch; j += 1;
      }
      if (!closed) {
        // Incomplete wrap (split across chunks): leave the remainder for the
        // carry logic below; the next push() completes it.
        out += buf.slice(start);
        break;
      }
      out += inner;
      i = j;
    }
    return out;
  }

  function decodeBase64Utf8(b64) {
    var clean = String(b64).replace(/\s/g, '');
    if (!clean || clean.length > OSC52_MAX_B64 || !B64_RE.test(clean)) return null;
    try {
      if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        return Buffer.from(clean, 'base64').toString('utf8');
      }
      // Browser path: atob -> bytes -> UTF-8.
      var bin = atob(clean); // eslint-disable-line no-undef
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
      return bin;
    } catch (_) {
      return null;
    }
  }

  // Streaming parser: push() decoded output text, get back an array of
  // clipboard strings ready to write. Retains only a bounded partial tail.
  function Osc52Parser() {
    this._carry = '';
  }

  Osc52Parser.prototype.push = function (text) {
    var out = [];
    if (!text) return out;
    var buf = this._carry + text;
    this._carry = '';
    // Unwrap tmux/screen DCS passthrough first so a multiplexer between the
    // app and the PTY master cannot hide the inner OSC 52 sequence.
    if (buf.indexOf('\x1bP') !== -1) {
      buf = unwrapTmuxDcs(buf);
    }
    COMPLETE_RE.lastIndex = 0;
    var m;
    var lastEnd = 0;
    while ((m = COMPLETE_RE.exec(buf)) !== null) {
      lastEnd = COMPLETE_RE.lastIndex;
      var pc = m[1];
      var data = m[2];
      if (data === '?') continue; // query: never answer (no exfiltration)
      // `c`/empty = system clipboard; `p` = primary, mapped onto it
      // (browsers have no primary selection). `s`/others ignored.
      if (pc !== 'c' && pc !== '' && pc !== 'p') continue;
      var decoded = decodeBase64Utf8(data);
      if (decoded) out.push(decoded);
    }
    // Retain a possibly-incomplete trailing prefix for the next chunk.
    var rest = buf.slice(lastEnd);
    if (rest) {
      // Unterminated DCS passthrough (e.g. a large tmux-wrapped copy split
      // across chunks). Only retained while genuinely incomplete (no ST yet)
      // so complete sixel/DCS blocks never pin memory.
      var pIdx = rest.lastIndexOf('\x1bP');
      if (pIdx !== -1) {
        var dcsTail = rest.slice(pIdx);
        if (dcsTail.length <= OSC52_CARRY_MAX && dcsTail.indexOf('\x1b\\') === -1) {
          this._carry = dcsTail;
          return out;
        }
      }
      var idx = rest.lastIndexOf('\x1b');
      if (idx !== -1) {
        var tail = rest.slice(idx);
        if (tail.length <= OSC52_CARRY_MAX && PARTIAL_RE.test(tail)) {
          this._carry = tail;
        }
      }
    }
    return out;
  };

  Osc52Parser.prototype.reset = function () {
    this._carry = '';
  };

  function resolveNavigator() {
    try {
      if (typeof globalThis !== 'undefined' && globalThis.navigator) return globalThis.navigator;
      if (typeof navigator !== 'undefined') return navigator; // eslint-disable-line no-undef
    } catch (_) { /* ignore */ }
    return null;
  }

  // Bridge: parser + async clipboard write + feedback callbacks.
  // opts: { writeText(text)->Promise, onCopied(text), onDenied(), navigator }
  function createOsc52Bridge(opts) {
    opts = opts || {};
    var parser = new Osc52Parser();
    function nav() {
      if (opts.navigator) return opts.navigator;
      return resolveNavigator();
    }
    function writeText(t) {
      if (typeof opts.writeText === 'function') return opts.writeText(t);
      var n = nav();
      if (!n || !n.clipboard || typeof n.clipboard.writeText !== 'function') {
        return Promise.resolve(false);
      }
      return n.clipboard.writeText(t).then(
        function () { return true; },
        function () { return false; }
      );
    }
    return {
      parser: parser,
      push: function (text) {
        var copies = parser.push(text);
        if (!copies.length) return;
        // Sequential writes preserve order; failures are per-copy.
        var chain = Promise.resolve();
        copies.forEach(function (copy) {
          chain = chain.then(function () {
            return writeText(copy).then(function (ok) {
              if (ok) {
                if (typeof opts.onCopied === 'function') {
                  try { opts.onCopied(copy); } catch (_) { /* ignore */ }
                }
              } else if (typeof opts.onDenied === 'function') {
                try { opts.onDenied(); } catch (_) { /* ignore */ }
              }
            });
          });
        });
        return chain;
      },
      reset: function () { parser.reset(); },
    };
  }

  return {
    Osc52Parser: Osc52Parser,
    createOsc52Bridge: createOsc52Bridge,
    decodeBase64Utf8: decodeBase64Utf8,
    unwrapTmuxDcs: unwrapTmuxDcs,
    OSC52_MAX_B64: OSC52_MAX_B64,
    OSC52_CARRY_MAX: OSC52_CARRY_MAX,
  };
});
