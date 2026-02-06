'use strict';

const { spawn, execFile } = require('child_process');
const os = require('os');

const MAX_RETRIES = 3;
const URL_TIMEOUT_MS = 30000;

class TunnelManager {
  constructor(options = {}) {
    this.port = options.port || 7777;
    this.allowAnonymous = options.allowAnonymous || false;
    this.dev = options.dev || false;
    this.onUrl = options.onUrl || (() => {});

    this.process = null;
    this.publicUrl = null;
    this.stopping = false;
    this.retryCount = 0;
    this.tunnelId = `aiordie-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
  }

  /**
   * Full lifecycle: check CLI → check login → spawn → wait for URL.
   * Never throws — logs errors and continues with localhost if tunnel fails.
   */
  async start() {
    console.log('\n  Connecting dev tunnel...');

    const hasCli = await this._checkCli();
    if (!hasCli) return;

    const loggedIn = await this._checkLogin();
    if (!loggedIn) return;

    const tunnelReady = await this._ensureTunnel();
    if (!tunnelReady) return;

    await this._spawn();
  }

  /**
   * Kill the tunnel process and wait for it to exit.
   */
  async stop() {
    this.stopping = true;
    if (!this.process) return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill after 5s if it hasn't exited
        try { this.process.kill('SIGKILL'); } catch {}
        resolve();
      }, 5000);

      this.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try { this.process.kill(); } catch {}
    });
  }

  /**
   * Check if devtunnel CLI is installed.
   */
  async _checkCli() {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    return new Promise((resolve) => {
      execFile(checker, ['devtunnel'], { timeout: 5000 }, (err) => {
        if (err) {
          const isWin = process.platform === 'win32';
          console.error('\n  \x1b[31mdevtunnel CLI not found.\x1b[0m\n');
          console.error('  Install it with a single command:');
          if (isWin) {
            console.error('  \x1b[1mwinget install Microsoft.devtunnel\x1b[0m');
          } else if (process.platform === 'darwin') {
            console.error('  \x1b[1mbrew install --cask devtunnel\x1b[0m');
          } else {
            console.error('  \x1b[1mcurl -sL https://aka.ms/DevTunnelCliInstall | bash\x1b[0m');
          }
          console.error('\n  Server will continue on localhost only.\n');
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Check if user is logged in. If not, attempt interactive login.
   */
  async _checkLogin() {
    const isLoggedIn = await new Promise((resolve) => {
      execFile('devtunnel', ['user', 'show'], { timeout: 10000 }, (err) => {
        resolve(!err);
      });
    });

    if (isLoggedIn) return true;

    console.log('  DevTunnel requires authentication. Launching login...\n');

    // Run interactive login (inherits stdio so user can interact with browser auth)
    const loginOk = await new Promise((resolve) => {
      const loginProc = spawn('devtunnel', ['user', 'login'], {
        stdio: 'inherit'
      });
      loginProc.on('exit', (code) => resolve(code === 0));
      loginProc.on('error', () => resolve(false));
    });

    if (loginOk) {
      console.log('\n  Login successful. Connecting tunnel...');
      return true;
    }

    console.error('\n  \x1b[33mLogin failed or cancelled. Server will continue on localhost only.\x1b[0m\n');
    return false;
  }

  /**
   * Create the named tunnel and configure its port.
   * Steps: devtunnel create <id> → devtunnel port create <id> -p <port>
   * Both are idempotent — "Conflict" means it already exists, which is fine.
   */
  async _ensureTunnel() {
    // Step 1: Create the tunnel
    const tunnelCreated = await this._execDevtunnel(
      ['create', this.tunnelId, ...(this.allowAnonymous ? ['--allow-anonymous'] : [])],
      `Creating tunnel "${this.tunnelId}"...`,
      `Tunnel "${this.tunnelId}" ready.`
    );
    if (!tunnelCreated) return false;

    // Step 2: Configure the port
    const portCreated = await this._execDevtunnel(
      ['port', 'create', this.tunnelId, '-p', String(this.port)],
      `  Configuring port ${this.port}...`,
      `  Port ${this.port} configured.`
    );
    if (!portCreated) return false;

    return true;
  }

  /**
   * Run a devtunnel command. Returns true on success or "Conflict" (already exists).
   */
  async _execDevtunnel(args, startMsg, successMsg) {
    console.log(`  ${startMsg}`);
    return new Promise((resolve) => {
      execFile('devtunnel', args, { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          const output = (stderr || stdout || '').toString();
          if (output.includes('Conflict')) {
            // Already exists — that's fine
            resolve(true);
          } else {
            console.error(`  [devtunnel] ${output || err.message}`);
            resolve(false);
          }
        } else {
          console.log(`  ${successMsg}`);
          resolve(true);
        }
      });
    });
  }

  /**
   * Spawn the devtunnel host process and wait for the public URL.
   * No -p flag needed — port is already configured via _ensureTunnel().
   */
  async _spawn() {
    const args = ['host', this.tunnelId];

    return new Promise((resolve) => {
      this.process = spawn('devtunnel', args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let urlResolved = false;

      // Timeout: if no URL appears within 30s, warn and continue
      const urlTimeout = setTimeout(() => {
        if (!urlResolved) {
          urlResolved = true;
          console.warn('  \x1b[33mTunnel started but no public URL detected within 30s.\x1b[0m');
          console.warn('  The tunnel may still be connecting. Check devtunnel status manually.\n');
          resolve();
        }
      }, URL_TIMEOUT_MS);

      this.process.stdout.on('data', (data) => {
        const output = data.toString();
        if (this.dev) process.stdout.write(`  [devtunnel] ${output}`);

        const match = output.match(/https:\/\/[\w.-]+\.devtunnels\.ms[^\s,]*/);
        if (match && !this.publicUrl) {
          this.publicUrl = match[0].trim();
          urlResolved = true;
          clearTimeout(urlTimeout);
          this.onUrl(this.publicUrl);
          resolve();
        }
      });

      this.process.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          // Always log stderr — auth errors, rate limits come through here
          console.error(`  [devtunnel] ${output}`);
        }
      });

      this.process.on('error', (err) => {
        clearTimeout(urlTimeout);
        console.error(`  \x1b[31mDev tunnel failed to start: ${err.message}\x1b[0m`);
        if (!urlResolved) {
          urlResolved = true;
          resolve();
        }
      });

      this.process.on('exit', (code, signal) => {
        clearTimeout(urlTimeout);
        this.process = null;

        if (!urlResolved) {
          urlResolved = true;
          resolve();
        }

        // Auto-restart if not intentionally stopped
        if (!this.stopping && code !== 0) {
          this._restart();
        }
      });
    });
  }

  /**
   * Auto-restart with exponential backoff.
   */
  async _restart() {
    this.retryCount++;
    if (this.retryCount > MAX_RETRIES) {
      console.error(`  \x1b[31mTunnel crashed ${MAX_RETRIES} times. Giving up. Server continues on localhost.\x1b[0m\n`);
      return;
    }

    const delay = Math.pow(2, this.retryCount - 1) * 1000; // 1s, 2s, 4s
    console.log(`  Tunnel exited unexpectedly. Restarting in ${delay / 1000}s (attempt ${this.retryCount}/${MAX_RETRIES})...`);

    await new Promise((r) => setTimeout(r, delay));

    if (this.stopping) return;

    this.publicUrl = null;
    await this._spawn();
  }
}

module.exports = { TunnelManager };
