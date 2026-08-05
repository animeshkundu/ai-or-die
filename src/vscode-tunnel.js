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
const PROBE_TIMEOUT_MS = 5000;
const OUTPUT_TAIL_BYTES = 4096;
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
    this._spawnProcess = options._spawnProcess || spawn;

    // PROC-02 gap 3: per-instance stability-threshold override so the
    // regression test (test/longevity/process/vscode-tunnel-respawn.test.js
    // test 3) can verify the reset-on-stable-uptime path without waiting
    // 60 s of wall-clock per cycle. Mirrors tunnel-manager.js:36.
    this._stabilityThresholdMs = options._stabilityThresholdMs || STABILITY_THRESHOLD_MS;
    this._urlTimeoutMs = options._urlTimeoutMs || URL_TIMEOUT_MS;
    this._probeTimeoutMs = options._probeTimeoutMs || PROBE_TIMEOUT_MS;

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
    this._authProvider = null;

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
      await this.stop(sessionId);
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
      _serverFailure: null,
      // Diagnose-only counters for the startup stdout closures below. The
      // buffers themselves intentionally remain untouched in this audit.
      _serverOutputBytes: 0,
      _loginOutputBytes: 0,
    };
    this.tunnels.set(sessionId, tunnel);
    this._reservedPorts.add(localPort);

    this._emitEvent(sessionId, 'vscode_tunnel_status', { status: 'starting' });
    console.warn(`[VSCODE-TUNNEL] Starting for session ${sessionId} (port: ${localPort}, cwd: ${tunnel.workingDir})`);

    // Check devtunnel auth (OS-level credential store)
    const authed = await this._checkDevtunnelAuth(tunnel);
    if (!authed) {
      const authCheck = tunnel._authCheck || this._lastAuthCheck;
      if (authCheck && authCheck.error === 'cli_too_old') {
        this._cleanupTunnel(sessionId);
        return { success: false, ...authCheck };
      }
      console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel not authenticated, starting login flow`);
      this._emitEvent(sessionId, 'vscode_tunnel_error', {
        error: 'auth_required',
        message: (authCheck && authCheck.message)
          || 'Dev Tunnel is not authenticated. Run `devtunnel user login` on the server, or complete the sign-in flow shown here.',
      });
      const loginOk = await this._loginDevtunnel(sessionId);
      if (tunnel.stopping) {
        this._cleanupTunnel(sessionId);
        return { success: false, error: 'Tunnel start cancelled' };
      }
      if (!loginOk) {
        tunnel.status = 'error';
        tunnel.lastError = 'Dev Tunnel authentication failed or was cancelled. Run `devtunnel user login` on the server, then click Retry.';
        this._cleanupTunnel(sessionId);
        return { success: false, error: 'auth_required', message: tunnel.lastError };
      }
      console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel login successful`);
      // Re-check to detect auth provider after fresh login
      if (!(await this._checkDevtunnelAuth(tunnel))
        && (!tunnel._authCheck || tunnel._authCheck.explicit !== false)) {
        tunnel.status = 'error';
        tunnel.lastError = 'Dev Tunnel sign-in did not produce an authenticated session. Run `devtunnel user login` on the server, then click Retry.';
        this._cleanupTunnel(sessionId);
        return { success: false, error: 'auth_failed', message: tunnel.lastError };
      }
    }

    // Update tunnel ID with auth-provider suffix after detection
    if (tunnel._authProvider === 'github') {
      tunnel.tunnelId = `aiordie-vscode-${sessionId.slice(0, 12).replace(/[^a-z0-9-]/gi, '')}-gh`;
    }

    // Start health check interval (once)
    this._ensureHealthCheck();

    // Spawn VS Code Server
    const serverOk = await this._spawnServer(sessionId);
    if (!serverOk) {
      const current = this.tunnels.get(sessionId);
      const failure = (current && current._serverFailure) || {
        error: 'server_start_failed',
        message: 'VS Code Server failed to start. Check the `code serve-web` output and installation, then click Retry.',
      };
      if (current) {
        current.stopping = true;
        if (current.serverProcess) await this._killProcess(current.serverProcess);
        this._cleanupTunnel(sessionId);
      }
      return { success: false, ...failure };
    }

    // The CLI can print a readiness-looking line before its listener is
    // reachable. Do not publish either a public or local URL until TCP proves
    // that the local VS Code endpoint is usable.
    const portReady = await this._waitForPort(tunnel.localPort, PORT_WAIT_TIMEOUT_MS);
    if (!portReady) {
      const current = this.tunnels.get(sessionId);
      const failure = {
        error: 'server_start_failed',
        message: `VS Code Server did not accept connections on port ${tunnel.localPort}. Check the \`code serve-web\` output, then click Retry.`,
      };
      if (current) {
        current.stopping = true;
        if (current.serverProcess) await this._killProcess(current.serverProcess);
        this._cleanupTunnel(sessionId);
      }
      return { success: false, ...failure };
    }

    if (tunnel.stopping) {
      this._cleanupTunnel(sessionId);
      return { success: false, error: 'Tunnel start cancelled' };
    }

    // Create devtunnel and spawn tunnel process
    const tunnelReady = await this._ensureDevtunnel(sessionId);
    if (!(tunnelReady === true || (tunnelReady && tunnelReady.ok))) {
      const failure = tunnelReady && tunnelReady.error
        ? tunnelReady
        : this._classifyDevtunnelFailure('', 'tunnel_create', null);
      return this._degradedResult(tunnel, failure);
    }

    const hostResult = await this._spawnTunnel(sessionId);
    if (!hostResult || !hostResult.ok) {
      const failure = hostResult && hostResult.error
        ? hostResult
        : this._classifyDevtunnelFailure('', 'host', null);
      return this._degradedResult(tunnel, failure);
    }

    const current = this.tunnels.get(sessionId);
    if (current && current.publicUrl) {
      return { success: true, url: current.publicUrl, localUrl: current.localUrl, publicUrl: current.publicUrl };
    } else if (current && current.status === 'error') {
      return this._degradedResult(current, {
        error: 'host_failed',
        message: current.lastError || 'Dev Tunnel failed to start.',
      });
    }

    return this._degradedResult(tunnel, {
      error: 'host_failed',
      message: 'Dev Tunnel did not produce a public URL.',
    });
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
      const execOpts = { timeout: 10000 };
      this._execCommand(this._devtunnelCommand, ['delete', tunnel.tunnelId, '-f'], execOpts, () => {});
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

  _degradedResult(tunnel, failure) {
    const localUrl = tunnel && tunnel.localUrl ? tunnel.localUrl : null;
    const localMessage = localUrl
      ? ` VS Code is still available locally, only from the machine running this server: ${localUrl}`
      : '';
    if (tunnel) {
      tunnel.status = localUrl ? 'degraded' : 'error';
      tunnel.lastError = failure.message;
    }
    return {
      success: false,
      error: failure.error || 'host_failed',
      message: `${failure.message || 'Dev Tunnel failed to start.'}${localMessage}`,
      localUrl,
      publicUrl: null,
    };
  }

  _emitTunnelFailure(sessionId, failure, fatal = false) {
    this._emitEvent(sessionId, 'vscode_tunnel_error', {
      error: failure.error || 'host_failed',
      message: failure.message || 'Dev Tunnel failed to start.',
      ...(failure.localUrl ? { localUrl: failure.localUrl } : {}),
      fatal,
    });
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

  _isCommandScript(command) {
    return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(String(command || ''));
  }

  _cmdLine(command, args) {
    const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
    // Plain tokens are passed through unquoted so batch wrappers that compare
    // %1 directly still match; anything cmd.exe could reinterpret is quoted.
    const isPlainToken = (value) => /^[A-Za-z0-9_.:\\/@+-]+$/.test(value);
    const parts = [quote(command)];
    for (const arg of args) {
      const value = String(arg);
      parts.push(isPlainToken(value) ? value : quote(value));
    }
    // `cmd.exe /s` strips the outermost quote pair before running the line, so
    // the whole line is wrapped exactly as Node does for `shell: true`.
    return `"${parts.join(' ')}"`;
  }

  _spawnCommand(command, args, options) {
    if (this._isCommandScript(command)) {
      return this._spawnProcess(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', this._cmdLine(command, args)],
        { ...options, windowsVerbatimArguments: true }
      );
    }
    return this._spawnProcess(command, args, options);
  }

  _execCommand(command, args, options, callback) {
    if (this._isCommandScript(command)) {
      return execFile(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', this._cmdLine(command, args)],
        { ...options, windowsVerbatimArguments: true },
        callback
      );
    }
    return execFile(command, args, options, callback);
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
   * Also detects auth provider (GitHub vs Entra) for tunnel name suffixing.
   */
  async _checkDevtunnelAuth(tunnel = null) {
    if (!this._devtunnelCommand) return false;
    this._authProvider = null;
    this._lastAuthCheck = null;
    if (tunnel) {
      tunnel._authProvider = null;
      tunnel._authCheck = null;
    }
    const jsonProbe = await this._execDevtunnelProbe(['user', 'show', '--json']);
    const jsonAuth = this._authenticatedIdentityFromJson(jsonProbe.stdout);
    if (jsonAuth) {
      this._authProvider = jsonAuth.provider;
      if (tunnel) tunnel._authProvider = jsonAuth.provider;
      return true;
    }

    const combined = `${jsonProbe.stdout}\n${jsonProbe.stderr}`;
    const explicitLoggedOut = /not\s+logged\s+in|token\s+refresh\s+failed|unauthenticated/i.test(combined);
    if (explicitLoggedOut) {
      this._lastAuthCheck = {
        error: 'auth_required',
        message: 'Dev Tunnel is not authenticated. Run `devtunnel user login` on the server.',
        explicit: true,
      };
      if (tunnel) tunnel._authCheck = this._lastAuthCheck;
      return false;
    }

    const textProbe = await this._execDevtunnelProbe(['user', 'show']);
    const text = `${textProbe.stdout}\n${textProbe.stderr}`;
    const match = text.match(/logged\s+in\s+as\b[\s\S]*?\busing\s+(GitHub|Microsoft|Entra)\b/i);
    if (textProbe.ok && match) {
      this._authProvider = /github/i.test(match[1]) ? 'github' : 'microsoft';
      if (tunnel) tunnel._authProvider = this._authProvider;
      return true;
    }
    const unsupportedJson = /(?:unknown|unrecognized|unsupported|invalid|unexpected).{0,40}(?:option|argument|--json)/i.test(combined);
    const textLoggedOut = /not\s+logged\s+in|token\s+refresh\s+failed|unauthenticated/i.test(text);
    this._lastAuthCheck = unsupportedJson && !textLoggedOut
      ? {
        error: 'cli_too_old',
        message: 'This devtunnel CLI cannot report authentication reliably. Update devtunnel, then run `devtunnel user login`.',
        explicit: false,
      }
      : {
        error: 'auth_required',
        message: 'Dev Tunnel is not authenticated. Run `devtunnel user login` on the server.',
        explicit: textLoggedOut,
      };
    if (tunnel) tunnel._authCheck = this._lastAuthCheck;
    return false;
  }

  _execDevtunnelProbe(args) {
    return new Promise((resolve) => {
      const execOpts = { timeout: this._probeTimeoutMs, killSignal: 'SIGKILL' };
      this._execCommand(this._devtunnelCommand, args, execOpts, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString(),
          error: err || null,
        });
      });
    });
  }

  _authenticatedIdentityFromJson(raw) {
    let parsed;
    try {
      parsed = JSON.parse(String(raw || '').trim());
    } catch (_) {
      return null;
    }
    const text = JSON.stringify(parsed);
    if (/not\s+logged\s+in|token\s+refresh\s+failed|unauthenticated/i.test(text)) return null;

    const values = [];
    const visit = (value, key = '') => {
      if (value && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
      } else if (typeof value === 'string') {
        values.push({ key, value });
      }
    };
    visit(parsed);
    const providerValue = values.find(({ key, value }) =>
      /provider|accountType|authType/i.test(key) && /github|microsoft|entra/i.test(value));
    const identityValue = values.find(({ key, value }) =>
      /user|name|email|identity|account/i.test(key) && value.trim().length > 0);
    const positiveStatus = values.find(({ key, value }) =>
      /status/i.test(key) && /logged\s*in|authenticated|signed\s*in/i.test(value));
    const statusIdentity = positiveStatus && /logged\s*in\s+as\s+\S+/i.test(positiveStatus.value);
    if ((!identityValue && !statusIdentity) || (!providerValue && !positiveStatus)) return null;
    const providerText = providerValue ? providerValue.value : text;
    return { provider: /github/i.test(providerText) ? 'github' : 'microsoft' };
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
      tunnel._loginProcess = this._spawnCommand(this._devtunnelCommand, ['user', 'login'], spawnOptions);
      tunnel._loginOutputBytes = 0;

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
        tunnel._loginOutputBytes += Buffer.byteLength(output);
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
          tunnel._loginOutputBytes += Buffer.byteLength(output);
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
        tunnel._loginOutputBytes = 0;
        if (!resolved) {
          resolved = true;
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel login error: ${err.message}`);
          tunnel._loginProcess = null;
          resolve(false);
        }
      });

      tunnel._loginProcess.on('exit', (code) => {
        clearTimeout(timeout);
        tunnel._loginOutputBytes = 0;
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
      const serverProcess = this._spawnCommand(this._command, args, spawnOptions);
      tunnel.serverProcess = serverProcess;
      tunnel._serverOutputBytes = 0;

      let readyResolved = false;
      let startupSucceeded = false;
      let handedOff = false;
      let outputBuffer = '';

      const readyTimeout = setTimeout(() => {
        if (!readyResolved) {
          readyResolved = true;
          startupSucceeded = true;
          // Server may still be starting — set localUrl optimistically
          tunnel.localUrl = `http://localhost:${tunnel.localPort}/?tkn=${tunnel.connectionToken}`;
          resolve(true);
        }
      }, this._urlTimeoutMs);

      serverProcess.stdout.on('data', (data) => {
        const output = data.toString();
        outputBuffer += output;
        tunnel._serverOutputBytes += Buffer.byteLength(output);
        if (this.dev) process.stdout.write(`  [vscode-server] ${output}`);

        // Parse "Web UI available at http://localhost:<port>"
        const readyMatch = output.match(/https?:\/\/localhost[:\d]*/i)
          || output.match(/Web UI available at/i);
        if (readyMatch && !readyResolved) {
          readyResolved = true;
          startupSucceeded = true;
          clearTimeout(readyTimeout);
          tunnel.localUrl = `http://localhost:${tunnel.localPort}/?tkn=${tunnel.connectionToken}`;
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: VS Code Server ready at ${tunnel.localUrl}`);
          resolve(true);
        }
      });

      serverProcess.stderr.on('data', (data) => {
        if (readyResolved || handedOff) return;
        const output = data.toString().trim();
        if (output) {
          if (this.dev) console.error(`  [vscode-server] ${output}`);

          // Detect EADDRINUSE and retry with next port
          if (output.includes('EADDRINUSE') || output.includes('address already in use')) {
            if (!readyResolved && retryAttempt < PORT_RETRY_MAX) {
              readyResolved = true;
              handedOff = true;
              clearTimeout(readyTimeout);
              console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: port ${tunnel.localPort} in use, retrying...`);
              try { serverProcess.kill(); } catch {}
              if (tunnel.serverProcess === serverProcess) tunnel.serverProcess = null;

              // Keep the conflicting port reserved while selecting the next one,
              // otherwise the allocator would immediately return the same port.
              const previousPort = tunnel.localPort;
              const newPort = this._allocatePort();
              if (newPort === null) {
                tunnel._serverFailure = {
                  error: 'local_port_conflict',
                  message: 'All VS Code Server ports are already in use. Stop the process using ports 9100-9199, then click Retry.',
                };
                resolve(false);
                return;
              }
              this._reservedPorts.delete(previousPort);
              tunnel.localPort = newPort;
              this._reservedPorts.add(newPort);
              this._spawnServer(sessionId, retryAttempt + 1).then(resolve);
              return;
            }
            tunnel._serverFailure = {
              error: 'local_port_conflict',
              message: `VS Code Server port ${tunnel.localPort} is already in use after ${PORT_RETRY_MAX + 1} attempts. Stop the process using it, then click Retry.`,
            };
            readyResolved = true;
            clearTimeout(readyTimeout);
            try { serverProcess.kill(); } catch {}
            if (tunnel.serverProcess === serverProcess) tunnel.serverProcess = null;
            resolve(false);
          }
        }
      });

      serverProcess.on('error', (err) => {
        clearTimeout(readyTimeout);
        if (!readyResolved) {
          readyResolved = true;
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: server process error: ${err.message}`);
          tunnel._serverFailure = {
            error: /EADDRINUSE/i.test(err.message) ? 'local_port_conflict' : 'server_start_failed',
            message: /EADDRINUSE/i.test(err.message)
              ? `VS Code Server port ${tunnel.localPort} is already in use. Stop the process using it, then click Retry.`
              : `VS Code Server could not start: ${err.message}`,
          };
          resolve(false);
        }
      });

      serverProcess.on('exit', (code) => {
        clearTimeout(readyTimeout);
        if (tunnel.serverProcess === serverProcess) {
          tunnel._serverOutputBytes = 0;
          tunnel.serverProcess = null;
        }

        if (!readyResolved) {
          readyResolved = true;
          tunnel._serverFailure = tunnel._serverFailure || {
            error: 'server_start_failed',
            message: `VS Code Server exited before it became ready (exit code ${code}). Check the VS Code CLI installation, then click Retry.`,
          };
          resolve(false);
        }

        // Auto-restart if not intentionally stopped
        if (startupSucceeded && !tunnel.stopping && this.tunnels.has(sessionId)) {
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
    if (!tunnel || tunnel.stopping) {
      return { ok: false, error: 'tunnel_create_failed', message: 'Dev Tunnel creation was cancelled.' };
    }

    // Step 1: Create the tunnel (allow anonymous so token handles access control)
    const tunnelCreated = await this._execDevtunnel(
      ['create', tunnel.tunnelId, '--allow-anonymous'],
      sessionId
    );
    if (!tunnelCreated.ok) {
      return this._classifyDevtunnelFailure(tunnelCreated.output, 'tunnel_create', tunnelCreated.exitCode);
    }

    // Step 2: Configure the port
    const portCreated = await this._execDevtunnel(
      ['port', 'create', tunnel.tunnelId, '-p', String(tunnel.localPort)],
      sessionId
    );
    if (!portCreated.ok) {
      return this._classifyDevtunnelFailure(portCreated.output, 'port_create', portCreated.exitCode);
    }

    return { ok: true };
  }

  /**
   * Run a devtunnel command. "Conflict" means the idempotent resource already exists.
   */
  async _execDevtunnel(args, sessionId) {
    return new Promise((resolve) => {
      const execOpts = { timeout: 15000 };
      this._execCommand(this._devtunnelCommand, args, execOpts, (err, stdout, stderr) => {
        if (err) {
          const output = (stderr || stdout || '').toString();
          if (output.includes('Conflict')) {
            resolve({ ok: true, output, exitCode: err.code });
          } else {
            console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel ${args[0]} failed: ${output || err.message}`);
            resolve({ ok: false, output: output || err.message, exitCode: err.code });
          }
        } else {
          resolve({ ok: true, output: (stdout || stderr || '').toString(), exitCode: 0 });
        }
      });
    });
  }

  _classifyDevtunnelFailure(rawOutput, stage, exitCode) {
    const output = this._outputTail(rawOutput);
    let error;
    let message;
    if (/not\s+logged\s+in|token\s+refresh\s+failed|unauthori[sz]ed|request\s+not\s+permitted|authentication/i.test(output)) {
      error = 'auth_required';
      message = 'Dev Tunnel is not authenticated or authorized. Run `devtunnel user login` on the server, then click Retry.';
    } else if (/address\s+already\s+in\s+use|EADDRINUSE|port.+(?:bound|in use)/i.test(output)) {
      error = 'local_port_conflict';
      message = 'The VS Code port is already in use. Stop the process using that port, then click Retry.';
    } else if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|DNS|name resolution|timed out|connection (?:refused|timed out)|unable to connect/i.test(output)) {
      error = 'network_unreachable';
      message = 'Dev Tunnel could not reach the tunnel service. Check the server network, proxy, and firewall, then click Retry.';
    } else if (/(?:unknown|unrecognized|unsupported|invalid|unexpected).{0,40}(?:option|argument|--allow-anonymous|--json)/i.test(output)) {
      error = 'cli_too_old';
      message = 'The installed devtunnel CLI is too old for this operation. Update devtunnel, then click Retry.';
    } else if (stage === 'tunnel_create') {
      error = 'tunnel_create_failed';
      message = 'Dev Tunnel rejected tunnel creation. Check your account permissions and tunnel quota, then click Retry.';
    } else if (stage === 'port_create') {
      error = 'port_create_failed';
      message = 'Dev Tunnel could not expose the VS Code port. Delete the stale tunnel or choose a free port, then click Retry.';
    } else if (stage === 'url_timeout') {
      error = 'url_timeout';
      message = 'Dev Tunnel started but did not provide a public URL within 30 seconds. Check tunnel service connectivity, then click Retry.';
    } else {
      error = 'host_failed';
      message = 'Dev Tunnel hosting failed. Check the devtunnel output and network, then click Retry.';
    }
    if (output) message += ` Details: ${output}`;
    return { ok: false, error, message, reason: stage, exitCode, stderrTail: output };
  }

  _outputTail(value) {
    const clean = String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    if (Buffer.byteLength(clean) <= OUTPUT_TAIL_BYTES) return clean;
    return Buffer.from(clean).subarray(-OUTPUT_TAIL_BYTES).toString().trim();
  }

  /**
   * Spawn `devtunnel host` and wait for the public URL.
   */
  async _spawnTunnel(sessionId) {
    const tunnel = this.tunnels.get(sessionId);
    if (!tunnel || tunnel.stopping) {
      return { ok: false, error: 'host_failed', message: 'Dev Tunnel hosting was cancelled.' };
    }

    const args = ['host', tunnel.tunnelId];

    return new Promise((resolve) => {
      const spawnOptions = { stdio: ['pipe', 'pipe', 'pipe'] };
      tunnel.tunnelProcess = this._spawnCommand(this._devtunnelCommand, args, spawnOptions);

      let startupSettled = false;
      let startupSucceeded = false;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let outputBuffer = '';
      const appendOutput = (data, stream) => {
        const text = data.toString();
        if (stream === 'stdout') stdoutBuffer = this._outputTail(`${stdoutBuffer}${text}`);
        else stderrBuffer = this._outputTail(`${stderrBuffer}${text}`);
        outputBuffer = this._outputTail(`${stdoutBuffer}\n${stderrBuffer}`);
        const match = outputBuffer.match(/https:\/\/[\w.-]+\.devtunnels\.ms[^\s,\x1b]*/);
        if (match && !tunnel.publicUrl) {
          const baseUrl = match[0].trim();
          const separator = baseUrl.includes('?') ? '&' : '?';
          tunnel.publicUrl = `${baseUrl}${separator}tkn=${tunnel.connectionToken}`;
          tunnel.status = 'running';
          startupSettled = true;
          startupSucceeded = true;
          clearTimeout(urlTimeout);
          this._startStabilityTimer(tunnel);
          this._emitEvent(sessionId, 'vscode_tunnel_started', {
            url: tunnel.publicUrl,
            localUrl: tunnel.localUrl,
            publicUrl: tunnel.publicUrl,
          });
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: tunnel active at ${tunnel.publicUrl}`);
          resolve({ ok: true, url: tunnel.publicUrl });
        }
      };

      const urlTimeout = setTimeout(() => {
        if (!startupSettled) {
          startupSettled = true;
          console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel started but no URL within ${this._urlTimeoutMs / 1000}s`);
          const failure = this._classifyDevtunnelFailure(outputBuffer, 'url_timeout', null);
          try { tunnel.tunnelProcess.kill(); } catch {}
          resolve(failure);
        }
      }, this._urlTimeoutMs);

      tunnel.tunnelProcess.stdout.on('data', (data) => {
        const output = data.toString();
        if (this.dev) process.stdout.write(`  [devtunnel] ${output}`);
        appendOutput(data, 'stdout');
      });

      tunnel.tunnelProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          if (this.dev) console.error(`  [devtunnel] ${output}`);
          appendOutput(data, 'stderr');
        }
      });

      tunnel.tunnelProcess.on('error', (err) => {
        clearTimeout(urlTimeout);
        console.warn(`[VSCODE-TUNNEL] Session ${sessionId}: devtunnel process error: ${err.message}`);
        if (!startupSettled) {
          startupSettled = true;
          resolve(this._classifyDevtunnelFailure(`${outputBuffer}\n${err.message}`, 'host', err.code));
        }
      });

      tunnel.tunnelProcess.on('exit', (code) => {
        clearTimeout(urlTimeout);
        tunnel.tunnelProcess = null;

        if (!startupSettled) {
          startupSettled = true;
          resolve(this._classifyDevtunnelFailure(outputBuffer, 'host', code));
        }

        // Auto-restart tunnel only (server may still be alive)
        if (startupSucceeded && !tunnel.stopping && this.tunnels.has(sessionId)) {
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
    // PROC-02 gap 3: use per-instance override (set in constructor) so
    // tests can shrink the threshold from 60 s.
    const thresholdMs = this._stabilityThresholdMs;
    tunnel._stabilityTimer = setTimeout(() => {
      if (tunnel.retryCount > 0) {
        console.warn(`[VSCODE-TUNNEL] Session ${tunnel.sessionId} stable for ${thresholdMs / 1000}s — retry counter reset (was ${tunnel.retryCount}).`);
        tunnel.retryCount = 0;
      }
    }, thresholdMs);
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

    // PROC-02 gap 2: re-entrancy guard. Both the natural exit handler
    // (~line 843) and the health-check sweep (~line 1005) can call
    // `_restart(sessionId)` for the SAME death event in rapid succession.
    // Without this guard, `_totalRestarts` and `retryCount` are
    // double-incremented and a duplicate respawn cycle is scheduled,
    // which can chew through the MAX_RETRIES budget in half the time.
    // Mirrors the `_restarting` pattern from tunnel-manager.js:96.
    // See docs/audits/proc-child-processes.md gap 2.
    if (tunnel._restarting) return;
    tunnel._restarting = true;

    try {
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
        if (!(tunnelReady === true || (tunnelReady && tunnelReady.ok))) {
          const failure = tunnelReady && tunnelReady.error
            ? tunnelReady
            : this._classifyDevtunnelFailure('', 'tunnel_create', null);
          const result = this._degradedResult(tunnel, failure);
          this._emitTunnelFailure(sessionId, result);
          return;
        }
        if (!tunnel.stopping) {
          const hostResult = await this._spawnTunnel(sessionId);
          if (!hostResult || !hostResult.ok) {
            const failure = hostResult && hostResult.error
              ? hostResult
              : this._classifyDevtunnelFailure('', 'host', null);
            const result = this._degradedResult(tunnel, failure);
            this._emitTunnelFailure(sessionId, result);
          }
        }
      } else {
        // Restart both
        tunnel.status = 'starting';
        const serverOk = await this._spawnServer(sessionId);
        if (!serverOk) {
          const failure = tunnel._serverFailure || {
            error: 'server_start_failed',
            message: 'VS Code Server failed to restart. Check the `code` CLI, then click Retry.',
          };
          tunnel.status = 'error';
          tunnel.lastError = failure.message;
          this._emitTunnelFailure(sessionId, failure, true);
          if (tunnel.serverProcess) await this._killProcess(tunnel.serverProcess);
          this._cleanupTunnel(sessionId);
          return;
        }
        if (tunnel.stopping) return;

        const portReady = await this._waitForPort(tunnel.localPort, PORT_WAIT_TIMEOUT_MS);
        if (!portReady) {
          const failure = {
            error: 'server_start_failed',
            message: `VS Code Server restarted but did not accept connections on port ${tunnel.localPort}. Check the \`code serve-web\` output, then click Retry.`,
          };
          tunnel.status = 'error';
          tunnel.lastError = failure.message;
          tunnel.stopping = true;
          if (tunnel.serverProcess) await this._killProcess(tunnel.serverProcess);
          this._emitTunnelFailure(sessionId, failure, true);
          this._cleanupTunnel(sessionId);
          return;
        }

        if (!tunnel.stopping) {
          const tunnelReady = await this._ensureDevtunnel(sessionId);
          if (!(tunnelReady === true || (tunnelReady && tunnelReady.ok))) {
            const failure = tunnelReady && tunnelReady.error
              ? tunnelReady
              : this._classifyDevtunnelFailure('', 'tunnel_create', null);
            const result = this._degradedResult(tunnel, failure);
            this._emitTunnelFailure(sessionId, result);
            return;
          }
          const hostResult = await this._spawnTunnel(sessionId);
          if (!hostResult || !hostResult.ok) {
            const failure = hostResult && hostResult.error
              ? hostResult
              : this._classifyDevtunnelFailure('', 'host', null);
            const result = this._degradedResult(tunnel, failure);
            this._emitTunnelFailure(sessionId, result);
          }
        }
      }
    } finally {
      tunnel._restarting = false;
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
