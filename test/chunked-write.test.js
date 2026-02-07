const assert = require('assert');
const BaseBridge = require('../src/base-bridge');
const { PTY_WRITE_CHUNK_SIZE, PTY_WRITE_CHUNK_DELAY_MS } = require('../src/base-bridge');

describe('BaseBridge chunked sendInput', function() {
  let bridge;
  let writes;
  let mockSession;

  beforeEach(function() {
    bridge = new BaseBridge('test', {
      commandPaths: { linux: [], win32: [] },
      defaultCommand: 'echo'
    });
    writes = [];
    mockSession = {
      process: { write: (data) => writes.push(data) },
      workingDir: '/tmp',
      created: new Date(),
      active: true,
      killTimeout: null,
      writeQueue: Promise.resolve()
    };
    bridge.sessions.set('test-session', mockSession);
  });

  describe('constants', function() {
    it('should export PTY_WRITE_CHUNK_SIZE as 4096', function() {
      assert.strictEqual(PTY_WRITE_CHUNK_SIZE, 4096);
    });

    it('should export PTY_WRITE_CHUNK_DELAY_MS as 10', function() {
      assert.strictEqual(PTY_WRITE_CHUNK_DELAY_MS, 10);
    });
  });

  describe('small input', function() {
    it('should write small data in a single write call', async function() {
      await bridge.sendInput('test-session', 'hello');
      assert.strictEqual(writes.length, 1);
      assert.strictEqual(writes[0], 'hello');
    });

    it('should write data exactly at chunk size in a single call', async function() {
      const data = 'x'.repeat(PTY_WRITE_CHUNK_SIZE);
      await bridge.sendInput('test-session', data);
      assert.strictEqual(writes.length, 1);
      assert.strictEqual(writes[0].length, PTY_WRITE_CHUNK_SIZE);
    });
  });

  describe('large input chunking', function() {
    it('should chunk 10KB data into correct pieces', async function() {
      this.timeout(5000);
      const data = 'x'.repeat(10240);
      await bridge.sendInput('test-session', data);
      assert.strictEqual(writes.length, 3);
      assert.strictEqual(writes[0].length, 4096);
      assert.strictEqual(writes[1].length, 4096);
      assert.strictEqual(writes[2].length, 2048);
      assert.strictEqual(writes.join(''), data);
    });

    it('should chunk data just over chunk size into two pieces', async function() {
      this.timeout(5000);
      const data = 'a'.repeat(PTY_WRITE_CHUNK_SIZE + 1);
      await bridge.sendInput('test-session', data);
      assert.strictEqual(writes.length, 2);
      assert.strictEqual(writes[0].length, PTY_WRITE_CHUNK_SIZE);
      assert.strictEqual(writes[1].length, 1);
    });
  });

  describe('concurrent write serialization', function() {
    it('should serialize concurrent writes so A-chunks precede B-chunks', async function() {
      this.timeout(10000);
      const dataA = 'A'.repeat(5000);
      const dataB = 'B'.repeat(5000);

      const p1 = bridge.sendInput('test-session', dataA);
      const p2 = bridge.sendInput('test-session', dataB);
      await Promise.all([p1, p2]);

      const allData = writes.join('');
      const firstB = allData.indexOf('B');
      const lastA = allData.lastIndexOf('A');
      assert(lastA < firstB, `All A chunks should precede all B chunks. lastA=${lastA}, firstB=${firstB}`);
    });
  });

  describe('session liveness check', function() {
    it('should abort mid-write if session.active becomes false', async function() {
      this.timeout(5000);
      const data = 'x'.repeat(PTY_WRITE_CHUNK_SIZE * 5);

      // Deactivate session after first chunk is written
      const origWrite = mockSession.process.write;
      let writeCount = 0;
      mockSession.process.write = (chunk) => {
        writeCount++;
        origWrite(chunk);
        if (writeCount === 1) {
          mockSession.active = false;
        }
      };

      await bridge.sendInput('test-session', data);
      // Should have written only the first chunk before aborting
      assert.strictEqual(writes.length, 1);
      assert.strictEqual(writes[0].length, PTY_WRITE_CHUNK_SIZE);
    });
  });

  describe('error handling', function() {
    it('should throw on missing session', async function() {
      await assert.rejects(
        () => bridge.sendInput('nonexistent', 'hello'),
        /not found or not active/
      );
    });

    it('should throw on inactive session', async function() {
      mockSession.active = false;
      await assert.rejects(
        () => bridge.sendInput('test-session', 'hello'),
        /not found or not active/
      );
    });
  });

  describe('empty input', function() {
    it('should not call write for empty string', async function() {
      await bridge.sendInput('test-session', '');
      assert.strictEqual(writes.length, 0);
    });

    it('should not call write for null data', async function() {
      await bridge.sendInput('test-session', null);
      assert.strictEqual(writes.length, 0);
    });
  });
});
