const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

describe('Server Aliases', function() {
  this.timeout(10000);
  it('should set aliases from options', function() {
    const server = new ClaudeCodeWebServer({
      claudeAlias: 'Buddy',
      codexAlias: 'Robo',
      copilotAlias: 'Pilot',
      geminiAlias: 'Gem',
      terminalAlias: 'Shell',
      noAuth: true
    });

    assert.strictEqual(server.aliases.claude, 'Buddy');
    assert.strictEqual(server.aliases.codex, 'Robo');
    assert.strictEqual(server.aliases.copilot, 'Pilot');
    assert.strictEqual(server.aliases.gemini, 'Gem');
    assert.strictEqual(server.aliases.terminal, 'Shell');
  });

  it('should default aliases when not provided', function() {
    const server = new ClaudeCodeWebServer({ noAuth: true });
    assert.strictEqual(server.aliases.claude, 'Claude');
    assert.strictEqual(server.aliases.codex, 'Codex');
    assert.strictEqual(server.aliases.copilot, 'Copilot');
    assert.strictEqual(server.aliases.gemini, 'Gemini');
    assert.strictEqual(server.aliases.terminal, 'Terminal');
  });
});
