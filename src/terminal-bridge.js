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
      // Use full paths — some node-pty builds require them on Windows
      const pwshPath = this.resolveCommand('pwsh');
      if (pwshPath) return pwshPath;
      return process.env.COMSPEC || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  resolveCommand(command) {
    try {
      const result = require('child_process').execFileSync('where', [command], {
        encoding: 'utf8',
        timeout: 5000
      });
      const firstLine = result.trim().split(/\r?\n/)[0];
      return firstLine || null;
    } catch (_) {
      return null;
    }
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
