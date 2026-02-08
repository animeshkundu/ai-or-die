'use strict';

const { execFile } = require('child_process');
const os = require('os');

/**
 * Static registry of CLI tool install metadata + prerequisite detection.
 * Used by server.js (for /api/config) and vscode-tunnel.js (for not_found guidance).
 */

const TOOL_INSTALL_META = {
  claude: {
    name: 'Claude Code',
    packageName: '@anthropic-ai/claude-code',
    methods: [
      { id: 'npm', label: 'npm (recommended)', command: 'npm install -g @anthropic-ai/claude-code', requiresNpm: true },
      { id: 'npx', label: 'npx (one-time run)', command: 'npx @anthropic-ai/claude-code', requiresNpm: true, note: 'Runs without installing globally' },
    ],
    authSteps: [
      { type: 'command', label: 'Log in to Claude', command: 'claude login' },
      { type: 'url', label: 'Or sign up at Anthropic', url: 'https://console.anthropic.com/' },
    ],
    verifyCommand: 'claude --version',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  codex: {
    name: 'Codex',
    packageName: '@openai/codex',
    methods: [
      { id: 'npm', label: 'npm (recommended)', command: 'npm install -g @openai/codex', requiresNpm: true },
    ],
    authSteps: [
      { type: 'env', label: 'Set your OpenAI API key', variable: 'OPENAI_API_KEY', command: 'export OPENAI_API_KEY=your-key-here' },
      { type: 'url', label: 'Get an API key from OpenAI', url: 'https://platform.openai.com/api-keys' },
    ],
    verifyCommand: 'codex --version',
    docsUrl: 'https://github.com/openai/codex',
  },
  gemini: {
    name: 'Gemini CLI',
    packageName: '@google/gemini-cli',
    methods: [
      { id: 'npm', label: 'npm (recommended)', command: 'npm install -g @google/gemini-cli', requiresNpm: true },
    ],
    authSteps: [
      { type: 'command', label: 'Log in to Gemini', command: 'gemini auth' },
      { type: 'url', label: 'Or set up in Google AI Studio', url: 'https://aistudio.google.com/' },
    ],
    verifyCommand: 'gemini --version',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  copilot: {
    name: 'GitHub Copilot CLI',
    packageName: '@githubnext/github-copilot-cli',
    methods: [
      { id: 'npm', label: 'npm', command: 'npm install -g @githubnext/github-copilot-cli', requiresNpm: true },
      { id: 'gh', label: 'gh extension (recommended)', command: 'gh extension install github/gh-copilot', requiresGh: true },
    ],
    authSteps: [
      { type: 'command', label: 'Authenticate with GitHub', command: 'gh auth login' },
      { type: 'url', label: 'GitHub login', url: 'https://github.com/login' },
    ],
    verifyCommand: 'copilot --version',
    docsUrl: 'https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line',
  },
  vscode: {
    name: 'VS Code',
    packageName: null, // Not an npm package
    methods: getVSCodeMethods(),
    authSteps: [
      { type: 'info', label: 'Authentication is handled automatically when starting a tunnel' },
    ],
    verifyCommand: 'code --version',
    docsUrl: 'https://code.visualstudio.com/docs/remote/tunnels',
  },
};

function getVSCodeMethods() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  if (isWin) {
    return [
      { id: 'download', label: 'Download installer', command: null, url: 'https://code.visualstudio.com/download', note: 'After installing, run "Install \'code\' command in PATH" from the VS Code Command Palette (Ctrl+Shift+P)' },
      { id: 'winget', label: 'winget', command: 'winget install Microsoft.VisualStudioCode', note: 'The code command is added to PATH automatically' },
    ];
  } else if (isMac) {
    return [
      { id: 'download', label: 'Download app', command: null, url: 'https://code.visualstudio.com/download', note: 'After installing, open VS Code and run "Shell Command: Install \'code\' command in PATH" from the Command Palette' },
      { id: 'brew', label: 'Homebrew', command: 'brew install --cask visual-studio-code', note: 'The code command is added to PATH automatically' },
    ];
  }
  // Linux
  return [
    { id: 'snap', label: 'snap (recommended)', command: 'snap install code --classic', note: 'The code command is added to PATH automatically' },
    { id: 'download', label: 'Download .deb/.rpm', command: null, url: 'https://code.visualstudio.com/download', note: 'The code command is usually added to PATH after installation' },
  ];
}

class InstallAdvisor {
  constructor() {
    this._prerequisitesCache = null;
    this._prerequisitesCacheTime = 0;
  }

  /**
   * Detect npm/npx availability and whether npm is configured for user-mode global installs.
   * Returns { npm: { available, version, userMode, prefix }, npx: { available } }
   */
  async detectPrerequisites() {
    const CACHE_TTL_MS = 60000;
    const now = Date.now();
    if (this._prerequisitesCache && (now - this._prerequisitesCacheTime) < CACHE_TTL_MS) {
      return this._prerequisitesCache;
    }

    const [npmResult, npxResult] = await Promise.all([
      this._detectNpm(),
      this._commandAvailable('npx'),
    ]);

    const result = {
      npm: npmResult,
      npx: { available: npxResult },
    };

    this._prerequisitesCache = result;
    this._prerequisitesCacheTime = now;
    return result;
  }

  /**
   * Get structured install info for a tool.
   * Returns { name, methods[], authSteps[], docsUrl, verifyCommand } or null if unknown.
   */
  getInstallInfo(toolId) {
    const meta = TOOL_INSTALL_META[toolId];
    if (!meta) return null;

    return {
      name: meta.name,
      methods: meta.methods,
      authSteps: meta.authSteps,
      docsUrl: meta.docsUrl,
      verifyCommand: meta.verifyCommand,
    };
  }

  /**
   * Get install info with prerequisite-aware method availability.
   * Marks each method as available/unavailable based on detected prerequisites.
   */
  async getInstallInfoWithPrereqs(toolId) {
    const info = this.getInstallInfo(toolId);
    if (!info) return null;

    const prereqs = await this.detectPrerequisites();

    const methods = info.methods.map(method => {
      let available = true;
      let unavailableReason = null;

      if (method.requiresNpm && !prereqs.npm.available) {
        available = false;
        unavailableReason = 'npm is not available. Install Node.js from https://nodejs.org/';
      } else if (method.requiresNpm && !prereqs.npm.userMode) {
        // npm is available but may need sudo — warn but still allow
        unavailableReason = 'npm global installs may require admin access. Consider running: npm config set prefix ~/.npm-global';
      }

      if (method.requiresGh) {
        // gh availability is checked separately since it's not a standard prerequisite
        available = true; // let the user try; terminal will show the error if gh is missing
      }

      return { ...method, available, unavailableReason };
    });

    return { ...info, methods, prerequisites: prereqs };
  }

  async _detectNpm() {
    const available = await this._commandAvailable('npm');
    if (!available) {
      return { available: false, version: null, userMode: false, prefix: null };
    }

    const [version, prefix] = await Promise.all([
      this._execCommand('npm', ['--version']),
      this._execCommand('npm', ['config', 'get', 'prefix']),
    ]);

    const prefixStr = (prefix || '').trim();
    const userMode = this._isUserModePrefix(prefixStr);

    return {
      available: true,
      version: (version || '').trim(),
      userMode,
      prefix: prefixStr,
    };
  }

  _isUserModePrefix(prefix) {
    if (!prefix) return false;
    const home = os.homedir();
    const isWin = process.platform === 'win32';

    if (isWin) {
      // On Windows, the default npm prefix is %APPDATA%\npm which is user-writable
      const appData = process.env.APPDATA || '';
      if (prefix.toLowerCase().startsWith(appData.toLowerCase())) return true;
      if (prefix.toLowerCase().startsWith(home.toLowerCase())) return true;
      return false;
    }

    // Linux/macOS: user-mode if prefix is under home directory
    if (prefix.startsWith(home)) return true;
    // System prefixes that need sudo
    if (prefix === '/usr/local' || prefix === '/usr' || prefix.startsWith('/usr/local/')) return false;
    return false;
  }

  _commandAvailable(command) {
    return new Promise((resolve) => {
      const checker = process.platform === 'win32' ? 'where' : 'which';
      execFile(checker, [command], { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });
  }

  _execCommand(command, args) {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      // On Windows, npm/npx are .cmd scripts that need shell execution
      if (isWin) {
        const { exec } = require('child_process');
        const fullCmd = [command, ...args].join(' ');
        exec(fullCmd, { encoding: 'utf8', timeout: 10000 }, (err, stdout) => {
          if (err) return resolve(null);
          resolve(stdout);
        });
      } else {
        execFile(command, args, { encoding: 'utf8', timeout: 10000 }, (err, stdout) => {
          if (err) return resolve(null);
          resolve(stdout);
        });
      }
    });
  }

  clearPrerequisitesCache() {
    this._prerequisitesCache = null;
    this._prerequisitesCacheTime = 0;
  }
}

module.exports = InstallAdvisor;
