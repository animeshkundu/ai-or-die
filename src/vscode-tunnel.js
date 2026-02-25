'use strict';

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

const MAX_RETRIES = 10;
const URL_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 60000;
const DEFAULT_MAX_TUNNELS = 5;
const STABILITY_THRESHOLD_MS = 60000;  // 60s uptime = "stable", resets retryCount
const MIN_RESTART_DELAY_MS = 1000;
const MAX_RESTART_DELAY_MS = 30000;    // cap backoff at 30s
const LOGIN_TIMEOUT_MS = 120000;       // 2 minutes for user to complete device-code auth
const VSCODE_BASE_PORT = parseInt(process.env.VSCODE_BASE_PORT || '9100', 10);
const VSCODE_PORT_RANGE = 100;         // ports 9100-9199
const PORT_RETRY_MAX = 3;             // max retries on EADDRINUSE
const PORT_WAIT_TIMEOUT_MS = 10000;   // max wait for TCP readiness

/**
 * Manages VS Code Server + Dev Tunnel processes on a per-session basis.
 * Each session gets two independent processes:
 *   1. `code serve-web` — local VS Code HTTP server
 *   2. `devtunnel host` — forwards the local port to the internet
 */
class VSCodeTunnelManager {
  constructor(options = {}) {
    this.tunnels = new Map(); // sessionId → tunnel state
    this.maxTunnels = parseInt(process.env.MAX_VSCODE_TUNNELS || String(DEFAULT_MAX_TUNNELS), 10);
    this.onEvent = options.onEvent || (() => {}); // callback(sessionId, event)
    this.dev = options.dev || false;

    // VS Code CLI discovery
    this._command = null;
    this._commandChecked = false;
    this._available = false;

    // devtunnel CLI discovery
    this._devtunnelCommand = null;
    this._devtunnelChecked = false;
    this._devtunnelAvailable = false;

    this._healthInterval = null;
    this._reservedPorts = new Set();

    // Kick off async command discovery at construction time
    this._initPromise = Promise.all([
      this._findCommand().then((cmd) => {
        this._command = cmd;
        this._commandChecked = true;
        this._available = !!cmd;
      }),
      this._findDevtunnelCommand().then((cmd) => {
        this._devtunnelCommand = cmd;
        this._devtunnelChecked = true;
        this._devtunnelAvailable = !!cmd;
      }),
    ]);
  }

  /**
   * Check if VS Code CLI is available (async, waits for discovery).
   */
  async isAvailable() {
    if (!this._commandChecked || !this._devtunnelChecked) await this._initPromise;
    return this._available && this._devtunnelAvailable;
  }

  /**
   * Synchronous availability check (returns cached result).
   * Safe to call after constructor has had time to discover.
   */
  isAvailableSync() {
    return this._available && this._devtunnelAvailable;
  }

  /**
   * Start a VS Code Server + Dev Tunnel for the given session.
   */
  async start(sessionId, workingDir) {
    // Already running for this session
    if (this.tunnels.has(sessionId)) {
      const existing = this.tunnels.get(sessionId);
      if (existing.status === 'running' || existing.status === 'starting') {
        return { success: false, error: 'Tunnel already active for this session', url: existing.publicUrl || existing.localUrl };
      }
    }

    // Rate limit
    const activeCount = this._activeCount();
    if (activeCount >= this.maxTunnels) {
      return { success: false, error: `Maximum tunnel limit reached (${this.maxTunnels}). Stop an existing tunnel first.` };
    }

    // Check VS Code CLI availability
    if (!this._commandChecked || !this._devtunnelChecked) await this._initPromise;
    if (!this._available) {
      const installInfo = this._getInstallInfo();
      return { success: false, error: 'not_found', message: this._installInstructions(), install: installInfo };
    }

    // Check devtunnel CLI availability (required)
    if (!this._devtunnelAvailable) {
      return { success: false, error: 'not_found', message: this._devtunnelInstallInstructions() };
    }

    // Allocate port + generate token
    const localPort = this._allocatePort();
    if (localPort === null) {
      return { success: false, error: 'No available ports in range. Stop an existing tunnel first.' };
    }
    const connectionToken = this._generateToken();

    // Create tunnel state early so stop() can cancel an in-progress login
    const tunnel = {
      serverProcess: null,
      tunnelProcess: null,
      _loginProcess: null,
      localPort,
      connectionToken,
      localUrl: null,
      publicUrl: null,
      tunnelId: `aiordie-vscode-${sessionId.slice(0, 12).replace(/[^a-z0-9-]/gi, '')}`,
      status: 'starting',
      sessionId,
      workingDir: workingDir || process.cwd(),
      retryCount: 0,
      stopping: false,
      _lastSpawnTime: null,
      _totalRestarts: 0,
      _stabilityTimer: null,
      _restartDelayTimer: null,
      _restartDelayResolve: null,
      _whichDied: null, // 'server' | 'tunnel' | null
    };
    this.tunnels.set(sessionId, tunnel);
    this._reservedPorts.add(localPort);

    this._emitEvent(sessionId, 'vscode_tunnel_status', { status: 'starting' });
    console.warn(`[VSCODE-TUNNEL] Starting for session ${sessionId} (port: ${localPort}, cwd: ${tunnel.workingDir})`);

    // Check devtunnel auth (OS-level credential store)
    const authed = await this._checkDevtunnelAuth();
    if (!authed) {
      console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel not authenticated, starting login flow`);
      const loginOk = await this._loginDevtunnel(sessionId);
      if (tunnel.stopping) {
        this._cleanupTunnel(sessionId);
        return { success: false, error: 'Tunnel start cancelled' };
      }
      if (!loginOk) {
        tunnel.status = 'error';
        tunnel.lastError = 'Authentication failed or was cancelled';
        this._cleanupTunnel(sessionId);
        this._emitEvent(sessionId, 'vscode_tunnel_error', {
          message: 'DevTunnel authentication failed or was cancelled. Click Retry to try again.',
        });
        return { success: false, error: 'Authentication failed or was cancelled' };
      }
      console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel login successful`);
    }

    // Start health check interval (once)
    this._ensureHealthCheck();

    // Spawn VS Code Server
    const serverOk = await this._spawnServer(sessionId);
    if (!serverOk) {
      const current = this.tunnels.get(sessionId);
      if (current) {
        this._cleanupTunnel(sessionId);
      }
      return { success: false, error: 'Failed to start VS Code Server' };
    }

    // Wait for TCP readiness
    await this._waitForPort(tunnel.localPort, PORT_WAIT_TIMEOUT_MS);

    if (tunnel.stopping) {
      this._cleanupTunnel(sessionId);
      return { success: false, error: 'Tunnel start cancelled' };
    }

    // Create devtunnel and spawn tunnel process
    const tunnelReady = await this._ensureDevtunnel(sessionId);
    if (!tunnelReady) {
      // Server is running but tunnel setup failed
      tunnel.status = 'error';
      tunnel.lastError = 'Failed to create devtunnel';
      this._emitEvent(sessionId, 'vscode_tunnel_error', {
        message: 'Failed to set up dev tunnel. VS Code Server is running locally.',
      });
      return { success: false, error: 'Failed to create devtunnel' };
    }

    await this._spawnTunnel(sessionId);

    const current = this.tunnels.get(sessionId);
    if (current && current.publicUrl) {
      return { success: true, url: current.publicUrl, localUrl: current.localUrl, publicUrl: current.publicUrl };
    } else if (current && current.localUrl) {
      return { success: true, url: current.localUrl, localUrl: current.localUrl, publicUrl: null };
    } else if (current && current.status === 'error') {
      return { success: false, error: current.lastError || 'Failed to start tunnel' };
    }

    return { success: true, url: null };
  }

  /**
   * Stop a VS Code tunnel for the given session (sequenced teardown).
   */
  async stop(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel) return { success: true };

    tunnel.stopping = true;
    this._clearStabilityTimer(tunnel);

    // Kill login process if in-progress
    if (tunnel._loginProcess) {
      try { tunnel._loginProcess.kill(); } catch {}
      tunnel._loginProcess = null;
    }

    // Abort any pending restart delay
    clearTimeout(tunnel._restartDelayTimer);
    if (tunnel._restartDelayResolve) {
      tunnel._restartDelayResolve();
      tunnel._restartDelayResolve = null;
    }

    // Step 1: Kill tunnel process first
    if (tunnel.tunnelProcess) {
      await this._killProcess(tunnel.tunnelProcess);
      tunnel.tunnelProcess = null;
    }

    // Step 2: Clean up devtunnel (fire-and-forget)
    if (this._devtunnelCommand) {
      execFile(this._devtunnelCommand, ['delete', tunnel.tunnelId, '-y'], { timeout: 10000 }, () => {});
    }

    // Step 3: Kill server process
    if (tunnel.serverProcess) {
      await this._killProcess(tunnel.serverProcess);
      tunnel.serverProcess = null;
    }

    // Step 4: Release port
    this._cleanupTunnel(sessionId);
    this._emitEvent(sessionId, 'vscode_tunnel_status', { status: 'stopped' });
    console.warn(`[VSCODE-TUNNEL] Stopped tunnel for session ${sessionId}`);
    return { success: true };
  }

  /**
   * Get the status of a tunnel for a session.
   */
  getStatus(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel) return { status: 'stopped', url: null, localUrl: null, publicUrl: null };
    return {
      status: tunnel.status,
      localUrl: tunnel.localUrl,
      publicUrl: tunnel.publicUrl,
      url: tunnel.publicUrl || tunnel.localUrl,
      pid: tunnel.serverProcess ? tunnel.serverProcess.pid : null,
      tunnelPid: tunnel.tunnelProcess ? tunnel.tunnelProcess.pid : null,
    };
  }

  /**
   * Stop all active tunnels (for server shutdown).
   */
  async stopAll() {
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
      this._healthInterval = null;
    }

    const stopPromises = [];
    for (const sessionId of this.tunnels.keys()) {
      stopPromises.push(this.stop(sessionId));
    }
    await Promise.all(stopPromises);
  }

  // ── Private ──────────────────────────────────────────────────

  _activeCount() {
    let count = 0;
    for (const t of this.tunnels.values()) {
      if (t.status === 'running' || t.status === 'starting' || t.status === 'degraded') count++;
    }
    return count;
  }

  _emitEvent(sessionId, type, data) {
    this.onEvent(sessionId, { type, ...data });
  }

  _cleanupTunnel(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (tunnel) {
      this._reservedPorts.delete(tunnel.localPort);
    }
    this.tunnels.delete(sessionId);
  }

  /**
   * Kill a child process with SIGTERM, escalating to SIGKILL after 5s.
   */
  _killProcess(proc) {
    return new Promise((resolve) => {
      if (!proc || proc.exitCode !== null) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try { proc.kill(); } catch {}
    });
  }

  // ── Port Allocation ──────────────────────────────────────────

  /**
   * Allocate a free port from the range. Returns null if exhausted.
   */
  _allocatePort() {
    for (let p = VSCODE_BASE_PORT; p < VSCODE_BASE_PORT + VSCODE_PORT_RANGE; p++) {
      if (!this._reservedPorts.has(p)) {
        return p;
      }
    }
    return null;
  }

  /**
   * Generate a random connection token.
   */
  _generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Wait for a TCP port to accept connections.
   */
  _waitForPort(port, timeoutMs) {
    const start = Date.now();
    return new Promise((resolve) => {
      const attempt = () => {
        if (Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }
        const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
          sock.destroy();
          resolve(true);
        });
        sock.on('error', () => {
          sock.destroy();
          setTimeout(attempt, 200);
        });
      };
      attempt();
    });
  }

  // ── VS Code CLI Discovery ────────────────────────────────────

  /**
   * Locate the `code` CLI executable.
   */
  async _findCommand() {
    const isWin = process.platform === 'win32';
    const home = os.homedir();

    const candidates = [];
    if (isWin) {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      candidates.push(
        path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
        path.join(programFiles, 'Microsoft VS Code', 'bin', 'code.cmd'),
        path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code'),
      );
    } else if (process.platform === 'darwin') {
      candidates.push(
        '/usr/local/bin/code',
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
        path.join(home, '.local', 'bin', 'code'),
      );
    } else {
      candidates.push(
        '/usr/bin/code',
        '/usr/local/bin/code',
        '/snap/bin/code',
        path.join(home, '.local', 'bin', 'code'),
      );
    }

    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not found, continue
      }
    }

    const checker = isWin ? 'where' : 'which';
    return new Promise((resolve) => {
      execFile(checker, ['code'], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve(null);
        } else {
          const found = stdout.toString().trim().split(/\r?\n/)[0];
          resolve(found || null);
        }
      });
    });
  }

  // ── devtunnel CLI Discovery ──────────────────────────────────

  /**
   * Locate the `devtunnel` CLI executable.
   * Note: devtunnel is a standalone binary; does NOT need shell: true on Windows.
   */
  async _findDevtunnelCommand() {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    return new Promise((resolve) => {
      execFile(checker, ['devtunnel'], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve(null);
        } else {
          const found = stdout.toString().trim().split(/\r?\n/)[0];
          resolve(found || null);
        }
      });
    });
  }

  /**
   * Check if user is authenticated with devtunnel (OS-level credential store).
   */
  async _checkDevtunnelAuth() {
    if (!this._devtunnelCommand) return false;
    return new Promise((resolve) => {
      execFile(this._devtunnelCommand, ['user', 'show'], { timeout: 10000 }, (err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Run `devtunnel user login` and wait for completion.
   * Emits vscode_tunnel_auth events so the client can show the device code.
   */
  async _loginDevtunnel(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel || tunnel.stopping) return false;

    const spawnOptions = {
      cwd: tunnel.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    };

    return new Promise((resolve) => {
      tunnel._loginProcess = spawn(this._devtunnelCommand, ['user', 'login'], spawnOptions);

      let outputBuffer = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel login timed out after ${LOGIN_TIMEOUT_MS / 1000}s`);
          try { tunnel._loginProcess.kill(); } catch {}
          tunnel._loginProcess = null;
          resolve(false);
        }
      }, LOGIN_TIMEOUT_MS);

      tunnel._loginProcess.stdout.on('data', (data) => {
        const output = data.toString();
        outputBuffer += output;
        if (this.dev) process.stdout.write(`  [devtunnel-login] ${output}`);

        // Check for Microsoft device code auth prompt
        const msMatch = output.match(/https:\/\/microsoft\.com\/devicelogin/i)
          || outputBuffer.match(/https:\/\/microsoft\.com\/devicelogin/i);
        if (msMatch) {
          const codeMatch = outputBuffer.match(/code\s+([A-Z0-9]{6,9})/i);
          const deviceCode = codeMatch ? codeMatch[1] : null;
          this._emitEvent(sessionId, 'vscode_tunnel_auth', {
            authUrl: 'https://microsoft.com/devicelogin',
            deviceCode,
          });
        }

        // Also handle GitHub device code as fallback
        const githubMatch = output.match(/https:\/\/github\.com\/login\/device/i)
          || outputBuffer.match(/https:\/\/github\.com\/login\/device/i);
        if (githubMatch) {
          const codeMatch = outputBuffer.match(/code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
          const deviceCode = codeMatch ? codeMatch[1] : null;
          this._emitEvent(sessionId, 'vscode_tunnel_auth', {
            authUrl: 'https://github.com/login/device',
            deviceCode,
          });
        }
      });

      tunnel._loginProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          outputBuffer += output;
          if (this.dev) console.error(`  [devtunnel-login] ${output}`);

          // Also check stderr for auth URLs (devtunnel may use stderr)
          const msMatch = output.match(/https:\/\/microsoft\.com\/devicelogin/i);
          if (msMatch) {
            const codeMatch = outputBuffer.match(/code\s+([A-Z0-9]{6,9})/i);
            const deviceCode = codeMatch ? codeMatch[1] : null;
            this._emitEvent(sessionId, 'vscode_tunnel_auth', {
              authUrl: 'https://microsoft.com/devicelogin',
              deviceCode,
            });
          }
        }
      });

      tunnel._loginProcess.on('error', (err) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel login error: ${err.message}`);
          tunnel._loginProcess = null;
          resolve(false);
        }
      });

      tunnel._loginProcess.on('exit', (code) => {
        clearTimeout(timeout);
        tunnel._loginProcess = null;
        if (!resolved) {
          resolved = true;
          const success = code === 0;
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel login exited with code ${code}`);
          resolve(success);
        }
      });
    });
  }

  // ── VS Code Server ───────────────────────────────────────────

  /**
   * Spawn `code serve-web` and wait for readiness.
   * Returns true if server started successfully.
   */
  async _spawnServer(sessionId, retryAttempt = 0) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel || tunnel.stopping) return false;

    const args = [
      'serve-web',
      '--host', '127.0.0.1',
      '--port', String(tunnel.localPort),
      '--connection-token', tunnel.connectionToken,
      '--accept-server-license-terms',
    ];

    return new Promise((resolve) => {
      tunnel._lastSpawnTime = Date.now();
      const spawnOptions = {
        cwd: tunnel.workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      };
      // Windows .cmd/.bat files require shell to execute
      if (process.platform === 'win32') {
        spawnOptions.shell = true;
      }

      tunnel.serverProcess = spawn(this._command, args, spawnOptions);

      let readyResolved = false;
      let outputBuffer = '';

      const readyTimeout = setTimeout(() => {
        if (!readyResolved) {
          readyResolved = true;
          // Server may still be starting — set localUrl optimistically
          tunnel.localUrl = `http://localhost:${tunnel.localPort}/?tkn=${tunnel.connectionToken}`;
          resolve(true);
        }
      }, URL_TIMEOUT_MS);

      tunnel.serverProcess.stdout.on('data', (data) => {
        const output = data.toString();
        outputBuffer += output;
        if (this.dev) process.stdout.write(`  [vscode-server] ${output}`);

        // Parse "Web UI available at http://localhost:<port>"
        const readyMatch = output.match(/https?:\/\/localhost[:\d]*/i)
          || output.match(/Web UI available at/i);
        if (readyMatch && !readyResolved) {
          readyResolved = true;
          clearTimeout(readyTimeout);
          tunnel.localUrl = `http://localhost:${tunnel.localPort}/?tkn=${tunnel.connectionToken}`;
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: VS Code Server ready at ${tunnel.localUrl}`);
          resolve(true);
        }
      });

      tunnel.serverProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          if (this.dev) console.error(`  [vscode-server] ${output}`);

          // Detect EADDRINUSE and retry with next port
          if (output.includes('EADDRINUSE') || output.includes('address already in use')) {
            if (!readyResolved && retryAttempt < PORT_RETRY_MAX) {
              readyResolved = true;
              clearTimeout(readyTimeout);
              console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: port ${tunnel.localPort} in use, retrying...`);
              try { tunnel.serverProcess.kill(); } catch {}
              tunnel.serverProcess = null;

              // Release old port, allocate new one
              this._reservedPorts.delete(tunnel.localPort);
              const newPort = this._allocatePort();
              if (newPort === null) {
                resolve(false);
                return;
              }
              tunnel.localPort = newPort;
              this._reservedPorts.add(newPort);
              this._spawnServer(sessionId, retryAttempt + 1).then(resolve);
              return;
            }
          }
        }
      });

      tunnel.serverProcess.on('error', (err) => {
        clearTimeout(readyTimeout);
        if (!readyResolved) {
          readyResolved = true;
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: server process error: ${err.message}`);
          resolve(false);
        }
      });

      tunnel.serverProcess.on('exit', (code) => {
        clearTimeout(readyTimeout);
        tunnel.serverProcess = null;

        if (!readyResolved) {
          readyResolved = true;
          resolve(false);
        }

        // Auto-restart if not intentionally stopped
        if (!tunnel.stopping && this.tunnels.has(sessionId)) {
          tunnel._whichDied = 'server';
          this._restart(sessionId);
        }
      });
    });
  }

  // ── Dev Tunnel ───────────────────────────────────────────────

  /**
   * Create the named devtunnel and configure its port.
   * Both commands are idempotent — "Conflict" means it already exists.
   */
  async _ensureDevtunnel(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel || tunnel.stopping) return false;

    // Step 1: Create the tunnel (allow anonymous so token handles access control)
    const tunnelCreated = await this._execDevtunnel(
      ['create', tunnel.tunnelId, '--allow-anonymous'],
      sessionId
    );
    if (!tunnelCreated) return false;

    // Step 2: Configure the port (best-effort — GitHub auth may lack manage:ports scope)
    const portCreated = await this._execDevtunnel(
      ['port', 'create', tunnel.tunnelId, '-p', String(tunnel.localPort)],
      sessionId
    );
    if (!portCreated) {
      console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: port pre-configuration failed (likely GitHub auth scope limitation). Will pass port directly to host command.`);
    }

    return true;
  }

  /**
   * Run a devtunnel command. Returns true on success or "Conflict" (already exists).
   */
  async _execDevtunnel(args, sessionId) {
    return new Promise((resolve) => {
      execFile(this._devtunnelCommand, args, { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          const output = (stderr || stdout || '').toString();
          if (output.includes('Conflict')) {
            resolve(true);
          } else {
            console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel ${args[0]} failed: ${output || err.message}`);
            resolve(false);
          }
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Spawn `devtunnel host` and wait for the public URL.
   */
  async _spawnTunnel(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel || tunnel.stopping) return;

    const args = ['host', tunnel.tunnelId, '-p', String(tunnel.localPort)];

    return new Promise((resolve) => {
      // devtunnel is a standalone binary — no shell: true needed
      tunnel.tunnelProcess = spawn(this._devtunnelCommand, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let urlResolved = false;

      const urlTimeout = setTimeout(() => {
        if (!urlResolved) {
          urlResolved = true;
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel started but no URL within ${URL_TIMEOUT_MS / 1000}s`);
          resolve();
        }
      }, URL_TIMEOUT_MS);

      tunnel.tunnelProcess.stdout.on('data', (data) => {
        const output = data.toString();
        if (this.dev) process.stdout.write(`  [devtunnel] ${output}`);

        const match = output.match(/https:\/\/[\w.-]+\.devtunnels\.ms[^\s,]*/);
        if (match && !tunnel.publicUrl) {
          // Append connection token to the public URL
          const baseUrl = match[0].trim();
          const separator = baseUrl.includes('?') ? '&' : '?';
          tunnel.publicUrl = `${baseUrl}${separator}tkn=${tunnel.connectionToken}`;
          tunnel.status = 'running';
          urlResolved = true;
          clearTimeout(urlTimeout);
          this._startStabilityTimer(tunnel);
          this._emitEvent(sessionId, 'vscode_tunnel_started', {
            url: tunnel.publicUrl,
            localUrl: tunnel.localUrl,
            publicUrl: tunnel.publicUrl,
          });
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: tunnel active at ${tunnel.publicUrl}`);
          resolve();
        }
      });

      tunnel.tunnelProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          if (this.dev) console.error(`  [devtunnel] ${output}`);
          if (output.toLowerCase().includes('error') || output.toLowerCase().includes('failed')) {
            this._emitEvent(sessionId, 'vscode_tunnel_error', { message: output });
          }
        }
      });

      tunnel.tunnelProcess.on('error', (err) => {
        clearTimeout(urlTimeout);
        console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel process error: ${err.message}`);
        if (!urlResolved) {
          urlResolved = true;
          resolve();
        }
      });

      tunnel.tunnelProcess.on('exit', (code) => {
        clearTimeout(urlTimeout);
        tunnel.tunnelProcess = null;

        if (!urlResolved) {
          urlResolved = true;
          resolve();
        }

        // Auto-restart tunnel only (server may still be alive)
        if (!tunnel.stopping && this.tunnels.has(sessionId)) {
          tunnel._whichDied = 'tunnel';
          this._restart(sessionId);
        }
      });
    });
  }

  // ── Resilience ───────────────────────────────────────────────

  /**
   * Start the stability timer. After STABILITY_THRESHOLD_MS of uptime,
   * reset retryCount so future crashes get a fresh retry budget.
   */
  _startStabilityTimer(tunnel) {
    this._clearStabilityTimer(tunnel);
    tunnel._stabilityTimer = setTimeout(() => {
      if (tunnel.retryCount > 0) {
        console.warn(`[VSCODE-TUNNEL] Session ${tunnel.sessionId} stable for ${STABILITY_THRESHOLD_MS / 1000}s — retry counter reset (was ${tunnel.retryCount}).`);
        tunnel.retryCount = 0;
      }
    }, STABILITY_THRESHOLD_MS);
    if (tunnel._stabilityTimer.unref) {
      tunnel._stabilityTimer.unref();
    }
  }

  _clearStabilityTimer(tunnel) {
    if (tunnel._stabilityTimer) {
      clearTimeout(tunnel._stabilityTimer);
      tunnel._stabilityTimer = null;
    }
  }

  /**
   * Auto-restart with capped exponential backoff.
   * Behavior depends on which process died:
   *   - tunnel only: restart tunnel, server stays alive (degraded)
   *   - server: kill tunnel too, restart both
   */
  async _restart(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel || tunnel.stopping) return;

    tunnel._totalRestarts++;
    tunnel.retryCount++;
    this._clearStabilityTimer(tunnel);

    const whichDied = tunnel._whichDied || 'server';
    tunnel._whichDied = null;

    const uptimeMs = tunnel._lastSpawnTime ? Date.now() - tunnel._lastSpawnTime : 0;
    const uptimeStr = uptimeMs > 60000
      ? `${(uptimeMs / 60000).toFixed(1)}m`
      : `${(uptimeMs / 1000).toFixed(0)}s`;

    if (tunnel.retryCount > MAX_RETRIES) {
      tunnel.status = 'error';
      tunnel.lastError = `Tunnel crashed ${MAX_RETRIES} times in quick succession. Giving up.`;
      this._emitEvent(sessionId, 'vscode_tunnel_error', {
        message: tunnel.lastError,
        fatal: true,
      });
      console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: ${tunnel.lastError} Total lifetime restarts: ${tunnel._totalRestarts}. Last uptime: ${uptimeStr}.`);
      // Kill remaining process
      if (tunnel.serverProcess) await this._killProcess(tunnel.serverProcess);
      if (tunnel.tunnelProcess) await this._killProcess(tunnel.tunnelProcess);
      this._cleanupTunnel(sessionId);
      return;
    }

    const delay = Math.min(
      Math.pow(2, tunnel.retryCount - 1) * MIN_RESTART_DELAY_MS,
      MAX_RESTART_DELAY_MS
    );

    if (whichDied === 'tunnel' && tunnel.serverProcess) {
      // Tunnel died but server is still alive — degraded mode
      tunnel.status = 'degraded';
      tunnel.publicUrl = null;
      this._emitEvent(sessionId, 'vscode_tunnel_status', {
        status: 'degraded',
        localUrl: tunnel.localUrl,
        attempt: tunnel.retryCount,
        maxRetries: MAX_RETRIES,
      });
      console.warn(
        `[VSCODE-TUNNEL] Session ${sessionId}: tunnel lost after ${uptimeStr}. ` +
        `Server still running. Restarting tunnel in ${delay / 1000}s ` +
        `(attempt ${tunnel.retryCount}/${MAX_RETRIES}).`
      );
    } else {
      // Server died — kill tunnel too, restart both
      if (tunnel.tunnelProcess) {
        try { tunnel.tunnelProcess.kill(); } catch {}
        tunnel.tunnelProcess = null;
      }
      tunnel.status = 'restarting';
      tunnel.localUrl = null;
      tunnel.publicUrl = null;
      this._emitEvent(sessionId, 'vscode_tunnel_status', {
        status: 'restarting',
        attempt: tunnel.retryCount,
        maxRetries: MAX_RETRIES,
      });
      console.warn(
        `[VSCODE-TUNNEL] Session ${sessionId}: server lost after ${uptimeStr}. ` +
        `Restarting in ${delay / 1000}s (attempt ${tunnel.retryCount}/${MAX_RETRIES}, ` +
        `lifetime restarts: ${tunnel._totalRestarts}).`
      );
    }

    // Wait with backoff
    await new Promise((resolve) => {
      tunnel._restartDelayResolve = resolve;
      tunnel._restartDelayTimer = setTimeout(resolve, delay);
      if (tunnel._restartDelayTimer.unref) {
        tunnel._restartDelayTimer.unref();
      }
    });
    tunnel._restartDelayResolve = null;

    if (tunnel.stopping || !this.tunnels.has(sessionId)) return;

    if (whichDied === 'tunnel' && tunnel.serverProcess) {
      // Restart tunnel only
      tunnel.status = 'starting';
      const tunnelReady = await this._ensureDevtunnel(sessionId);
      if (tunnelReady && !tunnel.stopping) {
        await this._spawnTunnel(sessionId);
      }
    } else {
      // Restart both
      tunnel.status = 'starting';
      const serverOk = await this._spawnServer(sessionId);
      if (serverOk && !tunnel.stopping) {
        await this._waitForPort(tunnel.localPort, PORT_WAIT_TIMEOUT_MS);
        if (!tunnel.stopping) {
          const tunnelReady = await this._ensureDevtunnel(sessionId);
          if (tunnelReady && !tunnel.stopping) {
            await this._spawnTunnel(sessionId);
          }
        }
      }
    }
  }

  /**
   * Periodic health check — detect externally killed processes.
   */
  _ensureHealthCheck() {
    if (this._healthInterval) return;
    this._healthInterval = setInterval(() => {
      for (const [sessionId, tunnel] of this.tunnels) {
        if (tunnel.stopping) continue;

        const serverDead = tunnel.status !== 'starting' && tunnel.status !== 'restarting'
          && (!tunnel.serverProcess || tunnel.serverProcess.exitCode !== null);
        const tunnelDead = tunnel.status !== 'starting' && tunnel.status !== 'restarting'
          && (!tunnel.tunnelProcess || tunnel.tunnelProcess.exitCode !== null);

        if (serverDead && (tunnel.status === 'running' || tunnel.status === 'degraded')) {
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: server process died externally`);
          tunnel._whichDied = 'server';
          this._restart(sessionId);
        } else if (tunnelDead && tunnel.status === 'running') {
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: tunnel process died externally`);
          tunnel._whichDied = 'tunnel';
          this._restart(sessionId);
        }
      }

      if (this.tunnels.size === 0) {
        clearInterval(this._healthInterval);
        this._healthInterval = null;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  // ── Install Instructions ─────────────────────────────────────

  _installInstructions() {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    let instructions = 'VS Code CLI not found. Install VS Code from https://code.visualstudio.com/download';
    if (isWin) {
      instructions += '\nThen run "Install \'code\' command in PATH" from the VS Code Command Palette.';
    } else if (isMac) {
      instructions += '\nThen run "Shell Command: Install \'code\' command in PATH" from VS Code.';
    } else {
      instructions += '\nThe `code` command is usually added to PATH automatically after installation.';
    }
    return instructions;
  }

  _devtunnelInstallInstructions() {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    let instructions = 'devtunnel CLI not found. Install it:';
    if (isWin) {
      instructions += '\n  winget install Microsoft.devtunnel';
    } else if (isMac) {
      instructions += '\n  brew install --cask devtunnel';
    } else {
      instructions += '\n  curl -sL https://aka.ms/DevTunnelCliInstall | bash';
    }
    return instructions;
  }

  _getInstallInfo() {
    try {
      const InstallAdvisor = require('./install-advisor');
      const advisor = new InstallAdvisor();
      return advisor.getInstallInfo('vscode');
    } catch {
      return null;
    }
  }

  clearAvailabilityCache() {
    this._command = null;
    this._commandChecked = false;
    this._available = false;
    this._devtunnelCommand = null;
    this._devtunnelChecked = false;
    this._devtunnelAvailable = false;
    this._initPromise = Promise.all([
      this._findCommand().then((cmd) => {
        this._command = cmd;
        this._commandChecked = true;
        this._available = !!cmd;
      }),
      this._findDevtunnelCommand().then((cmd) => {
        this._devtunnelCommand = cmd;
        this._devtunnelChecked = true;
        this._devtunnelAvailable = !!cmd;
      }),
    ]);
  }
}

module.exports = { VSCodeTunnelManager };
