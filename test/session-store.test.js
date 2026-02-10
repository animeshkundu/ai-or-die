const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const SessionStore = require('../src/utils/session-store');

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
});
