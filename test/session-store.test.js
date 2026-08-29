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

    sessionStore = new SessionStore({ storageDir: tempDir });
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

    const invalidStructures = [
      ['object sessions', '{"sessions": {}}'],
      ['string sessions', '{"sessions": "x"}'],
      ['array root', '[]'],
      ['null root', 'null'],
      ['numeric sessions', '{"sessions": 3}'],
    ];

    for (const [name, bytes] of invalidStructures) {
      it(`preserves exact bytes for invalid structure: ${name}`, async function () {
        await fs.writeFile(sessionStore.sessionsFile, bytes);

        const loaded = await sessionStore.loadSessions();
        const files = await fs.readdir(tempDir);
        const backups = files.filter((file) => (
          file.startsWith(`${path.basename(sessionStore.sessionsFile)}.corrupted.`)
        ));

        assert(loaded instanceof Map);
        assert.strictEqual(loaded.size, 0);
        assert.strictEqual(backups.length, 1);
        const backupBytes = await fs.readFile(path.join(tempDir, backups[0]));
        assert.strictEqual(Buffer.compare(backupBytes, Buffer.from(bytes)), 0);
        await assert.rejects(fs.access(sessionStore.sessionsFile), { code: 'ENOENT' });
      });
    }

    it('preserves corrupt JSON through the same byte-exact backup path', async function () {
      const bytes = Buffer.from('{"sessions":[');
      await fs.writeFile(sessionStore.sessionsFile, bytes);

      const loaded = await sessionStore.loadSessions();
      const files = await fs.readdir(tempDir);
      const backup = files.find((file) => (
        file.startsWith(`${path.basename(sessionStore.sessionsFile)}.corrupted.`)
      ));

      assert.strictEqual(loaded.size, 0);
      assert.ok(backup);
      assert.strictEqual(
        Buffer.compare(await fs.readFile(path.join(tempDir, backup)), bytes),
        0
      );
    });

    it('detects file growth after the initial stat and keeps the read bounded', async function () {
      sessionStore.maxSafeLoadBytes = 256;
      const initial = Buffer.from('{"sessions":[]}');
      const growth = Buffer.alloc(2048, 'x');
      await fs.writeFile(sessionStore.sessionsFile, initial);
      const originalOpen = fs.open;
      const reads = [];
      let grew = false;
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        const originalRead = handle.read.bind(handle);
        handle.read = async (buffer, offset, length, position) => {
          reads.push({ length, position });
          if (!grew) {
            grew = true;
            await fs.appendFile(sessionStore.sessionsFile, growth);
          }
          return originalRead(buffer, offset, length, position);
        };
        return handle;
      };

      try {
        const loaded = await sessionStore.loadSessions();
        const files = await fs.readdir(tempDir);
        const backup = files.find((file) => (
          file.startsWith(`${path.basename(sessionStore.sessionsFile)}.oversized.`)
        ));
        assert.strictEqual(loaded.size, 0);
        assert.ok(backup);
        assert.ok(reads.length > 0);
        assert.ok(reads.reduce((total, read) => total + read.length, 0) <= sessionStore.maxSafeLoadBytes + 1);
        assert.strictEqual(
          Buffer.compare(await fs.readFile(path.join(tempDir, backup)), Buffer.concat([initial, growth])),
          0
        );
        await assert.rejects(fs.access(sessionStore.sessionsFile), { code: 'ENOENT' });
      } finally {
        fs.open = originalOpen;
      }
    });

    it('preserves oversized files under .oversized without reading/parsing the whole file', async function () {
      sessionStore.maxSafeLoadBytes = 256;
      const bytes = Buffer.from('{"sessions":[' + 'x'.repeat(2048));
      await fs.writeFile(sessionStore.sessionsFile, bytes);

      const originalOpen = fs.open;
      let handleReadFileCalls = 0;
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        const originalHandleReadFile = handle.readFile.bind(handle);
        handle.readFile = async (...readArgs) => {
          handleReadFileCalls++;
          return originalHandleReadFile(...readArgs);
        };
        return handle;
      };

      try {
        const loaded = await sessionStore.loadSessions();
        const files = await fs.readdir(tempDir);
        const backup = files.find((file) => (
          file.startsWith(`${path.basename(sessionStore.sessionsFile)}.oversized.`)
        ));

        assert.strictEqual(loaded.size, 0);
        assert.ok(backup);
        assert.strictEqual(handleReadFileCalls, 0, 'oversized loads must not read the whole file');
        assert.strictEqual(
          Buffer.compare(await fs.readFile(path.join(tempDir, backup)), bytes),
          0
        );
        await assert.rejects(fs.access(sessionStore.sessionsFile), { code: 'ENOENT' });
      } finally {
        fs.open = originalOpen;
      }
    });

    it('copies oversized data to the backup when rename fails', async function () {
      sessionStore.maxSafeLoadBytes = 256;
      const bytes = Buffer.from('{"sessions":[' + 'x'.repeat(2048));
      await fs.writeFile(sessionStore.sessionsFile, bytes);
      const originalRename = fs.rename;
      fs.rename = async () => {
        const error = new Error('rename unavailable');
        error.code = 'EACCES';
        throw error;
      };

      try {
        const loaded = await sessionStore.loadSessions();
        const files = await fs.readdir(tempDir);
        const backup = files.find((file) => (
          file.startsWith(`${path.basename(sessionStore.sessionsFile)}.oversized.`)
        ));
        assert.strictEqual(loaded.size, 0);
        assert.ok(backup);
        assert.strictEqual(
          Buffer.compare(await fs.readFile(path.join(tempDir, backup)), bytes),
          0
        );
        await assert.rejects(fs.access(sessionStore.sessionsFile), { code: 'ENOENT' });
      } finally {
        fs.rename = originalRename;
      }
    });

    it('copies invalid data to the backup when rename fails', async function () {
      const bytes = Buffer.from('{"sessions": "x"}');
      await fs.writeFile(sessionStore.sessionsFile, bytes);
      const originalRename = fs.rename;
      fs.rename = async () => {
        const error = new Error('rename unavailable');
        error.code = 'EACCES';
        throw error;
      };

      try {
        const loaded = await sessionStore.loadSessions();
        const files = await fs.readdir(tempDir);
        const backup = files.find((file) => (
          file.startsWith(`${path.basename(sessionStore.sessionsFile)}.corrupted.`)
        ));
        assert.strictEqual(loaded.size, 0);
        assert.ok(backup);
        assert.strictEqual(
          Buffer.compare(await fs.readFile(path.join(tempDir, backup)), bytes),
          0
        );
        await assert.rejects(fs.access(sessionStore.sessionsFile), { code: 'ENOENT' });
      } finally {
        fs.rename = originalRename;
      }
    });

    it('blocks saves when fallback unlink fails after an exact copy', async function () {
      const bytes = Buffer.from('{"sessions": "x"}');
      await fs.writeFile(sessionStore.sessionsFile, bytes);
      const originalRename = fs.rename;
      const originalUnlink = fs.unlink;
      fs.rename = async () => {
        const error = new Error('rename unavailable');
        error.code = 'EACCES';
        throw error;
      };
      fs.unlink = async (file) => {
        if (file === sessionStore.sessionsFile) {
          const error = new Error('remove unavailable');
          error.code = 'EACCES';
          throw error;
        }
        return originalUnlink(file);
      };

      try {
        const loaded = await sessionStore.loadSessions();
        const files = await fs.readdir(tempDir);
        const backup = files.find((file) => (
          file.startsWith(`${path.basename(sessionStore.sessionsFile)}.corrupted.`)
        ));
        assert.strictEqual(loaded.size, 0);
        assert.ok(backup);
        assert.strictEqual(
          Buffer.compare(await fs.readFile(path.join(tempDir, backup)), bytes),
          0
        );
        assert.strictEqual(
          Buffer.compare(await fs.readFile(sessionStore.sessionsFile), bytes),
          0
        );
        assert.strictEqual(sessionStore._saveBlockedReason.removeError.code, 'EACCES');
        assert.strictEqual(sessionStore._lastSaveError.code, 'ESESSIONBACKUPFAILED');

        sessionStore.markDirty();
        assert.strictEqual(await sessionStore.saveSessions(new Map()), false);
        assert.strictEqual(sessionStore._lastSaveError.code, 'ESESSIONBACKUPFAILED');
      } finally {
        fs.rename = originalRename;
        fs.unlink = originalUnlink;
      }
    });

    it('blocks saves without altering bytes when every backup method fails', async function () {
      const bytes = Buffer.from('{"sessions": "x"}');
      await fs.writeFile(sessionStore.sessionsFile, bytes);
      const originalRename = fs.rename;
      const originalCopyFile = fs.copyFile;
      const originalConsoleError = console.error;
      const errors = [];
      fs.rename = async () => {
        const error = new Error('rename unavailable');
        error.code = 'EACCES';
        throw error;
      };
      fs.copyFile = async () => {
        const error = new Error('copy unavailable');
        error.code = 'EACCES';
        throw error;
      };
      console.error = (...args) => errors.push(args.join(' '));

      try {
        const loaded = await sessionStore.loadSessions();
        assert.strictEqual(loaded.size, 0);
        assert.ok(sessionStore._saveBlockedReason);

        sessionStore.markDirty();
        const saved = await sessionStore.saveSessions(new Map());
        assert.strictEqual(saved, false);
        assert.strictEqual(await sessionStore.saveSessions(new Map()), false);
        assert.strictEqual(sessionStore._lastSaveError.code, 'ESESSIONBACKUPFAILED');
        assert.strictEqual(sessionStore._saveFailureCount, 0);
        assert.strictEqual(
          Buffer.compare(await fs.readFile(sessionStore.sessionsFile), bytes),
          0
        );

        const blockedSaveWarnings = errors.filter((message) => (
          message.includes('Blocked session save')
        ));
        assert.strictEqual(blockedSaveWarnings.length, 1);
      } finally {
        fs.rename = originalRename;
        fs.copyFile = originalCopyFile;
        console.error = originalConsoleError;
      }
    });

    it('clears the backup-failure latch when the protected file is removed', async function () {
      const bytes = Buffer.from('{"sessions": "x"}');
      await fs.writeFile(sessionStore.sessionsFile, bytes);
      const originalRename = fs.rename;
      const originalCopyFile = fs.copyFile;
      fs.rename = async () => { throw new Error('rename unavailable'); };
      fs.copyFile = async () => { throw new Error('copy unavailable'); };

      try {
        await sessionStore.loadSessions();
      } finally {
        fs.rename = originalRename;
        fs.copyFile = originalCopyFile;
      }

      await fs.unlink(sessionStore.sessionsFile);
      sessionStore.markDirty();
      assert.strictEqual(await sessionStore.saveSessions(new Map()), true);
      assert.strictEqual(sessionStore._saveBlockedReason, null);
    });

    it('clears the backup-failure latch after a later valid load', async function () {
      await fs.writeFile(sessionStore.sessionsFile, '{"sessions": "x"}');
      const originalRename = fs.rename;
      const originalCopyFile = fs.copyFile;
      fs.rename = async () => { throw new Error('rename unavailable'); };
      fs.copyFile = async () => { throw new Error('copy unavailable'); };

      try {
        await sessionStore.loadSessions();
      } finally {
        fs.rename = originalRename;
        fs.copyFile = originalCopyFile;
      }

      await fs.writeFile(sessionStore.sessionsFile, JSON.stringify({
        savedAt: new Date().toISOString(),
        sessions: [],
      }));
      await sessionStore.loadSessions();
      assert.strictEqual(sessionStore._saveBlockedReason, null);
    });

    it('clears the backup-failure latch after clearOldSessions removes the file', async function () {
      await fs.writeFile(sessionStore.sessionsFile, '{"sessions": "x"}');
      const originalRename = fs.rename;
      const originalCopyFile = fs.copyFile;
      fs.rename = async () => { throw new Error('rename unavailable'); };
      fs.copyFile = async () => { throw new Error('copy unavailable'); };

      try {
        await sessionStore.loadSessions();
      } finally {
        fs.rename = originalRename;
        fs.copyFile = originalCopyFile;
      }

      assert.strictEqual(await sessionStore.clearOldSessions(), true);
      assert.strictEqual(sessionStore._saveBlockedReason, null);
    });

    it('does not preserve intentionally expired session data as corruption', async function () {
      await fs.writeFile(sessionStore.sessionsFile, JSON.stringify({
        savedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        sessions: [{ id: 'expired' }],
      }));

      const loaded = await sessionStore.loadSessions();
      const files = await fs.readdir(tempDir);
      assert.strictEqual(loaded.size, 0);
      assert.strictEqual(files.some((file) => file.includes('.corrupted.')), false);
    });

    it('clears metadata cache when loading an empty or whitespace-only file', async function () {
      await fs.writeFile(sessionStore.sessionsFile, JSON.stringify({
        version: '1.0',
        savedAt: new Date().toISOString(),
        sessions: [{ id: 'cached', outputBuffer: [] }],
      }));
      await sessionStore.loadSessions();
      assert.ok(sessionStore._sessionMetadataCache, 'warm cache before empty-load check');

      await fs.writeFile(sessionStore.sessionsFile, '   \n\t   ');
      const loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.size, 0);
      assert.strictEqual(sessionStore._sessionMetadataCache, null);
    });
  });

  describe('file identity helpers', function() {
    it('stores dev and ino identities as strings', function() {
      const identity = sessionStore._fileIdentityFromStats({
        size: 1,
        mtimeMs: 2,
        dev: 9007199254740993n,
        ino: 9007199254740995n,
        ctimeMs: 3,
      });
      assert.strictEqual(identity.dev, '9007199254740993');
      assert.strictEqual(identity.ino, '9007199254740995');
      assert.strictEqual(typeof identity.dev, 'string');
      assert.strictEqual(typeof identity.ino, 'string');
    });
  });

  describe('getSessionMetadata', function() {
    it('returns cached metadata after a successful save without rereading sessions.json', async function() {
      const testSessions = new Map([
        ['session1', { id: 'session1', name: 'A', created: new Date() }],
        ['session2', { id: 'session2', name: 'B', created: new Date() }],
      ]);

      sessionStore.markDirty();
      await sessionStore.saveSessions(testSessions);

      const originalReadFile = fs.readFile;
      let readAttempts = 0;
      fs.readFile = async () => {
        readAttempts++;
        throw new Error('getSessionMetadata should use cached save metadata');
      };

      try {
        const metadata = await sessionStore.getSessionMetadata();
        assert.strictEqual(metadata.exists, true);
        assert.strictEqual(metadata.sessionCount, 2);
        assert.strictEqual(metadata.version, '1.0');
        assert.ok(typeof metadata.savedAt === 'string' && metadata.savedAt.length > 0);
        assert.ok(metadata.fileSize > 0);
        assert.strictEqual(readAttempts, 0);
      } finally {
        fs.readFile = originalReadFile;
      }
    });

    it('returns cached metadata after a successful load without rereading sessions.json', async function() {
      const envelope = {
        version: '1.0',
        savedAt: new Date().toISOString(),
        sessions: [
          { id: 'loaded-1', outputBuffer: [] },
          { id: 'loaded-2', outputBuffer: [] },
        ],
      };
      await fs.writeFile(sessionStore.sessionsFile, JSON.stringify(envelope));

      const loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.size, 2);

      const originalReadFile = fs.readFile;
      let readAttempts = 0;
      fs.readFile = async () => {
        readAttempts++;
        throw new Error('getSessionMetadata should use cached load metadata');
      };

      try {
        const metadata = await sessionStore.getSessionMetadata();
        assert.strictEqual(metadata.exists, true);
        assert.strictEqual(metadata.savedAt, envelope.savedAt);
        assert.strictEqual(metadata.sessionCount, 2);
        assert.strictEqual(metadata.version, '1.0');
        assert.ok(metadata.fileSize > 0);
        assert.strictEqual(readAttempts, 0);
      } finally {
        fs.readFile = originalReadFile;
      }
    });

    it('parses a bounded small file when cache is cold', async function() {
      const envelope = {
        version: '1.0',
        savedAt: '2026-07-01T00:00:00.000Z',
        sessions: [{ id: 'small', outputBuffer: [] }],
      };
      await fs.writeFile(sessionStore.sessionsFile, JSON.stringify(envelope));

      const metadata = await sessionStore.getSessionMetadata();
      assert.strictEqual(metadata.exists, true);
      assert.strictEqual(metadata.savedAt, envelope.savedAt);
      assert.strictEqual(metadata.sessionCount, 1);
      assert.strictEqual(metadata.version, '1.0');
      assert.ok(metadata.fileSize > 0);
    });

    it('invalidates stale cache on same-size atomic replacement', async function () {
      const firstEnvelope = {
        version: '1.0',
        savedAt: '2026-07-01T00:00:00.000Z',
        sessions: [{ id: 'a', outputBuffer: [] }],
      };
      const secondEnvelope = {
        version: '1.0',
        savedAt: '2026-07-02T00:00:00.000Z',
        sessions: [{ id: 'b', outputBuffer: [] }],
      };
      const firstBytes = JSON.stringify(firstEnvelope);
      const secondBytes = JSON.stringify(secondEnvelope);
      assert.strictEqual(
        Buffer.byteLength(firstBytes, 'utf8'),
        Buffer.byteLength(secondBytes, 'utf8'),
        'test setup requires equal-size replacements'
      );

      await fs.writeFile(sessionStore.sessionsFile, firstBytes);
      const warm = await sessionStore.getSessionMetadata();
      assert.strictEqual(warm.savedAt, firstEnvelope.savedAt);

      const priorStats = await fs.stat(sessionStore.sessionsFile);
      const replacement = `${sessionStore.sessionsFile}.replace`;
      await fs.writeFile(replacement, secondBytes);
      await fs.rename(replacement, sessionStore.sessionsFile);
      const priorMtime = new Date(priorStats.mtimeMs);
      await fs.utimes(sessionStore.sessionsFile, priorMtime, priorMtime);

      const metadata = await sessionStore.getSessionMetadata();
      assert.strictEqual(metadata.savedAt, secondEnvelope.savedAt);
      assert.strictEqual(metadata.sessionCount, 1);
    });

    it('uses a bounded handle read and skips parse when fallback bytes exceed the cap', async function () {
      const oversized = '{"version":"1.0","savedAt":"x","sessions":[],"padding":"' + 'x'.repeat(70 * 1024) + '"}';
      await fs.writeFile(sessionStore.sessionsFile, oversized);

      const originalOpen = fs.open;
      const originalParse = JSON.parse;
      const readLengths = [];
      let parseAttempts = 0;

      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          readLengths.push(readArgs[2]);
          return originalRead(...readArgs);
        };
        return handle;
      };
      JSON.parse = (...args) => {
        parseAttempts++;
        return originalParse(...args);
      };

      try {
        const metadata = await sessionStore.getSessionMetadata();
        assert.strictEqual(metadata.exists, true);
        assert.strictEqual(metadata.savedAt, null);
        assert.strictEqual(metadata.sessionCount, null);
        assert.strictEqual(metadata.version, null);
        assert.ok(readLengths.length >= 1, 'bounded fallback should perform one handle.read');
        assert.ok(readLengths.every((len) => len === 64 * 1024 + 1));
        assert.strictEqual(parseAttempts, 0, 'oversized fallback bytes must never be parsed');
      } finally {
        fs.open = originalOpen;
        JSON.parse = originalParse;
      }
    });

    it('returns exists:true for a large invalid file without reading or parsing the whole file', async function() {
      const oversizedInvalid = '{' + 'x'.repeat(70 * 1024);
      await fs.writeFile(sessionStore.sessionsFile, oversizedInvalid);

      const originalReadFile = fs.readFile;
      let readAttempts = 0;
      fs.readFile = async (...args) => {
        readAttempts++;
        return originalReadFile.apply(fs, args);
      };

      try {
        const metadata = await sessionStore.getSessionMetadata();
        assert.strictEqual(metadata.exists, true);
        assert.strictEqual(metadata.savedAt, null);
        assert.strictEqual(metadata.sessionCount, null);
        assert.strictEqual(metadata.version, null);
        assert.strictEqual(metadata.fileSize, Buffer.byteLength(oversizedInvalid, 'utf8'));
        assert.strictEqual(readAttempts, 0, 'large metadata path must avoid fs.readFile entirely');
      } finally {
        fs.readFile = originalReadFile;
      }
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
