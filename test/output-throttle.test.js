const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

// Exercise the real server methods with only their stateful collaborators mocked.
// This keeps wire-format, priority, flow-control, and backpressure coverage from
// drifting away from production.

const WebSocket = { OPEN: 1 };

const MAX_COALESCE_BYTES = 32 * 1024;

class OutputThrottleHarness {
  constructor() {
    this.claudeSessions = new Map();
    this.webSocketConnections = new Map();
    this.sentMessages = []; // Track what was sent
  }

  // Helper: create a session with mock WebSocket clients
  addSession(sessionId, clientCount) {
    const connections = new Set();
    for (let i = 0; i < clientCount; i++) {
      const wsId = `ws-${sessionId}-${i}`;
      connections.add(wsId);
      const sentRef = this.sentMessages;
      this.webSocketConnections.set(wsId, {
        claudeSessionId: sessionId,
        ws: {
          readyState: WebSocket.OPEN,
          bufferedAmount: 0,
          send(data, options) { sentRef.push({ wsId, data, options }); }
        }
      });
    }
    this.claudeSessions.set(sessionId, {
      connections,
      priority: 'foreground',
      _pendingChunks: [],
      _pendingBytes: 0,
      _outputFlushTimer: null,
      _flushing: false,
    });
  }
}

OutputThrottleHarness.prototype._throttledOutputBroadcast =
  ClaudeCodeWebServer.prototype._throttledOutputBroadcast;
OutputThrottleHarness.prototype._flushSessionOutput =
  ClaudeCodeWebServer.prototype._flushSessionOutput;
OutputThrottleHarness.prototype._flushAndClearOutputTimer =
  ClaudeCodeWebServer.prototype._flushAndClearOutputTimer;

describe('Output Throttle', function() {

  describe('_throttledOutputBroadcast', function() {
    it('should accumulate output in pending chunks', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      h._throttledOutputBroadcast('s1', 'hello');
      h._throttledOutputBroadcast('s1', ' world');

      const session = h.claudeSessions.get('s1');
      assert.deepStrictEqual(session._pendingChunks, ['hello', ' world']);
      assert.strictEqual(session._pendingBytes, 11);

      // Cleanup
      h._flushAndClearOutputTimer(session, 's1');
    });

    it('should set a flush timer on first call', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      h._throttledOutputBroadcast('s1', 'data');

      const session = h.claudeSessions.get('s1');
      assert.notStrictEqual(session._outputFlushTimer, null);

      // Cleanup
      h._flushAndClearOutputTimer(session, 's1');
    });

    it('should not set additional timers for subsequent calls within window', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      h._throttledOutputBroadcast('s1', 'a');
      const session = h.claudeSessions.get('s1');
      const firstTimer = session._outputFlushTimer;

      h._throttledOutputBroadcast('s1', 'b');
      assert.strictEqual(session._outputFlushTimer, firstTimer);

      // Cleanup
      h._flushAndClearOutputTimer(session, 's1');
    });

    it('should do nothing for non-existent session', function() {
      const h = new OutputThrottleHarness();
      // Should not throw
      h._throttledOutputBroadcast('nonexistent', 'data');
    });

    it('should flush immediately when pending output exceeds MAX_COALESCE_BYTES', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      // Feed data exceeding MAX_COALESCE_BYTES (32KB) in one call
      const largeData = 'x'.repeat(MAX_COALESCE_BYTES + 1);
      h._throttledOutputBroadcast('s1', largeData);

      // Flush should have happened immediately (not after the 16ms timer)
      assert.strictEqual(h.sentMessages.length, 1, 'Should flush immediately for large data');

      const session = h.claudeSessions.get('s1');
      assert.deepStrictEqual(session._pendingChunks, [], 'Pending output should be cleared after flush');
      assert.strictEqual(session._pendingBytes, 0);
      assert.strictEqual(session._outputFlushTimer, null, 'Timer should be null after immediate flush');
    });
  });

  describe('coalescing behavior', function() {
    it('should coalesce multiple calls into a single send after 16ms', function(done) {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      // Rapid-fire 10 output calls
      for (let i = 0; i < 10; i++) {
        h._throttledOutputBroadcast('s1', `line${i}\n`);
      }

      // No sends yet (timer hasn't fired)
      assert.strictEqual(h.sentMessages.length, 0);

      // After 20ms, the 16ms timer should have fired
      setTimeout(() => {
        assert.strictEqual(h.sentMessages.length, 1, 'Expected exactly 1 coalesced send');

        const output = h.sentMessages[0].data.toString('utf8');
        // All 10 lines should be in one message
        for (let i = 0; i < 10; i++) {
          assert.ok(output.includes(`line${i}\n`), `Missing line${i}`);
        }
        assert.deepStrictEqual(h.sentMessages[0].options, { binary: true, compress: false });
        done();
      }, 30);
    });

    it('should send the same binary frame to all connected clients', function(done) {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 3); // 3 clients

      h._throttledOutputBroadcast('s1', 'shared data');

      setTimeout(() => {
        assert.strictEqual(h.sentMessages.length, 3, 'Expected 3 sends (one per client)');

        // All 3 clients should receive the same pre-encoded buffer.
        const firstMsg = h.sentMessages[0].data;
        assert.ok(h.sentMessages.every(m => m.data === firstMsg),
          'All clients should receive the identical binary frame');
        assert.ok(Buffer.isBuffer(firstMsg));
        done();
      }, 30);
    });

    it('should preserve PUA codepoints through coalescing and UTF-8 encoding', function(done) {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      // PUA codepoints used by Nerd Fonts / Powerline
      const puaChars = [
        String.fromCharCode(0xE0B0), // U+E0B0 (Powerline right arrow)
        String.fromCharCode(0xE0A0), // U+E0A0 (Powerline branch)
        String.fromCharCode(0xE0B2)  // U+E0B2 (Powerline left arrow)
      ];

      // Feed each PUA string separately (same += pattern as _throttledOutputBroadcast)
      puaChars.forEach(ch => h._throttledOutputBroadcast('s1', ch));

      // Verify concatenation preserves codepoints in pending output
      const session = h.claudeSessions.get('s1');
      const concatenated = session._pendingChunks.join('');
      assert.strictEqual(concatenated.length, 3, 'Concatenated string should have 3 characters');
      assert.strictEqual(concatenated.charCodeAt(0), 0xE0B0, 'First char should be U+E0B0');
      assert.strictEqual(concatenated.charCodeAt(1), 0xE0A0, 'Second char should be U+E0A0');
      assert.strictEqual(concatenated.charCodeAt(2), 0xE0B2, 'Third char should be U+E0B2');

      // After the timer fires, verify the binary frame preserves them.
      setTimeout(() => {
        assert.strictEqual(h.sentMessages.length, 1, 'Expected 1 coalesced send');

        const decoded = h.sentMessages[0].data.toString('utf8');
        assert.strictEqual(decoded.charCodeAt(0), 0xE0B0, 'U+E0B0 survives binary encoding');
        assert.strictEqual(decoded.charCodeAt(1), 0xE0A0, 'U+E0A0 survives binary encoding');
        assert.strictEqual(decoded.charCodeAt(2), 0xE0B2, 'U+E0B2 survives binary encoding');
        done();
      }, 30);
    });
  });

  describe('_flushSessionOutput', function() {
    it('should skip broadcast when no clients connected', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 0); // Zero clients

      const session = h.claudeSessions.get('s1');
      session._pendingChunks = ['orphaned data'];
      session._pendingBytes = 13;

      h._flushSessionOutput('s1');

      assert.strictEqual(h.sentMessages.length, 0, 'Should not send to empty connections');
      assert.deepStrictEqual(session._pendingChunks, [], 'Should clear pending even with no clients');
      assert.strictEqual(session._pendingBytes, 0);
    });

    it('should clear pending chunks after flush', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      const session = h.claudeSessions.get('s1');
      session._pendingChunks = ['some data'];
      session._pendingBytes = 9;

      h._flushSessionOutput('s1');

      assert.deepStrictEqual(session._pendingChunks, []);
      assert.strictEqual(session._pendingBytes, 0);
    });

    it('should do nothing when pending chunks are empty', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      h._flushSessionOutput('s1');

      assert.strictEqual(h.sentMessages.length, 0);
    });

    it('should skip closed WebSocket connections', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 2);

      // Close one client
      const wsInfo = h.webSocketConnections.get('ws-s1-0');
      wsInfo.ws.readyState = 3; // CLOSED

      const session = h.claudeSessions.get('s1');
      session._pendingChunks = ['test data'];
      session._pendingBytes = 9;
      h._flushSessionOutput('s1');

      assert.strictEqual(h.sentMessages.length, 1, 'Only open client should receive');
      assert.strictEqual(h.sentMessages[0].wsId, 'ws-s1-1');
    });

    it('should skip slow clients when bufferedAmount exceeds 256KB threshold', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 2);

      // Set first client to have high bufferedAmount (above 256KB threshold)
      const slowWsInfo = h.webSocketConnections.get('ws-s1-0');
      slowWsInfo.ws.bufferedAmount = 300 * 1024;

      // Set second client to have zero bufferedAmount (healthy)
      const fastWsInfo = h.webSocketConnections.get('ws-s1-1');
      fastWsInfo.ws.bufferedAmount = 0;

      const session = h.claudeSessions.get('s1');
      session._pendingChunks = ['backpressure test data'];
      session._pendingBytes = 22;
      h._flushSessionOutput('s1');

      assert.strictEqual(h.sentMessages.length, 1, 'Only fast client should receive');
      assert.strictEqual(h.sentMessages[0].wsId, 'ws-s1-1', 'Fast client should be the recipient');
    });

    it('should skip clients that explicitly paused ingress', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 2);
      h.webSocketConnections.get('ws-s1-0')._flowPaused = true;

      const session = h.claudeSessions.get('s1');
      session._pendingChunks = ['flow controlled'];
      session._pendingBytes = 15;
      h._flushSessionOutput('s1');

      assert.deepStrictEqual(h.sentMessages.map(({ wsId }) => wsId), ['ws-s1-1']);
    });
  });

  describe('_flushAndClearOutputTimer', function() {
    it('should flush pending output and clear timer', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      h._throttledOutputBroadcast('s1', 'pending data');
      const session = h.claudeSessions.get('s1');

      assert.notStrictEqual(session._outputFlushTimer, null);
      assert.deepStrictEqual(session._pendingChunks, ['pending data']);

      h._flushAndClearOutputTimer(session, 's1');

      assert.strictEqual(session._outputFlushTimer, null);
      assert.deepStrictEqual(session._pendingChunks, []);
      assert.strictEqual(session._pendingBytes, 0);
      assert.strictEqual(h.sentMessages.length, 1);
    });

    it('should be safe to call when no timer or pending output exists', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);
      const session = h.claudeSessions.get('s1');

      // Should not throw
      h._flushAndClearOutputTimer(session, 's1');
      assert.strictEqual(h.sentMessages.length, 0);
    });

    it('should flush before exit sends pending output before exit message', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      // Simulate output accumulated but not yet flushed
      h._throttledOutputBroadcast('s1', 'final output');
      const session = h.claudeSessions.get('s1');

      // Simulate onExit: flush first, then send exit
      h._flushAndClearOutputTimer(session, 's1');

      // Manually broadcast exit (like server does after flush)
      const exitMsg = JSON.stringify({ type: 'exit', code: 0, signal: null });
      session.connections.forEach(wsId => {
        const wsInfo = h.webSocketConnections.get(wsId);
        if (wsInfo) wsInfo.ws.send(exitMsg);
      });

      // Verify ordering: output comes before exit
      assert.strictEqual(h.sentMessages.length, 2);
      const first = h.sentMessages[0].data.toString('utf8');
      const second = JSON.parse(h.sentMessages[1].data);
      assert.strictEqual(first, 'final output');
      assert.deepStrictEqual(h.sentMessages[0].options, { binary: true, compress: false });
      assert.strictEqual(second.type, 'exit');
    });
  });
});
