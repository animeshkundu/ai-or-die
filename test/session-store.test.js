const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const SessionStore = require('../src/utils/session-store');
const CircularBuffer = require('../src/utils/circular-buffer');

describe('SessionStore', function() {
  let sessionStore;
  let tempDir;

  beforeEach(async function() {
    // Create a temporary directory for test sessions
    tempDir = path.join(__dirname, 'temp-sessions');
    try {
      await fs.mkdir(tempDir, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }

    sessionStore = new SessionStore();
    // Override the default session file path for testing
    sessionStore.storageDir = tempDir;
    sessionStore.sessionsFile = path.join(tempDir, 'test-sessions.json');
  });

  afterEach(async function() {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('saveSessions', function() {
    it('should save sessions to file', async function() {
      const testSessions = new Map([
        ['session1', { id: 'session1', name: 'Test Session', created: new Date() }]
      ]);

      sessionStore.markDirty();
      await sessionStore.saveSessions(testSessions);

      const fileExists = await fs.access(sessionStore.sessionsFile).then(() => true).catch(() => false);
      assert.strictEqual(fileExists, true);
    });
  });

  describe('loadSessions', function() {
    it('should return empty Map when no session file exists', async function() {
      const sessions = await sessionStore.loadSessions();
      assert(sessions instanceof Map);
      assert.strictEqual(sessions.size, 0);
    });

    it('should load sessions from file', async function() {
      // First save some sessions
      const testSessions = new Map([
        ['session1', { id: 'session1', name: 'Test Session', created: new Date() }]
      ]);
      sessionStore.markDirty();
      await sessionStore.saveSessions(testSessions);

      // Then load them
      const loadedSessions = await sessionStore.loadSessions();
      assert(loadedSessions instanceof Map);
      assert.strictEqual(loadedSessions.size, 1);
      assert(loadedSessions.has('session1'));
    });
  });

  describe('dirty-flag', function() {
    it('should skip save when not dirty', async function() {
      const testSessions = new Map([
        ['session1', { id: 'session1', name: 'Test Session', created: new Date() }]
      ]);

      // Do not call markDirty -- save should return early
      const result = await sessionStore.saveSessions(testSessions);
      assert.strictEqual(result, true);

      // File should NOT exist since save was skipped
      const fileExists = await fs.access(sessionStore.sessionsFile).then(() => true).catch(() => false);
      assert.strictEqual(fileExists, false);
    });

    it('should save when dirty', async function() {
      const testSessions = new Map([
        ['session1', { id: 'session1', name: 'Test Session', created: new Date() }]
      ]);

      sessionStore.markDirty();
      const result = await sessionStore.saveSessions(testSessions);
      assert.strictEqual(result, true);

      // File SHOULD exist since dirty flag was set
      const fileExists = await fs.access(sessionStore.sessionsFile).then(() => true).catch(() => false);
      assert.strictEqual(fileExists, true);
    });

    it('should reset dirty after successful save', async function() {
      const testSessions = new Map([
        ['session1', { id: 'session1', name: 'Test Session', created: new Date() }]
      ]);

      sessionStore.markDirty();
      await sessionStore.saveSessions(testSessions);

      // Dirty flag should now be false -- delete the file to prove next save skips
      await fs.unlink(sessionStore.sessionsFile);

      const result = await sessionStore.saveSessions(testSessions);
      assert.strictEqual(result, true);

      // File should NOT exist because save was skipped (not dirty)
      const fileExists = await fs.access(sessionStore.sessionsFile).then(() => true).catch(() => false);
      assert.strictEqual(fileExists, false);
    });
  });

  describe('restart persistence', function() {
    it('should persist wasActive field through save/load cycle', async function() {
      const buf = new CircularBuffer(1000);
      buf.push('line1');

      const testSessions = new Map([
        ['s1', {
          id: 's1',
          name: 'Active Session',
          created: new Date(),
          active: true,
          agent: 'claude',
          outputBuffer: buf
        }]
      ]);

      sessionStore.markDirty();
      await sessionStore.saveSessions(testSessions);

      const loaded = await sessionStore.loadSessions();
      const session = loaded.get('s1');
      assert.strictEqual(session.wasActive, true);
      assert.strictEqual(session.active, false); // active is always false on load
    });

    it('should persist agent field through save/load cycle', async function() {
      const testSessions = new Map([
        ['s1', {
          id: 's1',
          name: 'Claude Session',
          created: new Date(),
          active: true,
          agent: 'claude'
        }]
      ]);

      sessionStore.markDirty();
      await sessionStore.saveSessions(testSessions);

      const loaded = await sessionStore.loadSessions();
      const session = loaded.get('s1');
      assert.strictEqual(session.agent, 'claude');
    });

    it('should persist full 1000-line output buffer', async function() {
      const buf = new CircularBuffer(1000);
      for (let i = 0; i < 1000; i++) {
        buf.push(`line ${i}`);
      }

      const testSessions = new Map([
        ['s1', {
          id: 's1',
          name: 'Big Buffer Session',
          created: new Date(),
          outputBuffer: buf
        }]
      ]);

      sessionStore.markDirty();
      await sessionStore.saveSessions(testSessions);

      const loaded = await sessionStore.loadSessions();
      const session = loaded.get('s1');
      assert.strictEqual(session.outputBuffer.length, 1000);
      assert.strictEqual(session.outputBuffer.slice(-1)[0], 'line 999');
      assert.strictEqual(session.outputBuffer.slice(-1000)[0], 'line 0');
    });

    it('should fix sessionUsage round-trip (not usageData)', async function() {
      const usage = {
        requests: 5,
        inputTokens: 1000,
        outputTokens: 2000,
        cacheTokens: 0,
        totalCost: 0.05,
        models: { 'claude-3': 5 }
      };

      const testSessions = new Map([
        ['s1', {
          id: 's1',
          name: 'Usage Session',
          created: new Date(),
          sessionUsage: usage
        }]
      ]);

      sessionStore.markDirty();
      await sessionStore.saveSessions(testSessions);

      const loaded = await sessionStore.loadSessions();
      const session = loaded.get('s1');
      // sessionUsage should be preserved (not under usageData)
      assert.ok(session.sessionUsage, 'sessionUsage should be defined after load');
      assert.strictEqual(session.sessionUsage.requests, 5);
      assert.strictEqual(session.sessionUsage.inputTokens, 1000);
      assert.strictEqual(session.sessionUsage.totalCost, 0.05);
    });

    it('should save wasActive as false for inactive sessions', async function() {
      const testSessions = new Map([
        ['s1', {
          id: 's1',
          name: 'Inactive Session',
          created: new Date(),
          active: false,
          agent: null
        }]
      ]);

      sessionStore.markDirty();
      await sessionStore.saveSessions(testSessions);

      const loaded = await sessionStore.loadSessions();
      const session = loaded.get('s1');
      assert.strictEqual(session.wasActive, false);
      assert.strictEqual(session.agent, null);
    });

    it('should cap output buffer at 512KB per session', async function() {
      const buf = new CircularBuffer(1000);
      // Each line is ~10KB (well over typical terminal width)
      const bigLine = 'X'.repeat(10 * 1024);
      for (let i = 0; i < 200; i++) {
        buf.push(bigLine); // 200 x 10KB = 2MB total
      }

      const testSessions = new Map([
        ['s1', {
          id: 's1',
          name: 'Big Buffer',
          created: new Date(),
          outputBuffer: buf
        }]
      ]);

      sessionStore.markDirty();
      await sessionStore.saveSessions(testSessions);

      const loaded = await sessionStore.loadSessions();
      const session = loaded.get('s1');
      // Should be capped: 512KB / 10KB per line = ~51 lines max
      assert.ok(session.outputBuffer.length <= 55, `expected <=55 lines but got ${session.outputBuffer.length}`);
      assert.ok(session.outputBuffer.length > 0, 'should have some lines');
    });
  });

  describe('streamed serializer (HOT-10)', function() {
    // HOT-10 replaces the in-process bare JSON.stringify on the save
    // hot path with a per-session-yield streaming builder. The
    // serialized output MUST be byte-identical to bare JSON.stringify
    // so the on-disk format stays compatible and any external
    // consumer of `sessions.json` keeps working.

    it('produces byte-identical output to JSON.stringify for the standard envelope shape', async function() {
      const data = {
        version: '1.0',
        savedAt: new Date('2026-05-28T05:00:00Z').toISOString(),
        sessions: [
          { id: 's1', name: 'A', outputBuffer: ['line1', 'line2'], lastAccessed: 100 },
          { id: 's2', name: 'B', outputBuffer: ['x'.repeat(2048)], lastAccessed: 200 },
          { id: 's3', name: 'C', outputBuffer: [], lastAccessed: 300 },
        ],
      };
      const streamed = await sessionStore._serializeDataStreamed(data);
      const bare = JSON.stringify(data);
      assert.strictEqual(streamed, bare,
        'streamed serializer must produce byte-identical output to JSON.stringify');
    });

    it('produces parseable output that round-trips back to the input data', async function() {
      const data = {
        version: '1.0',
        savedAt: new Date().toISOString(),
        sessions: Array.from({ length: 25 }, (_, i) => ({
          id: `s${i}`,
          name: `Session ${i}`,
          outputBuffer: [`line a ${i}`, `line b ${i}`, `unicode: ${String.fromCodePoint(0x1f600 + (i % 16))}`],
          // Edge-case characters that JSON encoding must escape:
          // quote, backslash, newline, tab, control char.
          edge: `quote:" backslash:\\ newline:\n tab:\t bell:`,
        })),
      };
      const streamed = await sessionStore._serializeDataStreamed(data);
      const parsed = JSON.parse(streamed);
      assert.deepStrictEqual(parsed, JSON.parse(JSON.stringify(data)),
        'streamed output should parse back to the same structure');
    });

    it('falls back to bare JSON.stringify when data.sessions is missing or not an array', async function() {
      const noSessions = { version: '1.0', savedAt: 'x', sessions: undefined };
      const out1 = await sessionStore._serializeDataStreamed(noSessions);
      assert.strictEqual(out1, JSON.stringify(noSessions),
        'missing sessions should fall back to bare stringify');

      const objectSessions = { version: '1.0', savedAt: 'x', sessions: { not: 'array' } };
      const out2 = await sessionStore._serializeDataStreamed(objectSessions);
      assert.strictEqual(out2, JSON.stringify(objectSessions),
        'non-array sessions should fall back to bare stringify');
    });

    it('handles an empty sessions array', async function() {
      const data = { version: '1.0', savedAt: 'x', sessions: [] };
      const streamed = await sessionStore._serializeDataStreamed(data);
      assert.strictEqual(streamed, JSON.stringify(data));
    });

    it('relies on JSON.stringify producing the exact "sessions":[] marker (no whitespace)', function() {
      // HOT-10 follow-up — invariant guard flagged by SUP-DISK's
      // integration review. The streaming serializer's envelope-splice
      // strategy depends on `JSON.stringify(envelope)` (no indent
      // argument) producing literally `"sessions":[]` so the splice
      // marker matches. If a future caller threads an indent argument
      // through somewhere upstream (e.g.
      // `JSON.stringify(envelope, null, 2)`), the marker becomes
      // `"sessions": []` with a space and the splice silently falls
      // back to bare `JSON.stringify` — correctness preserved, but the
      // perf win disappears without warning.
      //
      // This test pins down the marker shape so a Node.js / V8 change
      // to default JSON.stringify formatting, OR an accidental
      // indent-arg slip, surfaces as a hard failure rather than a
      // silent perf cliff.
      assert.strictEqual(JSON.stringify({ sessions: [] }), '{"sessions":[]}',
        'JSON.stringify default format produced unexpected whitespace — ' +
        'the streamed serializer envelope-splice marker is invalidated');
      assert.ok(JSON.stringify({ a: 1, sessions: [], b: 2 }).includes('"sessions":[]'),
        'embedded envelope should still contain the literal marker');
    });
  });
});
