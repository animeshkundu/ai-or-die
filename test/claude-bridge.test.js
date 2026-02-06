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
});