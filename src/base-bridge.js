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
    try {
      const found = await this.findCommandAsync();
      this.command = found;
      // Pre-populate the availability cache so isAvailable() doesn't need
      // a blocking execFileSync fallback. If findCommandAsync resolved to a
      // real path, the tool is available. If it fell back to defaultCommand,
      // run one last async check and cache the result.
      if (found !== this.defaultCommand) {
        this._availableCache = true;
        this._availableCacheTime = Date.now();
      } else {
        const exists = await this.commandExistsAsync(this.defaultCommand);
        this._availableCache = exists;
        this._availableCacheTime = Date.now();
      }
    } catch (err) {
      // Discovery failed — mark as unavailable so isAvailable() returns false
      // without falling back to blocking execFileSync
      this._availableCache = false;
      this._availableCacheTime = Date.now();
    }
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
        writeQueue: Promise.resolve(),
        // PTY listener handles registered against ptyProcess.{onData,onExit,on('error')}.
        // node-pty's onData/onExit return IDisposable objects with a .dispose()
        // method; the EventEmitter-style .on('error', fn) path is wrapped in a
        // synthetic disposable so it can be torn down through the same helper.
        // Without explicit disposal, the closures keep dataBuffer/outputBatch/
        // flushTimer alive, pinning the PTY wrapper and its file descriptors
        // across thousands of session create/delete cycles — root cause of the
        // weeks-long EMFILE / server-unresponsive symptom on Windows-primary
        // production deployments.
        _ptyDisposables: []
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
          // Dispose any listener handles we wired up before the timeout fired;
          // otherwise the PTY object (and its FDs) cannot be GC'd even after
          // the kill() below succeeds.
          this._disposePtyDisposables(session, sessionId);
          try { ptyProcess.kill(); } catch (e) { /* ignore */ }
          onError(new Error(`${this.toolName} process did not respond within ${SPAWN_TIMEOUT_MS / 1000} seconds. The command may not be installed or may have hung during startup.`));
        }
      }, SPAWN_TIMEOUT_MS);

      let dataBuffer = '';
      let outputBatch = '';
      let flushTimer = null;

      const onDataDisposable = ptyProcess.onData((data) => {
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
      this._addPtyDisposable(session, onDataDisposable);

      const onExitDisposable = ptyProcess.onExit((exitCode, signal) => {
        if (!receivedLifeSign) {
          receivedLifeSign = true;
          clearTimeout(spawnWatchdog);
        }
        const codeStr = (exitCode && typeof exitCode === 'object') ? JSON.stringify(exitCode) : exitCode;
        console.log(`${this.toolName} session ${sessionId} exited with code ${codeStr}, signal ${signal}`);
        if (session.killTimeout) {
          clearTimeout(session.killTimeout);
          session.killTimeout = null;
        }
        // Drain remaining disposables — the PTY is gone, but the wrappers
        // still hold references to the data-buffer closures. Skip onExit
        // self-disposal (node-pty already removed it on fire).
        this._disposePtyDisposables(session, sessionId);
        if (this.sessions.has(sessionId)) {
          session.active = false;
          this.sessions.delete(sessionId);
        }
        onExit(exitCode, signal);
      });
      this._addPtyDisposable(session, onExitDisposable);

      const errorHandler = (error) => {
        // read EAGAIN ("resource temporarily unavailable") is a known transient
        // PTY-startup condition — node-pty's own socket 'error' handler ignores
        // it ("fs.ReadStream gets EAGAIN twice at first") and keeps the master
        // fd alive. Because we attach a *second* 'error' listener on the same
        // socket, we must ignore it too; otherwise a benign EAGAIN tears the
        // session down and surfaces a fatal "Connection Error" to the client,
        // which then retries and double-spawns. Heavier startup load (e.g. a
        // model download) makes the EAGAIN fire more often. Ignore it entirely:
        // do not clear the spawn watchdog, broadcast, or tear down.
        if (error && (error.code === 'EAGAIN' || (error.message && error.message.includes('EAGAIN')))) {
          return;
        }
        if (!receivedLifeSign) {
          receivedLifeSign = true;
          clearTimeout(spawnWatchdog);
        }
        // read EIO is normal on Linux when child process exits — PTY master fd
        // becomes invalid. Suppress so it doesn't broadcast spurious error events.
        if (error.message && error.message.includes('read EIO')) {
          return;
        }
        console.error(`${this.toolName} session ${sessionId} error:`, error);
        if (session.killTimeout) {
          clearTimeout(session.killTimeout);
          session.killTimeout = null;
        }
        this._disposePtyDisposables(session, sessionId);
        if (this.sessions.has(sessionId)) {
          session.active = false;
          this.sessions.delete(sessionId);
        }
        onError(error);
      };
      ptyProcess.on('error', errorHandler);
      // EventEmitter-style 'error' handler doesn't return IDisposable, so wrap
      // it in one so the same drain helper covers all three callsites.
      this._addPtyDisposable(session, {
        dispose: () => {
          try {
            if (typeof ptyProcess.off === 'function') {
              ptyProcess.off('error', errorHandler);
            } else if (typeof ptyProcess.removeListener === 'function') {
              ptyProcess.removeListener('error', errorHandler);
            }
          } catch (_) { /* ignore */ }
        }
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

  /**
   * Push an IDisposable handle onto a session's listener list so stopSession
   * can drain it. The disposable shape is whatever node-pty's onData/onExit
   * returns: an object with a .dispose() method. EventEmitter-style 'error'
   * handlers are wrapped in a synthetic disposable at the registration site.
   * @private
   */
  _addPtyDisposable(session, disposable) {
    if (!session || !disposable || typeof disposable.dispose !== 'function') return;
    if (!Array.isArray(session._ptyDisposables)) session._ptyDisposables = [];
    session._ptyDisposables.push(disposable);
  }

  /**
   * Drain a session's PTY listener disposables. Each .dispose() is wrapped
   * in try/catch so one bad handle can't strand the others; the array is
   * cleared on the way out so a re-entrant call is a safe no-op. Called from
   * stopSession (manual teardown), the natural onExit callback (PTY exited
   * on its own), the 'error' handler (PTY blew up), and the spawn-watchdog
   * timeout path — every code path that retires a PTY object.
   * @private
   */
  _disposePtyDisposables(session, sessionId) {
    if (!session || !Array.isArray(session._ptyDisposables)) return;
    const handles = session._ptyDisposables;
    session._ptyDisposables = [];
    for (const h of handles) {
      try {
        if (h && typeof h.dispose === 'function') h.dispose();
      } catch (err) {
        if (process.env.DEBUG) {
          console.warn(`${this.toolName} session ${sessionId || '?'}: dispose() threw: ${err && err.message}`);
        }
      }
    }
  }

  async stopSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Mark inactive and remove from map immediately so onExit guard skips
    session.active = false;
    this.sessions.delete(sessionId);

    if (session.killTimeout) {
      clearTimeout(session.killTimeout);
      session.killTimeout = null;
    }

    // Dispose every PTY listener we wired up at startSession time. This is
    // the load-bearing fix for the EMFILE leak: without it, the onData /
    // onExit / 'error' closures keep references to dataBuffer + outputBatch
    // + flushTimer, pinning the underlying ptyProcess (and its FDs) past
    // session disposal. We dispose BEFORE registering the temporary onExit
    // waiter below so the temp handle is the only one left when kill()
    // runs.
    this._disposePtyDisposables(session, sessionId);

    if (!session.process) return;

    // Return a promise that resolves when the PTY process actually exits
    // (or after a bounded timeout), so callers can await clean shutdown.
    return new Promise((resolve) => {
      let settled = false;
      let waitDisposable = null;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (session.killTimeout) {
          clearTimeout(session.killTimeout);
          session.killTimeout = null;
        }
        // Tear down the temporary onExit waiter so it doesn't outlive the
        // promise it backed (same FD-leak class as the main listeners).
        if (waitDisposable && typeof waitDisposable.dispose === 'function') {
          try { waitDisposable.dispose(); } catch (_) { /* ignore */ }
        }
        resolve();
      };

      try {
        const handle = session.process.onExit(() => cleanup());
        // node-pty returns an IDisposable; older mocks may return undefined.
        if (handle && typeof handle.dispose === 'function') waitDisposable = handle;
      } catch (_) {
        // onExit may fail if process already exited
      }

      try {
        session.process.kill();
      } catch (e) {
        try { session.process.kill('SIGTERM'); } catch (_) { /* ignore */ }
      }

      // Bounded timeout: don't wait forever for ConPTY cleanup
      session.killTimeout = setTimeout(() => {
        session.killTimeout = null;
        cleanup();
      }, 3000);
    });
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
