const BaseBridge = require('./base-bridge');

// Google Gemini CLI
// Install: npm install -g @google/gemini-cli
//          npx @google/gemini-cli (without global install)
class GeminiBridge extends BaseBridge {
  constructor() {
    super('Gemini', {
      commandPaths: {
        linux: [
          'gemini',
          '{HOME}/.local/bin/gemini',
          '/usr/local/bin/gemini'
        ],
        win32: [
          'gemini',
          'gemini.cmd',
          '{HOME}\\AppData\\Roaming\\npm\\gemini'
        ]
      },
      defaultCommand: 'gemini',
      dangerousFlag: '--yolo'
    });
  }
}

module.exports = GeminiBridge;
