#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const open = require('open');
const crypto = require('crypto');
const { startServer } = require('../src/server');

const program = new Command();

program
  .name('ai-or-die')
  .description('ai-or-die — Universal AI coding terminal')
  .version('0.1.0')
  .option('-p, --port <number>', 'port to run the server on', '7777')
  .option('--no-open', 'do not automatically open browser')
  .option('--auth <token>', 'authentication token for secure access')
  .option('--disable-auth', 'disable authentication (not recommended for production)')
  .option('--https', 'enable HTTPS (requires cert files)')
  .option('--cert <path>', 'path to SSL certificate file')
  .option('--key <path>', 'path to SSL private key file')
  .option('--dev', 'development mode with additional logging')
  .option('--plan <type>', 'subscription plan (pro, max5, max20)', 'max20')
  .option('--claude-alias <name>', 'display alias for Claude (default: env CLAUDE_ALIAS or "Claude")')
  .option('--codex-alias <name>', 'display alias for Codex (default: env CODEX_ALIAS or "Codex")')
  .option('--copilot-alias <name>', 'display alias for Copilot (default: env COPILOT_ALIAS or "Copilot")')
  .option('--gemini-alias <name>', 'display alias for Gemini (default: env GEMINI_ALIAS or "Gemini")')
  .option('--terminal-alias <name>', 'display alias for Terminal (default: env TERMINAL_ALIAS or "Terminal")')
  .option('--tunnel', 'enable dev tunnel (requires devtunnel CLI installed)')
  .option('--tunnel-allow-anonymous', 'allow anonymous access to dev tunnel')
  .parse();

const options = program.opts();

function generateRandomToken(length = 10) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function main() {
  try {
    const port = parseInt(options.port, 10);

    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Error: Port must be a number between 1 and 65535');
      process.exit(1);
    }

    // Handle authentication logic
    let authToken = null;
    let noAuth = options.disableAuth === true;

    if (!noAuth) {
      if (options.auth) {
        // Use provided token
        authToken = options.auth;
      } else {
        // Generate random token
        authToken = generateRandomToken();
      }
    }

    const serverOptions = {
      port,
      auth: authToken,
      noAuth: noAuth,
      https: options.https,
      cert: options.cert,
      key: options.key,
      dev: options.dev,
      plan: options.plan,
      // UI aliases for assistants
      claudeAlias: options.claudeAlias || process.env.CLAUDE_ALIAS || 'Claude',
      codexAlias: options.codexAlias || process.env.CODEX_ALIAS || 'Codex',
      copilotAlias: options.copilotAlias || process.env.COPILOT_ALIAS || 'Copilot',
      geminiAlias: options.geminiAlias || process.env.GEMINI_ALIAS || 'Gemini',
      terminalAlias: options.terminalAlias || process.env.TERMINAL_ALIAS || 'Terminal',
      folderMode: true // Always use folder mode
    };

    console.log('Starting ai-or-die...');
    console.log(`Port: ${port}`);
    console.log('Mode: Folder selection mode');
    console.log(`Plan: ${options.plan}`);
    console.log(`Aliases: Claude → "${serverOptions.claudeAlias}", Codex → "${serverOptions.codexAlias}", Copilot → "${serverOptions.copilotAlias}", Gemini → "${serverOptions.geminiAlias}", Terminal → "${serverOptions.terminalAlias}"`);

    // Display authentication status prominently
    if (noAuth) {
      console.log('\n⚠️  AUTHENTICATION DISABLED - Server is accessible without a token');
      console.log('   (Use without --disable-auth flag for security in production)');
    } else {
      console.log('\n🔐 AUTHENTICATION ENABLED');
      if (options.auth) {
        console.log('   Using provided authentication token');
      } else {
        console.log('   Generated random authentication token:');
        console.log(`   \x1b[1m\x1b[33m${authToken}\x1b[0m`);
        console.log('   \x1b[2mSave this token - you\'ll need it to access the interface\x1b[0m');
      }
    }

    const server = await startServer(serverOptions);

    const protocol = options.https ? 'https' : 'http';
    const url = `${protocol}://localhost:${port}`;

    console.log(`\n🚀 ai-or-die is running at: ${url}`);

    if (!noAuth) {
      console.log('\n📋 Authentication Required:');
      if (options.auth) {
        console.log('   Use your provided authentication token to access the interface');
      } else {
        console.log(`   Enter this token when prompted: \x1b[1m\x1b[33m${authToken}\x1b[0m`);
      }
    }

    // Dev tunnel setup
    let tunnelProcess = null;
    let publicUrl = null;
    if (options.tunnel) {
      console.log('\n\x1b[36m  Connecting dev tunnel...\x1b[0m');
      try {
        const { spawn: cpSpawn, execFileSync } = require('child_process');

        // Check if devtunnel CLI is available
        const devtunnelCmd = process.platform === 'win32' ? 'where' : 'which';
        try {
          execFileSync(devtunnelCmd, ['devtunnel'], { stdio: 'ignore' });
        } catch (_) {
          const isWin = process.platform === 'win32';
          console.error('\n\x1b[31m  devtunnel CLI not found.\x1b[0m\n');
          console.error('  Install it with a single command:');
          if (isWin) {
            console.error('  \x1b[1mwinget install Microsoft.devtunnel\x1b[0m');
          } else if (process.platform === 'darwin') {
            console.error('  \x1b[1mbrew install --cask devtunnel\x1b[0m');
          } else {
            console.error('  \x1b[1mcurl -sL https://aka.ms/DevTunnelCliInstall | bash\x1b[0m');
          }
          console.error('\n  Then run: \x1b[1mdevtunnel user login\x1b[0m (one-time)\n');
          process.exit(1);
        }

        const tunnelArgs = ['host', '-p', String(port)];
        if (options.tunnelAllowAnonymous) tunnelArgs.push('--allow-anonymous');
        tunnelProcess = cpSpawn('devtunnel', tunnelArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

        tunnelProcess.stdout.on('data', (data) => {
          const match = data.toString().match(/https:\/\/[\w.-]+\.devtunnels\.ms\S*/);
          if (match && !publicUrl) {
            publicUrl = match[0].trim();
            console.log(`\n  \x1b[1m\x1b[32mTunnel ready:\x1b[0m \x1b[1m\x1b[4m${publicUrl}\x1b[0m\n`);
            if (options.open) {
              open(publicUrl).catch(() => {});
            }
          }
        });
        tunnelProcess.stderr.on('data', (data) => {
          const output = data.toString().trim();
          if (output && options.dev) console.log(`  [devtunnel] ${output}`);
        });
        tunnelProcess.on('error', () => {
          console.error('\n  \x1b[31mDev tunnel process failed to start.\x1b[0m');
        });
      } catch (error) {
        console.error('  Failed to start dev tunnel:', error.message);
      }
    } else if (options.open) {
      try { await open(url); } catch (error) {
        console.warn('  Could not automatically open browser:', error.message);
      }
    }

    console.log('\nPress Ctrl+C to stop the server\n');

    const shutdown = async () => {
      console.log('\nShutting down server...');
      // Close dev tunnel first if active
      if (tunnelProcess) { try { tunnelProcess.kill(); } catch (_) {} }
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => { shutdown(); });
    process.on('SIGTERM', () => { shutdown(); });

  } catch (error) {
    console.error('Error starting server:', error.message);
    process.exit(1);
  }
}

main();
