'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const realStore = path.join(os.homedir(), '.ai-or-die');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-or-die-test-sessions-'));
const processEvents = [
  'SIGINT',
  'SIGTERM',
  'beforeExit',
  'uncaughtException',
  'unhandledRejection',
  'message',
  'disconnect',
];
let baselineListeners;
const snapshot = snapshotStore(realStore);

process.env.AI_OR_DIE_SESSION_DIR = sandbox;
process.env.AI_OR_DIE_TEST_SESSION_SANDBOX = sandbox;

function snapshotStore(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = [];
  const visit = (current, relative) => {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const rel = path.join(relative, name);
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) visit(absolute, rel);
      else entries.push([rel, stat.size, stat.mtimeMs]);
    }
  };
  visit(dir, '');
  return entries;
}

exports.mochaHooks = {
  beforeAll() {
    baselineListeners = new Map(processEvents.map((event) => [event, process.listenerCount(event)]));
  },
  afterAll() {
    for (const event of processEvents) {
      assert.strictEqual(
        process.listenerCount(event),
        baselineListeners.get(event),
        `process listener count for ${event} must return to the suite baseline`
      );
    }
    assert.deepStrictEqual(
      snapshotStore(realStore),
      snapshot,
      'unit tests must leave the real ~/.ai-or-die store byte-for-byte untouched'
    );
    fs.rmSync(sandbox, { recursive: true, force: true });
  },
};
