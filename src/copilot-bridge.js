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
      defaultCommand: 'copilot',
      dangerousFlag: '--yolo'
    });
  }

  // Adopt-respawn passes agentArgs through (BaseBridge.buildArgs ignores
  // them); validated upstream at create_session like claude's.
  buildArgs(options = {}) {
    const out = super.buildArgs(options);
    const extra = Array.isArray(options.agentArgs) ? options.agentArgs.map((a) => String(a)) : [];
    out.push(...extra);
    return out;
  }

  /**
   * Adopt-respawn argv: `copilot --continue` resumes the most recent
   * session in the working directory — which, at adopt time, is the
   * session that just shut down. Skipped when the persisted launch
   * options already carry an explicit resume/continue flag.
   */
  resumeArgsForAdopt(persisted) {
    const prior = (persisted && persisted.launchOptions && persisted.launchOptions.agentArgs) || [];
    if (prior.some((a) => a === '--resume' || a === '-r' || a === '--continue')) {
      return [];
    }
    return ['--continue'];
  }
}

module.exports = CopilotBridge;
