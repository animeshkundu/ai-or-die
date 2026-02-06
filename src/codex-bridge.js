const BaseBridge = require('./base-bridge');

class CodexBridge extends BaseBridge {
  constructor() {
    super('Codex', {
      commandPaths: {
        linux: [
          '{HOME}/.codex/local/codex',
          'codex',
          'codex-code',
          '{HOME}/.local/bin/codex',
          '/usr/local/bin/codex',
          '/usr/bin/codex'
        ],
        win32: [
          'codex',
          'codex-code',
          '{HOME}\\AppData\\Local\\Programs\\codex\\codex'
        ]
      },
      defaultCommand: 'codex',
      dangerousFlag: '--dangerously-bypass-approvals-and-sandbox'
    });
  }
}

module.exports = CodexBridge;
