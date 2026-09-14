const assert = require('assert');
const ClaudeBridge = require('../src/claude-bridge');

const isWindows = process.platform === 'win32';

describe('ClaudeBridge', function() {
  let bridge;

  beforeEach(function() {
    bridge = new ClaudeBridge();
  });

  describe('constructor', function() {
    it('should initialize with a Map for sessions', function() {
      assert(bridge.sessions instanceof Map);
      assert.strictEqual(bridge.sessions.size, 0);
    });

    it('should find a claude command on initialization', function() {
      assert(typeof bridge.command === 'string');
      assert(bridge.command.length > 0);
    });
  });

  describe('commandExists', function() {
    it('should return true for existing commands', function() {
      const cmd = isWindows ? 'cmd' : 'ls';
      const result = bridge.commandExists(cmd);
      assert.strictEqual(result, true);
    });

    it('should return false for non-existent commands', function() {
      const result = bridge.commandExists('nonexistentcommand12345');
      assert.strictEqual(result, false);
    });

    it('should return within the timeout period', function() {
      const start = Date.now();
      bridge.commandExists('nonexistentcommand12345');
      const elapsed = Date.now() - start;
      assert(elapsed < 6000, `commandExists took ${elapsed}ms, expected < 6000ms`);
    });

    it('should handle command names with special characters safely', function() {
      const result = bridge.commandExists('ls; echo "injected"');
      assert.strictEqual(result, false);
    });
  });

  describe('isAvailable', function() {
    it('should return a boolean', function() {
      const result = bridge.isAvailable();
      assert(typeof result === 'boolean');
    });
  });

  describe('getSession', function() {
    it('should return undefined for non-existent session', function() {
      const result = bridge.getSession('nonexistent');
      assert.strictEqual(result, undefined);
    });
  });

  describe('getAllSessions', function() {
    it('should return empty array when no sessions exist', function() {
      const result = bridge.getAllSessions();
      assert(Array.isArray(result));
      assert.strictEqual(result.length, 0);
    });
  });

  describe('processOutput trust auto-accept (F7)', function() {
    function fakePty() {
      const writes = [];
      return { writes, write: (d) => writes.push(d) };
    }
    // The answer is delivered through the per-session write queue (never a
    // raw pty write, which could interleave inside a queued SGR sequence),
    // so tests register a live fake session for the delivery to land in.
    function liveSession(id, pty) {
      bridge.sessions.set(id, {
        active: true,
        process: pty,
        writeQueue: Promise.resolve(),
        _inputQueueDepth: 0,
        _motionTail: null,
      });
    }
    // Claude's Ink TUI interleaves ANSI escapes between words; the de-ANSI'd buffer
    // is what the shared TRUST_PROMPT_REGEX matches. A real trust modal always shows
    // a numbered "1. / 2." choice list, which the bridge now requires before acting.
    const ansi = (s) => s.replace(/ /g, '\x1b[39m \x1b[1m');

    it('auto-accepts the "Is this a project you trust?" variant (previously missed)', function(done) {
      const pty = fakePty();
      liveSession('s-trust-a', pty);
      bridge.processOutput('s-trust-a', pty, ansi('Is this a project you trust? 1. Yes 2. No'));
      setTimeout(() => {
        try { assert.deepStrictEqual(pty.writes, ['1\r']); done(); } catch (e) { done(e); }
      }, 700);
    });

    it('auto-accepts the "Do you trust the files in this folder?" variant', function(done) {
      const pty = fakePty();
      liveSession('s-trust-b', pty);
      bridge.processOutput('s-trust-b', pty, ansi('Do you trust the files in this folder? 1. Yes, proceed 2. No, exit'));
      setTimeout(() => {
        try { assert.deepStrictEqual(pty.writes, ['1\r']); done(); } catch (e) { done(e); }
      }, 700);
    });

    it('does NOT write for ordinary output (no trust modal)', function(done) {
      const pty = fakePty();
      bridge.processOutput('s-notrust', pty, 'Running tests... all green.');
      setTimeout(() => {
        try { assert.deepStrictEqual(pty.writes, []); done(); } catch (e) { done(e); }
      }, 700);
    });

    it('does NOT inject on a trust PHRASE without a numbered choice list (false-positive guard)', function(done) {
      const pty = fakePty();
      // Claude printing the phrase in prose / a file / a commit message must NOT
      // inject a keystroke — only a real "1./2." modal may.
      bridge.processOutput('s-prose', pty, 'Make sure you trust this folder before you do you trust the files thing.');
      setTimeout(() => {
        try { assert.deepStrictEqual(pty.writes, []); done(); } catch (e) { done(e); }
      }, 700);
    });

    it('is one-shot per session (guarded against repeat accepts)', function(done) {
      const pty = fakePty();
      liveSession('s-once', pty);
      bridge.processOutput('s-once', pty, 'trust this folder? 1. Yes 2. No');
      bridge.processOutput('s-once', pty, 'trust this folder? 1. Yes 2. No');
      setTimeout(() => {
        try { assert.deepStrictEqual(pty.writes, ['1\r']); done(); } catch (e) { done(e); }
      }, 700);
    });

    it('answers behind queued input in order (no interleave with SGR stream)', function(done) {
      const pty = fakePty();
      liveSession('s-order', pty);
      // Queue a drag flood first, then trigger the trust modal: the answer
      // must land after the queued bytes, never interleaved inside them.
      bridge.sendInput('s-order', '\x1b[<32;10;10M\x1b[<32;11;10M').catch(() => {});
      bridge.processOutput('s-order', pty, 'trust this folder? 1. Yes 2. No');
      setTimeout(() => {
        try {
          assert.deepStrictEqual(pty.writes, ['\x1b[<32;10;10M\x1b[<32;11;10M', '1\r']);
          done();
        } catch (e) { done(e); }
      }, 900);
    });
  });
});