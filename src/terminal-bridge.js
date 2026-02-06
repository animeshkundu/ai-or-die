const BaseBridge = require('./base-bridge');

// Raw terminal / shell access
// Spawns the user's default shell (bash/zsh on Linux, PowerShell/cmd on Windows)
class TerminalBridge extends BaseBridge {
  constructor() {
    super('Terminal', {
      defaultCommand: 'bash'
    });
  }

  // Override async command discovery — use default shell instead of searching PATH
  async initCommand() {
    this.command = await this.getDefaultShell();
  }

  async getDefaultShell() {
    if (this.isWindows) {
      // Prefer PowerShell 7 (pwsh), fall back to Windows PowerShell, then cmd.exe
      const pwshPath = await this.resolveFullPathAsync('pwsh');
      if (pwshPath) return pwshPath;
      return process.env.COMSPEC || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  isAvailable() {
    // Terminal is always available — there's always a shell
    return true;
  }

  // Terminal doesn't use dangerous flags or any special args
  buildArgs() {
    return [];
  }
}

module.exports = TerminalBridge;
