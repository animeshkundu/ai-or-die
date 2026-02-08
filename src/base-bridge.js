const { spawn } = require('@lydell/node-pty');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** Chunk size for PTY writes — safely below ConPTY ~16KB kernel buffer */
const PTY_WRITE_CHUNK_SIZE = 4096;
/** Inter-chunk delay in ms — allows ConPTY buffer to drain */
const PTY_WRITE_CHUNK_DELAY_MS = 10;

class BaseBridge {
  constructor(toolName, options = {}) {
    this.toolName = toolName;
    this.sessions = new Map();
    this.isWindows = process.platform === 'win32';

    this.commandPaths = options.commandPaths || { linux: [], win32: [] };
    this.defaultCommand = options.defaultCommand || toolName.toLowerCase();
    this.dangerousFlag = options.dangerousFlag || null;
    this.autoAcceptTrust = options.autoAcceptTrust || false;

    this._availableCache = null;
    this._availableCacheTime = 0;

    // Start with default; resolved asynchronously via initCommand()
    this.command = this.defaultCommand;
    this._commandReady = this.initCommand();
  }

  /**
   * Async command discovery — runs where/which without blocking the event loop.
   * Called automatically from the constructor; await bridge._commandReady to ensure it's done.
   */
  async initCommand() {
    this.command = await this.findCommandAsync();
  }

  isAvailable() {
    // Return cached result if fresh (avoids repeated synchronous where/which calls
    // that block the event loop for up to 5s each on Windows)
    const CACHE_TTL_MS = 60000;
    const now = Date.now();
    if (this._availableCache !== null && (now - this._availableCacheTime) < CACHE_TTL_MS) {
      return this._availableCache;
    }

    let result;
    if (this.command === this.defaultCommand) {
      result = this.commandExists(this.command);
    } else {
      result = true;
    }

    this._availableCache = result;
    this._availableCacheTime = now;
    return result;
  }

  clearAvailabilityCache() {
    this._availableCache = null;
    this._availableCacheTime = 0;
  }

  commandExists(command) {
    try {
      const checker = this.isWindows ? 'where' : 'which';
      require('child_process').execFileSync(checker, [command], {
        stdio: 'ignore',
        timeout: 5000
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  resolveFullPath(command) {
    try {
      const checker = this.isWindows ? 'where' : 'which';
      const result = require('child_process').execFileSync(checker, [command], {
        encoding: 'utf8',
        timeout: 5000
      });
      const firstLine = result.trim().split(/\r?\n/)[0];
      return firstLine || null;
    } catch (_) {
      return null;
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
          if (path.isAbsolute(candidate)) {
            // For absolute paths, use fs.existsSync only (where/which don't work for absolute paths)
            if (fs.existsSync(candidate)) {
              console.log(`Found ${this.toolName} command at: ${candidate}`);
              return candidate;
            }
          } else {
            // For bare command names, use PATH lookup and resolve to full path
            // (some node-pty builds require full paths on Windows)
            if (this.commandExists(candidate)) {
              const resolved = this.resolveFullPath(candidate);
              console.log(`Found ${this.toolName} command at: ${resolved || candidate}`);
              return resolved || candidate;
            }
          }
        }
      } catch (error) {
        continue;
      }
    }

    console.error(`${this.toolName} command not found, using default "${this.defaultCommand}"`);
    return this.defaultCommand;
  }

  commandExistsAsync(command) {
    return new Promise((resolve) => {
      const checker = this.isWindows ? 'where' : 'which';
      execFile(checker, [command], { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });
  }

  resolveFullPathAsync(command) {
    return new Promise((resolve) => {
      const checker = this.isWindows ? 'where' : 'which';
      execFile(checker, [command], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(null);
        const firstLine = stdout.trim().split(/\r?\n/)[0];
        resolve(firstLine || null);
      });
    });
  }

  async findCommandAsync() {
    const home = os.homedir();
    const platformPaths = this.isWindows
      ? this.commandPaths.win32 || []
      : this.commandPaths.linux || [];

    const resolvedPaths = platformPaths.map(p => p.replace(/\{HOME\}/g, home));

    for (const cmd of resolvedPaths) {
      const candidates = this.isWindows
        ? [cmd, `${cmd}.exe`, `${cmd}.cmd`]
        : [cmd];
      for (const candidate of candidates) {
        if (path.isAbsolute(candidate)) {
          if (fs.existsSync(candidate)) {
            console.log(`Found ${this.toolName} command at: ${candidate}`);
            return candidate;
          }
        } else {
          if (await this.commandExistsAsync(candidate)) {
            const resolved = await this.resolveFullPathAsync(candidate);
            console.log(`Found ${this.toolName} command at: ${resolved || candidate}`);
            return resolved || candidate;
          }
        }
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
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
        COLORTERM: 'truecolor'
      };

      const ptyProcess = spawn(this.command, args, {
        cwd: workingDir,
        env,
        cols,
        rows,
        name: 'xterm-256color'
      });

      const session = {
        process: ptyProcess,
        workingDir,
        created: new Date(),
        active: true,
        killTimeout: null,
        writeQueue: Promise.resolve()
      };

      this.sessions.set(sessionId, session);

      // Spawn watchdog: if no data, exit, or error arrives within 30s, treat as failure
      let receivedLifeSign = false;
      const SPAWN_TIMEOUT_MS = 30000;
      const spawnWatchdog = setTimeout(() => {
        if (!receivedLifeSign && session.active) {
          console.error(`${this.toolName} session ${sessionId}: no response within ${SPAWN_TIMEOUT_MS}ms, treating as spawn failure`);
          session.active = false;
          this.sessions.delete(sessionId);
          try { ptyProcess.kill(); } catch (e) { /* ignore */ }
          onError(new Error(`${this.toolName} process did not respond within ${SPAWN_TIMEOUT_MS / 1000} seconds. The command may not be installed or may have hung during startup.`));
        }
      }, SPAWN_TIMEOUT_MS);

      let dataBuffer = '';
      let outputBatch = '';
      let flushTimer = null;

      ptyProcess.onData((data) => {
        if (!receivedLifeSign) {
          receivedLifeSign = true;
          clearTimeout(spawnWatchdog);
        }

        if (process.env.DEBUG) {
          console.log(`${this.toolName} session ${sessionId} output:`, data);
        }

        dataBuffer += data;

        // Tool-specific output processing (e.g., trust prompt auto-accept)
        this.processOutput(sessionId, ptyProcess, dataBuffer);

        if (dataBuffer.length > 10000) {
          dataBuffer = dataBuffer.slice(-5000);
        }

        // Batch output: coalesce PTY data chunks from the same I/O cycle
        // setImmediate flushes on the next tick — no arbitrary time boundary
        // that could split ANSI escape sequences or multi-byte UTF-8 characters
        outputBatch += data;
        if (!flushTimer) {
          flushTimer = setImmediate(() => {
            onOutput(outputBatch);
            outputBatch = '';
            flushTimer = null;
          });
        }
      });

      ptyProcess.onExit((exitCode, signal) => {
        if (!receivedLifeSign) {
          receivedLifeSign = true;
          clearTimeout(spawnWatchdog);
        }
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
        if (!receivedLifeSign) {
          receivedLifeSign = true;
          clearTimeout(spawnWatchdog);
        }
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

  /**
   * Write input data to the session's PTY process. Large inputs are
   * chunked to prevent ConPTY buffer overflow on Windows.
   * Writes are serialized per-session via writeQueue.
   * @param {string} sessionId - Target session UUID
   * @param {string} data - Raw terminal input to write
   * @returns {Promise<void>}
   */
  async sendInput(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    session.writeQueue = session.writeQueue.then(() =>
      this._writeChunked(session, data)
    ).catch((err) => {
      console.warn(`Write to session ${sessionId} failed: ${err.message}`);
    });

    return session.writeQueue;
  }

  /**
   * Write data to the PTY in chunks to prevent kernel buffer overflow.
   * @private
   * @param {Object} session - Active session with a live PTY process
   * @param {string} data - Input data to write
   * @returns {Promise<void>}
   */
  async _writeChunked(session, data) {
    if (!data || data.length === 0) return;

    if (data.length <= PTY_WRITE_CHUNK_SIZE) {
      session.process.write(data);
      return;
    }

    for (let i = 0; i < data.length; i += PTY_WRITE_CHUNK_SIZE) {
      if (!session.active) return;
      session.process.write(data.slice(i, i + PTY_WRITE_CHUNK_SIZE));
      if (i + PTY_WRITE_CHUNK_SIZE < data.length) {
        await new Promise(r => setTimeout(r, PTY_WRITE_CHUNK_DELAY_MS));
      }
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
        // On Windows, SIGTERM/SIGKILL are not supported by some node-pty builds.
        // Use kill() without arguments which triggers the platform-appropriate termination.
        try {
          session.process.kill();
        } catch (e) {
          // Fallback: try SIGTERM for Unix compatibility
          try { session.process.kill('SIGTERM'); } catch (_) { /* ignore */ }
        }

        session.killTimeout = setTimeout(() => {
          if (session.active && session.process) {
            try {
              session.process.kill();
            } catch (_) {
              try { session.process.kill('SIGKILL'); } catch (__) { /* ignore */ }
            }
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
module.exports.PTY_WRITE_CHUNK_SIZE = PTY_WRITE_CHUNK_SIZE;
module.exports.PTY_WRITE_CHUNK_DELAY_MS = PTY_WRITE_CHUNK_DELAY_MS;
