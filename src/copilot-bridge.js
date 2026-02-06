const BaseBridge = require('./base-bridge');

// GitHub Copilot CLI
// Install: npm install -g @github/copilot (Node 22+)
//          winget install GitHub.Copilot (Windows)
//          brew install copilot-cli (macOS)
//          curl -fsSL https://gh.io/copilot-install | bash (Linux)
class CopilotBridge extends BaseBridge {
  constructor() {
    super('Copilot', {
      commandPaths: {
        linux: [
          'copilot',
          '{HOME}/.local/bin/copilot',
          '/usr/local/bin/copilot'
        ],
        win32: [
          'copilot',
          'copilot.cmd',
          '{HOME}\\AppData\\Local\\Programs\\GitHub Copilot\\copilot',
          '{HOME}\\AppData\\Roaming\\npm\\copilot'
        ]
      },
      defaultCommand: 'copilot'
    });
  }
}

module.exports = CopilotBridge;
