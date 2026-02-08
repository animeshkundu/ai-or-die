'use strict';

const { spawn, execFile } = require('child_process');
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

/**
 * Manages VS Code tunnel processes on a per-session basis.
 * Each session can have at most one tunnel; server-wide limit is configurable.
 */
class VSCodeTunnelManager {
  constructor(options = {}) {
    this.tunnels = new Map(); // sessionId → tunnel state
    this.maxTunnels = parseInt(process.env.MAX_VSCODE_TUNNELS || String(DEFAULT_MAX_TUNNELS), 10);
    this.onEvent = options.onEvent || (() => {}); // callback(sessionId, event)
    this.dev = options.dev || false;

    this._command = null;
    this._commandChecked = false;
    this._available = false;
    this._healthInterval = null;

    // Kick off async command discovery at construction time
    this._initPromise = this._findCommand().then((cmd) => {
      this._command = cmd;
      this._commandChecked = true;
      this._available = !!cmd;
    });
  }

  /**
   * Check if VS Code CLI is available (async, waits for discovery).
   */
  async isAvailable() {
    if (!this._commandChecked) await this._initPromise;
    return this._available;
  }

  /**
   * Synchronous availability check (returns cached result).
   * Safe to call after constructor has had time to discover.
   */
  isAvailableSync() {
    return this._available;
  }

  /**
   * Start a VS Code tunnel for the given session.
   */
  async start(sessionId, workingDir) {
    // Already running for this session
    if (this.tunnels.has(sessionId)) {
      const existing = this.tunnels.get(sessionId);
      if (existing.status === 'running' || existing.status === 'starting') {
        return { success: false, error: 'Tunnel already active for this session', url: existing.url };
      }
    }

    // Rate limit
    const activeCount = this._activeCount();
    if (activeCount >= this.maxTunnels) {
      return { success: false, error: `Maximum tunnel limit reached (${this.maxTunnels}). Stop an existing tunnel first.` };
    }

    // Check CLI availability
    const available = await this.isAvailable();
    if (!available) {
      return { success: false, error: 'not_found', message: this._installInstructions() };
    }

    // Check authentication
    const authed = await this._checkAuth();
    if (!authed) {
      // Auth will be handled interactively during spawn — the device code flow
      // output is parsed from stdout and forwarded to the client
    }

    // Create tunnel state
    const tunnel = {
      process: null,
      url: null,
      status: 'starting',
      sessionId,
      workingDir: workingDir || process.cwd(),
      retryCount: 0,
      stopping: false,
      name: `aiordie-${sessionId.slice(0, 12).replace(/[^a-z0-9-]/gi, '')}`,
      // Resilience tracking
      _lastSpawnTime: null,
      _totalRestarts: 0,
      _stabilityTimer: null,
      _restartDelayTimer: null,
      _restartDelayResolve: null,
    };
    this.tunnels.set(sessionId, tunnel);

    this._emitEvent(sessionId, 'vscode_tunnel_status', { status: 'starting' });
    console.warn(`[VSCODE-TUNNEL] Starting tunnel for session ${sessionId} (cwd: ${tunnel.workingDir})`);

    // Start health check interval (once)
    this._ensureHealthCheck();

    // Spawn the tunnel process
    await this._spawn(sessionId);

    const current = this.tunnels.get(sessionId);
    if (current && current.url) {
      return { success: true, url: current.url };
    } else if (current && current.status === 'error') {
      return { success: false, error: current.lastError || 'Failed to start tunnel' };
    }

    return { success: true, url: null }; // still starting (auth flow, etc.)
  }

  /**
   * Stop a VS Code tunnel for the given session.
   */
  async stop(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel) return { success: true };

    tunnel.stopping = true;
    this._clearStabilityTimer(tunnel);

    // Abort any pending restart delay
    clearTimeout(tunnel._restartDelayTimer);
    if (tunnel._restartDelayResolve) {
      tunnel._restartDelayResolve();
      tunnel._restartDelayResolve = null;
    }

    if (tunnel.process) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          try { tunnel.process.kill('SIGKILL'); } catch {}
          resolve();
        }, 5000);

        tunnel.process.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });

        try { tunnel.process.kill(); } catch {}
      });
    }

    this.tunnels.delete(sessionId);
    this._emitEvent(sessionId, 'vscode_tunnel_status', { status: 'stopped' });
    console.warn(`[VSCODE-TUNNEL] Stopped tunnel for session ${sessionId}`);
    return { success: true };
  }

  /**
   * Get the status of a tunnel for a session.
   */
  getStatus(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel) return { status: 'stopped', url: null };
    return {
      status: tunnel.status,
      url: tunnel.url,
      pid: tunnel.process ? tunnel.process.pid : null,
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
      if (t.status === 'running' || t.status === 'starting') count++;
    }
    return count;
  }

  _emitEvent(sessionId, type, data) {
    this.onEvent(sessionId, { type, ...data });
  }

  /**
   * Locate the `code` CLI executable.
   */
  async _findCommand() {
    const isWin = process.platform === 'win32';
    const home = os.homedir();

    // Platform-specific candidate paths
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

    // Try absolute paths first
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not found, continue
      }
    }

    // Fallback: PATH lookup
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

  /**
   * Check if the user is authenticated with VS Code tunnels.
   */
  async _checkAuth() {
    if (!this._command) return false;
    const opts = { timeout: 5000 };
    // Windows .cmd/.bat files need shell to execute
    if (process.platform === 'win32') opts.shell = true;
    return new Promise((resolve) => {
      execFile(this._command, ['tunnel', 'user', 'show'], opts, (err) => {
        resolve(!err);
      });
    });
  }

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

  /**
   * Spawn the `code tunnel` process and wait for the URL.
   */
  async _spawn(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel || tunnel.stopping) return;

    const args = [
      'tunnel',
      '--accept-server-license-terms',
      '--no-sleep',
      '--name', tunnel.name,
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
      tunnel.process = spawn(this._command, args, spawnOptions);

      let urlResolved = false;
      let outputBuffer = '';

      // Timeout: if no URL appears within 30s, warn
      const urlTimeout = setTimeout(() => {
        if (!urlResolved) {
          urlResolved = true;
          // Don't kill — it might still be in auth flow. Just resolve.
          resolve();
        }
      }, URL_TIMEOUT_MS);

      tunnel.process.stdout.on('data', (data) => {
        const output = data.toString();
        outputBuffer += output;
        if (this.dev) process.stdout.write(`  [vscode-tunnel] ${output}`);

        // Check for device code auth prompt
        const authMatch = output.match(/https:\/\/github\.com\/login\/device/i)
          || outputBuffer.match(/https:\/\/github\.com\/login\/device/i);
        if (authMatch) {
          // Extract the code (usually appears as "enter code XXXX-YYYY")
          const codeMatch = outputBuffer.match(/code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
          const deviceCode = codeMatch ? codeMatch[1] : null;
          this._emitEvent(sessionId, 'vscode_tunnel_auth', {
            authUrl: 'https://github.com/login/device',
            deviceCode,
          });
        }

        // Also check for Microsoft login device code
        const msAuthMatch = output.match(/https:\/\/microsoft\.com\/devicelogin/i)
          || outputBuffer.match(/https:\/\/microsoft\.com\/devicelogin/i);
        if (msAuthMatch) {
          const codeMatch = outputBuffer.match(/code\s+([A-Z0-9]{6,9})/i);
          const deviceCode = codeMatch ? codeMatch[1] : null;
          this._emitEvent(sessionId, 'vscode_tunnel_auth', {
            authUrl: 'https://microsoft.com/devicelogin',
            deviceCode,
          });
        }

        // Check for tunnel URL
        const urlMatch = output.match(/https:\/\/vscode\.dev\/tunnel\/[^\s,)>]*/);
        if (urlMatch && !tunnel.url) {
          tunnel.url = urlMatch[0].trim();
          tunnel.status = 'running';
          urlResolved = true;
          clearTimeout(urlTimeout);
          this._startStabilityTimer(tunnel);
          this._emitEvent(sessionId, 'vscode_tunnel_started', { url: tunnel.url });
          resolve();
        }
      });

      tunnel.process.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          if (this.dev) console.error(`  [vscode-tunnel] ${output}`);
          // Forward significant errors
          if (output.toLowerCase().includes('error') || output.toLowerCase().includes('failed')) {
            this._emitEvent(sessionId, 'vscode_tunnel_error', { message: output });
          }
        }
      });

      tunnel.process.on('error', (err) => {
        clearTimeout(urlTimeout);
        tunnel.status = 'error';
        tunnel.lastError = err.message;
        this._emitEvent(sessionId, 'vscode_tunnel_error', { message: err.message });
        if (!urlResolved) {
          urlResolved = true;
          resolve();
        }
      });

      tunnel.process.on('exit', (code, signal) => {
        clearTimeout(urlTimeout);
        this._clearStabilityTimer(tunnel);
        tunnel.process = null;

        if (!urlResolved) {
          urlResolved = true;
          resolve();
        }

        // Auto-restart if not intentionally stopped
        if (!tunnel.stopping && code !== 0) {
          this._restart(sessionId);
        } else if (!tunnel.stopping) {
          // Clean exit
          tunnel.status = 'stopped';
          this.tunnels.delete(sessionId);
          this._emitEvent(sessionId, 'vscode_tunnel_status', { status: 'stopped' });
        }
      });
    });
  }

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
   * retryCount resets after stable uptime via _startStabilityTimer().
   */
  async _restart(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel || tunnel.stopping) return;

    tunnel._totalRestarts++;
    tunnel.retryCount++;

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
      this.tunnels.delete(sessionId);
      return;
    }

    const delay = Math.min(
      Math.pow(2, tunnel.retryCount - 1) * MIN_RESTART_DELAY_MS,
      MAX_RESTART_DELAY_MS
    );
    tunnel.status = 'restarting';
    this._emitEvent(sessionId, 'vscode_tunnel_status', {
      status: 'restarting',
      attempt: tunnel.retryCount,
      maxRetries: MAX_RETRIES,
    });

    console.warn(
      `[VSCODE-TUNNEL] Session ${sessionId} lost after ${uptimeStr} uptime. ` +
      `Restarting in ${delay / 1000}s (attempt ${tunnel.retryCount}/${MAX_RETRIES}, ` +
      `lifetime restarts: ${tunnel._totalRestarts})...`
    );

    await new Promise((resolve) => {
      tunnel._restartDelayResolve = resolve;
      tunnel._restartDelayTimer = setTimeout(resolve, delay);
      if (tunnel._restartDelayTimer.unref) {
        tunnel._restartDelayTimer.unref();
      }
    });
    tunnel._restartDelayResolve = null;

    if (!tunnel.stopping && this.tunnels.has(sessionId)) {
      tunnel.url = null;
      tunnel.status = 'starting';
      await this._spawn(sessionId);
    }
  }

  /**
   * Periodic health check — detect externally killed tunnel processes.
   */
  _ensureHealthCheck() {
    if (this._healthInterval) return;
    this._healthInterval = setInterval(() => {
      for (const [sessionId, tunnel] of this.tunnels) {
        if (tunnel.status === 'running' && (!tunnel.process || tunnel.process.exitCode !== null)) {
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId} tunnel process died externally`);
          tunnel.status = 'stopped';
          this.tunnels.delete(sessionId);
          this._emitEvent(sessionId, 'vscode_tunnel_status', { status: 'stopped', reason: 'process_died' });
        }
      }

      // Clean up interval if no tunnels active
      if (this.tunnels.size === 0) {
        clearInterval(this._healthInterval);
        this._healthInterval = null;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }
}

module.exports = { VSCodeTunnelManager };
