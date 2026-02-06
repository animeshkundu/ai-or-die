const { spawn } = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');

class BaseBridge {
  constructor(toolName, options = {}) {
    this.toolName = toolName;
    this.sessions = new Map();
    this.isWindows = process.platform === 'win32';

    this.commandPaths = options.commandPaths || { linux: [], win32: [] };
    this.defaultCommand = options.defaultCommand || toolName.toLowerCase();
    this.dangerousFlag = options.dangerousFlag || null;
    this.autoAcceptTrust = options.autoAcceptTrust || false;

    this.command = this.findCommand();
  }

  isAvailable() {
    // Check if the resolved command is actually found (not just the fallback default)
    if (this.command === this.defaultCommand) {
      return this.commandExists(this.command);
    }
    return true;
  }

  commandExists(command) {
    try {
      const checker = this.isWindows ? 'where' : 'which';
      require('child_process').execFileSync(checker, [command], { stdio: 'ignore' });
      return true;
    } catch (error) {
      return false;
    }
  }

  findCommand() {
    const home = os.homedir();
    const platformPaths = this.isWindows
      ? this.commandPaths.win32 || []
      : this.commandPaths.linux || [];

    const resolvedPaths = platformPaths.map(p => p.replace(/\{HOME\}/g, home));

    for (const cmd of resolvedPaths) {
      try {
        const candidates = this.isWindows
          ? [cmd, `${cmd}.exe`, `${cmd}.cmd`]
          : [cmd];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate) || this.commandExists(candidate)) {
            console.log(`Found ${this.toolName} command at: ${candidate}`);
            return candidate;
          }
        }
      } catch (error) {
        continue;
      }
    }

    console.error(`${this.toolName} command not found, using default "${this.defaultCommand}"`);
    return this.defaultCommand;
  }

  async startSession(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const {
      workingDir = process.cwd(),
      dangerouslySkipPermissions = false,
      onOutput = () => {},
      onExit = () => {},
      onError = () => {},
      cols = 80,
      rows = 24
    } = options;

    try {
      console.log(`Starting ${this.toolName} session ${sessionId}`);
      console.log(`Command: ${this.command}`);
      console.log(`Working directory: ${workingDir}`);
      console.log(`Terminal size: ${cols}x${rows}`);
      if (dangerouslySkipPermissions && this.dangerousFlag) {
        console.log(`WARNING: Using ${this.dangerousFlag} flag`);
      }

      const args = this.buildArgs({ dangerouslySkipPermissions });

      const env = {
        ...process.env,
        TERM: this.isWindows ? 'xterm' : 'xterm-256color',
        FORCE_COLOR: '1'
      };
      if (!this.isWindows) {
        env.COLORTERM = 'truecolor';
      }

      const ptyProcess = spawn(this.command, args, {
        cwd: workingDir,
        env,
        cols,
        rows,
        name: this.isWindows ? 'xterm' : 'xterm-color',
        useConpty: this.isWindows
      });

      const session = {
        process: ptyProcess,
        workingDir,
        created: new Date(),
        active: true,
        killTimeout: null
      };

      this.sessions.set(sessionId, session);

      let dataBuffer = '';

      ptyProcess.onData((data) => {
        if (process.env.DEBUG) {
          console.log(`${this.toolName} session ${sessionId} output:`, data);
        }

        dataBuffer += data;

        // Tool-specific output processing (e.g., trust prompt auto-accept)
        this.processOutput(sessionId, ptyProcess, dataBuffer);

        if (dataBuffer.length > 10000) {
          dataBuffer = dataBuffer.slice(-5000);
        }

        onOutput(data);
      });

      ptyProcess.onExit((exitCode, signal) => {
        console.log(`${this.toolName} session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
        if (session.killTimeout) {
          clearTimeout(session.killTimeout);
          session.killTimeout = null;
        }
        session.active = false;
        this.sessions.delete(sessionId);
        onExit(exitCode, signal);
      });

      ptyProcess.on('error', (error) => {
        console.error(`${this.toolName} session ${sessionId} error:`, error);
        if (session.killTimeout) {
          clearTimeout(session.killTimeout);
          session.killTimeout = null;
        }
        session.active = false;
        this.sessions.delete(sessionId);
        onError(error);
      });

      console.log(`${this.toolName} session ${sessionId} started successfully`);
      return session;

    } catch (error) {
      console.error(`Failed to start ${this.toolName} session ${sessionId}:`, error);
      throw new Error(`Failed to start ${this.toolName}: ${error.message}`);
    }
  }

  // Override in subclasses for tool-specific argument construction
  buildArgs(options = {}) {
    if (options.dangerouslySkipPermissions && this.dangerousFlag) {
      return [this.dangerousFlag];
    }
    return [];
  }

  // Override in subclasses for tool-specific output processing (e.g., trust prompt)
  processOutput(sessionId, ptyProcess, dataBuffer) {
    // No-op by default
  }

  async sendInput(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    try {
      session.process.write(data);
    } catch (error) {
      throw new Error(`Failed to send input to session ${sessionId}: ${error.message}`);
    }
  }

  async resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    try {
      session.process.resize(cols, rows);
    } catch (error) {
      console.warn(`Failed to resize session ${sessionId}:`, error.message);
    }
  }

  async stopSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    try {
      if (session.killTimeout) {
        clearTimeout(session.killTimeout);
        session.killTimeout = null;
      }

      if (session.active && session.process) {
        session.process.kill('SIGTERM');

        session.killTimeout = setTimeout(() => {
          if (session.active && session.process) {
            session.process.kill('SIGKILL');
          }
        }, 5000);
      }
    } catch (error) {
      console.warn(`Error stopping ${this.toolName} session ${sessionId}:`, error.message);
    }

    session.active = false;
    this.sessions.delete(sessionId);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getAllSessions() {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      workingDir: session.workingDir,
      created: session.created,
      active: session.active
    }));
  }

  async cleanup() {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.stopSession(sessionId);
    }
  }
}

module.exports = BaseBridge;
