// test/osc7-parser.test.js — OSC 7 parser unit tests (Part A of file-browser v2).
//
// The parser lives in src/osc7-parser.js and is wired into the Terminal bridge
// (src/terminal-bridge.js) per ADR-0019. These tests cover the pure parser in
// isolation — no PTY required — over the OSC 7 byte-sequence table:
//
//   - POSIX paths (with and without localhost host segment)
//   - Windows drive paths (file:///C:/...)
//   - Windows UNC paths (file://server/share/...)
//   - BEL (\x07) and ST (\x1b\\) terminators
//   - Percent-encoded paths (spaces, unicode)
//   - Malformed URIs (silent skip, no throw)
//   - Buffer-boundary split across feed() calls
//   - Overflow safety (4 KB cap on pending buffer)
//   - Multiple sequences in a single chunk
//   - Plain output bytes between/around sequences
//
// Cross-platform fixtures use url.fileURLToPath() as the reference so that
// Windows-shaped URIs (drive + UNC) assert parity with whatever Node returns
// on the host platform — see ADR-0019 §"Cross-platform path handling".
//
// Bridge-level wiring (validatePath rejection, cwd_changed emit on change,
// no-op for non-Terminal bridges) is exercised by a small harness at the
// bottom of this file that drives TerminalBridge#_handleOsc7Chunk directly,
// avoiding a real PTY spawn.

'use strict';

const assert = require('assert');
const url = require('url');
const path = require('path');

const Osc7Parser = require('../src/osc7-parser');

// Many parser fixtures use POSIX-shaped URIs (`file:///tmp`, `file:///Users/foo`)
// because the parser was originally developed on macOS. On Windows,
// `url.fileURLToPath('file:///tmp')` throws `ERR_INVALID_FILE_URL_PATH`
// (Win32 requires a drive letter after the third slash), so both sides
// of the assertion throw and the test fails. The parser itself is
// platform-portable — its Windows behaviour is exercised by the dedicated
// "cross-platform path shapes" describe block (drive + UNC), which DOES
// run on Windows. Gate the POSIX-fixture describe blocks behind this flag
// so CI on windows-latest stays green without sacrificing coverage on
// POSIX runners.
const IS_WINDOWS = process.platform === 'win32';
function skipOnWindows() {
  if (IS_WINDOWS) return this.skip();
}

describe('Osc7Parser', function () {

  describe('basic parsing — single sequence', function () {
    before(skipOnWindows);
    it('parses a POSIX path with BEL terminator', function () {
      const p = new Osc7Parser();
      const out = p.feed('\x1b]7;file:///Users/foo/code\x07');
      assert.deepStrictEqual(out, [url.fileURLToPath('file:///Users/foo/code')]);
    });

    it('parses a POSIX path with ST terminator (ESC + backslash)', function () {
      const p = new Osc7Parser();
      const out = p.feed('\x1b]7;file:///tmp\x1b\\');
      assert.deepStrictEqual(out, [url.fileURLToPath('file:///tmp')]);
    });

    it('parses with explicit localhost host', function () {
      const p = new Osc7Parser();
      const out = p.feed('\x1b]7;file://localhost/Users/foo\x07');
      assert.deepStrictEqual(out, [url.fileURLToPath('file://localhost/Users/foo')]);
    });

    it('parses with arbitrary hostname (POSIX: strip host fallback; Windows: UNC)', function () {
      const p = new Osc7Parser();
      const uri = 'file://my-host.example.com/Users/foo';
      // Real shells emit `file://$HOSTNAME$PWD` — almost never `localhost`.
      // Node's fileURLToPath REJECTS non-localhost hosts on POSIX, so the
      // parser falls back to stripping the host and decoding the path
      // component locally (mirrors iTerm2 / GNOME Terminal / WezTerm
      // behaviour). On Windows the host segment is meaningful (UNC), so
      // fileURLToPath handles it directly.
      let expected;
      if (process.platform === 'win32') {
        expected = [url.fileURLToPath(uri)];
      } else {
        expected = [url.fileURLToPath('file:///Users/foo')];
      }
      assert.deepStrictEqual(p.feed('\x1b]7;' + uri + '\x07'), expected);
    });

    it('parses with the local machine hostname (the spec\'s bash hook case)', function () {
      // This is THE case the codex critic flagged — bash's PROMPT_COMMAND
      // hook in docs/specs/file-browser.md emits `file://$HOSTNAME$PWD`.
      // On macOS / Linux $HOSTNAME is the machine name (e.g. "mini.local"),
      // never "localhost". Without the host-strip fallback the parser
      // silently drops every prompt's OSC 7 sequence — meaning the
      // documented hook has NO effect end-to-end.
      const p = new Osc7Parser();
      const out = p.feed('\x1b]7;file://mini.local/Users/foo/code\x07');
      if (process.platform === 'win32') {
        // On Windows, file://mini.local/Users/foo/code is a UNC path.
        assert.deepStrictEqual(out, [url.fileURLToPath('file://mini.local/Users/foo/code')]);
      } else {
        // POSIX: host stripped, path decoded locally.
        assert.deepStrictEqual(out, [url.fileURLToPath('file:///Users/foo/code')]);
      }
    });

    it('decodes percent-encoded paths (spaces)', function () {
      const p = new Osc7Parser();
      const out = p.feed('\x1b]7;file:///Users/foo/my%20code\x07');
      assert.deepStrictEqual(out, [url.fileURLToPath('file:///Users/foo/my%20code')]);
      // Sanity: the decoded path actually contains a literal space.
      assert.ok(out[0].indexOf('my code') !== -1, 'decoded path: ' + out[0]);
    });

    it('decodes percent-encoded paths (unicode)', function () {
      const p = new Osc7Parser();
      // %E2%9C%93 = ✓ (U+2713)
      const out = p.feed('\x1b]7;file:///tmp/%E2%9C%93\x07');
      assert.deepStrictEqual(out, [url.fileURLToPath('file:///tmp/%E2%9C%93')]);
      assert.ok(out[0].indexOf('✓') !== -1, 'decoded path: ' + JSON.stringify(out[0]));
    });
  });

  describe('cross-platform path shapes (parity with url.fileURLToPath)', function () {
    // These URIs SHAPE-test the parser; the actual decoded form depends on
    // the host platform (url.fileURLToPath is platform-aware). We assert
    // parity with the reference impl rather than hardcoding a path string.

    it('Windows drive URI — yields whatever url.fileURLToPath yields on this host', function () {
      const p = new Osc7Parser();
      const uri = 'file:///C:/Users/foo';
      let expected;
      try {
        expected = url.fileURLToPath(uri);
      } catch (_) {
        // On POSIX, this URI is treated as a POSIX path /C:/Users/foo.
        // url.fileURLToPath does not throw on POSIX for this shape — it
        // returns the literal path. We assert parity either way.
        return this.skip();
      }
      const out = p.feed('\x1b]7;' + uri + '\x07');
      assert.deepStrictEqual(out, [expected]);
    });

    it('Windows UNC URI — yields whatever url.fileURLToPath yields on this host', function () {
      const p = new Osc7Parser();
      // UNC needs a non-empty, non-localhost host with a path; both Win + POSIX
      // accept this shape — Win returns \\server\share\foo, POSIX returns /share/foo.
      const uri = 'file://server/share/foo';
      let expected;
      try {
        expected = url.fileURLToPath(uri);
      } catch (_) {
        return this.skip();
      }
      const out = p.feed('\x1b]7;' + uri + '\x07');
      assert.deepStrictEqual(out, [expected]);
    });
  });

  describe('malformed sequences', function () {
    before(skipOnWindows);
    it('returns [] for a non-file:// scheme inside OSC 7', function () {
      const p = new Osc7Parser();
      // OSC 7 spec only assigns file:// — http://, ftp://, etc. should be skipped.
      const out = p.feed('\x1b]7;ftp://example.com/path\x07');
      assert.deepStrictEqual(out, []);
    });

    it('returns [] for an empty OSC 7 body', function () {
      const p = new Osc7Parser();
      const out = p.feed('\x1b]7;\x07');
      assert.deepStrictEqual(out, []);
    });

    it('returns [] for a syntactically broken file:// URI without crashing', function () {
      const p = new Osc7Parser();
      // url.fileURLToPath throws TypeError [ERR_INVALID_FILE_URL_HOST] on this
      // (relative file URI). Parser must catch and skip.
      const out = p.feed('\x1b]7;file:not-a-url\x07');
      assert.deepStrictEqual(out, []);
    });

    it('skips a sequence with no terminator (kept in pending), then completes on later feed', function () {
      const p = new Osc7Parser();
      // First feed: just the prefix + body, no terminator.
      const a = p.feed('\x1b]7;file:///Users/foo');
      assert.deepStrictEqual(a, []);
      // Second feed: the rest of the path + terminator.
      const b = p.feed('/code\x07');
      assert.deepStrictEqual(b, [url.fileURLToPath('file:///Users/foo/code')]);
    });

    it('does not match an OSC sequence with a different command number (e.g. OSC 0)', function () {
      const p = new Osc7Parser();
      const out = p.feed('\x1b]0;Window Title\x07');
      assert.deepStrictEqual(out, []);
    });
  });

  describe('buffer boundary safety (split across chunks)', function () {
    before(skipOnWindows);
    it('split inside the URI body resolves on second feed', function () {
      const p = new Osc7Parser();
      assert.deepStrictEqual(p.feed('\x1b]7;file:///t'), []);
      assert.deepStrictEqual(p.feed('mp/x\x07'),
        [url.fileURLToPath('file:///tmp/x')]);
    });

    it('split inside the OSC prefix resolves on second feed', function () {
      const p = new Osc7Parser();
      assert.deepStrictEqual(p.feed('\x1b]7'), []);
      assert.deepStrictEqual(p.feed(';file:///tmp\x07'),
        [url.fileURLToPath('file:///tmp')]);
    });

    it('split between body and ST terminator (ESC then backslash) resolves', function () {
      const p = new Osc7Parser();
      // ST = ESC + backslash. Split between the ESC and the backslash.
      assert.deepStrictEqual(p.feed('\x1b]7;file:///tmp\x1b'), []);
      assert.deepStrictEqual(p.feed('\\'),
        [url.fileURLToPath('file:///tmp')]);
    });
  });

  describe('overflow safety (4 KB pending cap)', function () {
    before(skipOnWindows);
    it('drops a runaway sequence that never terminates and resyncs cleanly', function () {
      const p = new Osc7Parser();
      // Start a sequence and never terminate it — feed > 4 KB of junk after.
      const huge = '\x1b]7;file:///x' + 'a'.repeat(8 * 1024);
      const out1 = p.feed(huge);
      assert.deepStrictEqual(out1, []);
      // After overflow, a fresh well-formed sequence should still parse.
      const out2 = p.feed('\x1b]7;file:///tmp\x07');
      assert.deepStrictEqual(out2, [url.fileURLToPath('file:///tmp')]);
    });

    it('does not retain plain output bytes when no OSC 7 prefix is in flight', function () {
      const p = new Osc7Parser();
      // Plain terminal output; should not blow the buffer.
      p.feed('a'.repeat(10 * 1024));
      // Pending buffer must not have grown unbounded.
      assert.ok(p._bufLength() < 4096,
        'pending buffer should be bounded (got ' + p._bufLength() + ')');
    });
  });

  describe('multiple sequences', function () {
    before(skipOnWindows);
    it('extracts two back-to-back sequences in a single feed', function () {
      const p = new Osc7Parser();
      const out = p.feed('\x1b]7;file:///a\x07\x1b]7;file:///b\x07');
      assert.deepStrictEqual(out, [
        url.fileURLToPath('file:///a'),
        url.fileURLToPath('file:///b'),
      ]);
    });

    it('extracts sequences separated by plain output', function () {
      const p = new Osc7Parser();
      const out = p.feed(
        'shell prompt$ cd /tmp\r\n' +
        '\x1b]7;file:///tmp\x07' +
        '$ cd /var\r\n' +
        '\x1b]7;file:///var\x07'
      );
      assert.deepStrictEqual(out, [
        url.fileURLToPath('file:///tmp'),
        url.fileURLToPath('file:///var'),
      ]);
    });

    it('handles empty / non-string input gracefully', function () {
      const p = new Osc7Parser();
      assert.deepStrictEqual(p.feed(''), []);
      assert.deepStrictEqual(p.feed(null), []);
      assert.deepStrictEqual(p.feed(undefined), []);
    });
  });
});

// ---------------------------------------------------------------------------
// TerminalBridge wiring — exercises the parser → validatePath → onCwdChange
// callback flow without spawning a real PTY. We construct a TerminalBridge,
// inject a session entry into its parsers map, and feed bytes through the
// internal handler the same way the real onData wrapper does.
// ---------------------------------------------------------------------------

describe('TerminalBridge OSC 7 wiring', function () {
  before(skipOnWindows);
  let TerminalBridge;
  try {
    TerminalBridge = require('../src/terminal-bridge');
  } catch (_) {
    // node-pty not loadable on this platform — skip the wiring tests.
    return;
  }

  function makeBridge() {
    const bridge = new TerminalBridge();
    return bridge;
  }

  it('emits onCwdChange with prev/cwd when validatePath accepts and value changes', function () {
    const bridge = makeBridge();
    const events = [];
    const sessionId = 'sess-A';

    bridge._installOsc7State(sessionId, {
      onCwdChange: (cwd, prev) => events.push({ cwd, prev }),
      validatePath: (p) => ({ valid: true, path: p }),
    });

    bridge._handleOsc7Chunk(sessionId, '\x1b]7;file:///tmp\x07');
    bridge._handleOsc7Chunk(sessionId, '\x1b]7;file:///tmp\x07'); // no change → no event
    bridge._handleOsc7Chunk(sessionId, '\x1b]7;file:///var\x07');

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].cwd, url.fileURLToPath('file:///tmp'));
    assert.strictEqual(events[0].prev, null);
    assert.strictEqual(events[1].cwd, url.fileURLToPath('file:///var'));
    assert.strictEqual(events[1].prev, url.fileURLToPath('file:///tmp'));

    bridge._uninstallOsc7State(sessionId);
  });

  it('silently drops paths rejected by validatePath (no event, no throw)', function () {
    const bridge = makeBridge();
    const events = [];
    const sessionId = 'sess-B';

    bridge._installOsc7State(sessionId, {
      onCwdChange: (cwd, prev) => events.push({ cwd, prev }),
      // Reject everything — simulates a path outside the sandbox.
      validatePath: () => ({ valid: false, error: 'denied' }),
    });

    bridge._handleOsc7Chunk(sessionId, '\x1b]7;file:///etc/passwd\x07');
    assert.strictEqual(events.length, 0);
    assert.strictEqual(bridge.getLiveCwd(sessionId), null);

    bridge._uninstallOsc7State(sessionId);
  });

  it('uses validatePath().path (canonicalized) for the emitted cwd', function () {
    const bridge = makeBridge();
    const events = [];
    const sessionId = 'sess-C';

    bridge._installOsc7State(sessionId, {
      onCwdChange: (cwd, prev) => events.push({ cwd, prev }),
      // Canonicalize: pretend /tmp is symlinked to /private/tmp on macOS.
      validatePath: (p) => ({ valid: true, path: p.replace(/^\/tmp/, '/private/tmp') }),
    });

    bridge._handleOsc7Chunk(sessionId, '\x1b]7;file:///tmp/foo\x07');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].cwd, '/private/tmp/foo');

    bridge._uninstallOsc7State(sessionId);
  });

  it('is a no-op for a session that never had OSC 7 state installed', function () {
    const bridge = makeBridge();
    // Should not throw.
    bridge._handleOsc7Chunk('never-installed', '\x1b]7;file:///tmp\x07');
    assert.strictEqual(bridge.getLiveCwd('never-installed'), null);
  });

  it('cleans up parser + liveCwd on _uninstallOsc7State', function () {
    const bridge = makeBridge();
    const sessionId = 'sess-D';

    bridge._installOsc7State(sessionId, {
      onCwdChange: () => {},
      validatePath: (p) => ({ valid: true, path: p }),
    });
    bridge._handleOsc7Chunk(sessionId, '\x1b]7;file:///tmp\x07');
    assert.notStrictEqual(bridge.getLiveCwd(sessionId), null);

    bridge._uninstallOsc7State(sessionId);
    assert.strictEqual(bridge.getLiveCwd(sessionId), null);
  });
});
