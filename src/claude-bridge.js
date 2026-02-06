const BaseBridge = require('./base-bridge');

class ClaudeBridge extends BaseBridge {
  constructor() {
    super('Claude', {
      commandPaths: {
        linux: [
          '/home/ec2-user/.claude/local/claude',
          'claude',
          'claude-code',
          '{HOME}/.claude/local/claude',
          '{HOME}/.local/bin/claude',
          '/usr/local/bin/claude',
          '/usr/bin/claude'
        ],
        win32: [
          '{HOME}\\.claude\\local\\claude',
          'claude',
          'claude-code',
          '{HOME}\\AppData\\Local\\Programs\\claude\\claude'
        ]
      },
      defaultCommand: 'claude',
      dangerousFlag: '--dangerously-skip-permissions',
      autoAcceptTrust: true
    });
    this._trustPromptHandled = new Map();
  }

  processOutput(sessionId, ptyProcess, dataBuffer) {
    if (!this._trustPromptHandled.get(sessionId) &&
        dataBuffer.includes('Do you trust the files in this folder?')) {
      this._trustPromptHandled.set(sessionId, true);
      console.log(`Auto-accepting trust prompt for session ${sessionId}`);
      setTimeout(() => {
        ptyProcess.write('\r');
        console.log(`Sent Enter to accept trust prompt for session ${sessionId}`);
      }, 500);
    }
  }

  async stopSession(sessionId) {
    this._trustPromptHandled.delete(sessionId);
    return super.stopSession(sessionId);
  }
}

module.exports = ClaudeBridge;
