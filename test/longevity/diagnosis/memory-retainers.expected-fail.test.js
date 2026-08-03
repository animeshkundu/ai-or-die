'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');

const { ArtifactReviewStore } = require('../../../src/artifact-review');
const StickyNoteSummarizer = require('../../../src/sticky-note-summarizer');
const { VSCodeTunnelManager } = require('../../../src/vscode-tunnel');
const {
  closeProcServer,
  diagnosticRequest,
  startProcServer,
} = require('../harness/proc-controller');
const { createThenDisconnect } = require('../harness/memory-diagnosis');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = 12345;
  }

  kill() {
    process.nextTick(() => this.emit('exit', 0));
  }
}

describe('memory diagnosis expected-red characterizations', function () {
  this.timeout(180000);

  it('bounds retained live sessions after create/disconnect churn', async function () {
    const controller = await startProcServer();
    try {
      for (let i = 0; i < 100; i++) {
        await createThenDisconnect(controller.wsUrl, i);
      }
      const response = await diagnosticRequest(controller, '/api/_diag/gc', {
        method: 'POST',
        body: {},
      });
      assert.strictEqual(response.statusCode, 200);
      assert(
        response.body.sessions.total <= 50,
        `expected a bounded live-session count <= 50, retained ${response.body.sessions.total}`,
      );
    } finally {
      await closeProcServer(controller);
    }
  });

  it('releases an artifact review when end() completes', function () {
    const store = new ArtifactReviewStore();
    store.open('review-1', __filename);
    store.end('review-1');
    assert.strictEqual(store._reviews.size, 0, 'ended review remains strongly held by _reviews');
  });

  it('bounds artifact chat independently of the replay-event cap', function () {
    const store = new ArtifactReviewStore();
    store.open('review-chat', __filename);
    for (let i = 0; i < 500; i++) store.addAgentReply('review-chat', `reply-${i}`);
    const review = store.get('review-chat');
    assert(review.events.length <= 200, 'test precondition: replay events are capped');
    assert(
      review.chat.length <= 200,
      `chat bypasses the replay cap and retained ${review.chat.length} entries`,
    );
  });

  it('bounds code serve-web stdout retained by its data-listener closure', async function () {
    const children = [];
    const manager = new VSCodeTunnelManager({
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    await manager._initPromise;
    manager._command = 'fake-code';
    manager._available = true;
    const sessionId = 'vscode-output-retainer';
    const tunnel = {
      serverProcess: null,
      tunnelProcess: null,
      _loginProcess: null,
      localPort: 19191,
      connectionToken: 'token',
      localUrl: null,
      publicUrl: null,
      tunnelId: sessionId,
      status: 'starting',
      sessionId,
      workingDir: process.cwd(),
      retryCount: 0,
      stopping: false,
      _lastSpawnTime: null,
      _totalRestarts: 0,
      _stabilityTimer: null,
      _restartDelayTimer: null,
      _restartDelayResolve: null,
      _whichDied: null,
    };
    manager.tunnels.set(sessionId, tunnel);

    const started = manager._spawnServer(sessionId);
    const child = children[0];
    child.stdout.emit('data', Buffer.from('Web UI available at http://localhost:19191\n'));
    await started;
    for (let i = 0; i < 8; i++) child.stdout.emit('data', Buffer.alloc(64 * 1024, 0x78));

    assert(
      tunnel._diagnosticServerStdoutChars <= 64 * 1024,
      `stdout closure retained ${tunnel._diagnosticServerStdoutChars} chars`,
    );
  });

  it('bounds pending JSONL text when the sticky-note engine is unavailable', function () {
    const transcript = {
      dispose() {},
      newLineCount() { return 0; },
      resize() {},
      snapshot() { return Promise.resolve(''); },
      write() {},
    };
    const summarizer = new StickyNoteSummarizer({
      engine: {
        isReady: () => false,
        getStatus: () => 'unavailable',
      },
      createTranscript: () => transcript,
      timers: {
        set: () => ({ id: 1 }),
        clear: () => {},
      },
    });
    summarizer.enable('sticky-unavailable');
    for (let i = 0; i < 100; i++) {
      summarizer.feedTurns('sticky-unavailable', 'x'.repeat(1024));
    }
    summarizer._attempt('sticky-unavailable', 'turn');
    const retained = Buffer.byteLength(
      summarizer._states.get('sticky-unavailable').pendingText,
      'utf8',
    );
    summarizer.cancel('sticky-unavailable');
    assert(retained <= 8 * 1024, `unavailable engine retained ${retained} pending-text bytes`);
  });
});
