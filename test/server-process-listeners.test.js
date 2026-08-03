'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

describe('server process-listener ownership', function () {
  it('removes every process listener it registers when closed', async function () {
    const events = ['SIGINT', 'SIGTERM', 'beforeExit', 'uncaughtException', 'unhandledRejection'];
    const before = new Map(events.map((event) => [event, process.listenerCount(event)]));
    const originalLifecycle = process.env.npm_lifecycle_event;
    const originalIt = global.it;
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-or-die-listeners-'));
    let server;
    try {
      delete process.env.npm_lifecycle_event;
      delete global.it;
      server = new ClaudeCodeWebServer({
        stt: false,
        stickyNotes: false,
        noAuth: true,
        sessionStoreOptions: { storageDir },
      });
    } finally {
      if (originalLifecycle === undefined) delete process.env.npm_lifecycle_event;
      else process.env.npm_lifecycle_event = originalLifecycle;
      global.it = originalIt;
    }

    for (const event of events) {
      assert.strictEqual(process.listenerCount(event), before.get(event) + 1);
    }
    await server.close();
    for (const event of events) {
      assert.strictEqual(process.listenerCount(event), before.get(event));
    }
    fs.rmSync(storageDir, { recursive: true, force: true });
  });
});
