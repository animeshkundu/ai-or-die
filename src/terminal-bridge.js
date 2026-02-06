const BaseBridge = require('./base-bridge');

// Raw terminal / shell access
// Spawns the user's default shell (bash/zsh on Linux, PowerShell/cmd on Windows)
class TerminalBridge extends BaseBridge {
  constructor() {
    super('Terminal', {
      defaultCommand: 'bash'
    });
    // Override command resolution — no search needed, use default shell
    this.command = this.getDefaultShell();
  }

  getDefaultShell() {
    if (this.isWindows) {
      // Prefer PowerShell 7 (pwsh), fall back to Windows PowerShell, then cmd.exe
      if (this.commandExists('pwsh')) {
        return 'pwsh';
      }
      return process.env.COMSPEC || 'powershell.exe';
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
