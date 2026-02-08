const assert = require('assert');

// Minimal mock of the output coalescing logic extracted from server.js.
// We can't instantiate ClaudeCodeWebServer in unit tests (requires express,
// node-pty, etc.), so we test the coalescing behavior with a lightweight
// harness that mirrors the server's session/connection structure.

const WebSocket = { OPEN: 1 };

class OutputThrottleHarness {
  constructor() {
    this.claudeSessions = new Map();
    this.webSocketConnections = new Map();
    this.sentMessages = []; // Track what was sent
  }

  // Mirrors server.js _throttledOutputBroadcast
  _throttledOutputBroadcast(sessionId, data) {
    const session = this.claudeSessions.get(sessionId);
    if (!session) return;

    if (!session._pendingOutput) {
      session._pendingOutput = '';
    }
    session._pendingOutput += data;

    if (!session._outputFlushTimer) {
      session._outputFlushTimer = setTimeout(() => {
        session._outputFlushTimer = null;
        this._flushSessionOutput(sessionId);
      }, 16);
      if (session._outputFlushTimer.unref) {
        session._outputFlushTimer.unref();
      }
    }
  }

  // Mirrors server.js _flushSessionOutput
  _flushSessionOutput(sessionId) {
    const session = this.claudeSessions.get(sessionId);
    if (!session || !session._pendingOutput) return;

    const pending = session._pendingOutput;
    session._pendingOutput = '';

    if (session.connections.size === 0) return;

    const msg = JSON.stringify({ type: 'output', data: pending });
    session.connections.forEach(wsId => {
      const wsInfo = this.webSocketConnections.get(wsId);
      if (wsInfo &&
          wsInfo.claudeSessionId === sessionId &&
          wsInfo.ws.readyState === WebSocket.OPEN) {
        wsInfo.ws.send(msg);
      }
    });
  }

  // Mirrors server.js _flushAndClearOutputTimer
  _flushAndClearOutputTimer(session, sessionId) {
    if (session._outputFlushTimer) {
      clearTimeout(session._outputFlushTimer);
      session._outputFlushTimer = null;
    }
    if (session._pendingOutput) {
      this._flushSessionOutput(sessionId);
    }
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
          send(data) { sentRef.push({ wsId, data }); }
        }
      });
    }
    this.claudeSessions.set(sessionId, {
      connections,
      _pendingOutput: '',
      _outputFlushTimer: null,
    });
  }
}

describe('Output Throttle', function() {

  describe('_throttledOutputBroadcast', function() {
    it('should accumulate output in _pendingOutput', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      h._throttledOutputBroadcast('s1', 'hello');
      h._throttledOutputBroadcast('s1', ' world');

      const session = h.claudeSessions.get('s1');
      assert.strictEqual(session._pendingOutput, 'hello world');

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

        const parsed = JSON.parse(h.sentMessages[0].data);
        assert.strictEqual(parsed.type, 'output');
        // All 10 lines should be in one message
        for (let i = 0; i < 10; i++) {
          assert.ok(parsed.data.includes(`line${i}\n`), `Missing line${i}`);
        }
        done();
      }, 30);
    });

    it('should send to all connected clients with one JSON.stringify', function(done) {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 3); // 3 clients

      h._throttledOutputBroadcast('s1', 'shared data');

      setTimeout(() => {
        assert.strictEqual(h.sentMessages.length, 3, 'Expected 3 sends (one per client)');

        // All 3 clients should receive the same serialized string
        const firstMsg = h.sentMessages[0].data;
        assert.ok(h.sentMessages.every(m => m.data === firstMsg),
          'All clients should receive identical pre-serialized message');
        done();
      }, 30);
    });
  });

  describe('_flushSessionOutput', function() {
    it('should skip broadcast when no clients connected', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 0); // Zero clients

      const session = h.claudeSessions.get('s1');
      session._pendingOutput = 'orphaned data';

      h._flushSessionOutput('s1');

      assert.strictEqual(h.sentMessages.length, 0, 'Should not send to empty connections');
      assert.strictEqual(session._pendingOutput, '', 'Should clear pending even with no clients');
    });

    it('should clear _pendingOutput after flush', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      const session = h.claudeSessions.get('s1');
      session._pendingOutput = 'some data';

      h._flushSessionOutput('s1');

      assert.strictEqual(session._pendingOutput, '');
    });

    it('should do nothing when _pendingOutput is empty', function() {
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
      session._pendingOutput = 'test data';
      h._flushSessionOutput('s1');

      assert.strictEqual(h.sentMessages.length, 1, 'Only open client should receive');
      assert.strictEqual(h.sentMessages[0].wsId, 'ws-s1-1');
    });
  });

  describe('_flushAndClearOutputTimer', function() {
    it('should flush pending output and clear timer', function() {
      const h = new OutputThrottleHarness();
      h.addSession('s1', 1);

      h._throttledOutputBroadcast('s1', 'pending data');
      const session = h.claudeSessions.get('s1');

      assert.notStrictEqual(session._outputFlushTimer, null);
      assert.strictEqual(session._pendingOutput, 'pending data');

      h._flushAndClearOutputTimer(session, 's1');

      assert.strictEqual(session._outputFlushTimer, null);
      assert.strictEqual(session._pendingOutput, '');
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
      const first = JSON.parse(h.sentMessages[0].data);
      const second = JSON.parse(h.sentMessages[1].data);
      assert.strictEqual(first.type, 'output');
      assert.strictEqual(first.data, 'final output');
      assert.strictEqual(second.type, 'exit');
    });
  });
});
