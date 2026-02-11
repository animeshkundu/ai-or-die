#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const crypto = require('crypto');

// Lazy-load open — may not be available in SEA binary
// open v10+ uses ESM default export
let open;
try {
  const openModule = require('open');
  open = openModule.default || openModule;
} catch { open = null; }
const { ClaudeCodeWebServer } = require('../src/server');

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
  .option('--stt', 'enable local speech-to-text (downloads ~670MB Parakeet V3 model on first use)')
  .option('--stt-endpoint <url>', 'use external STT endpoint (OpenAI-compatible)')
  .option('--stt-model-dir <path>', 'custom directory for STT model files')
  .option('--stt-threads <number>', 'CPU threads for STT inference (default: auto, max 4)')
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
    // Tunnel mode disables auth — the tunnel itself controls access
    let authToken = null;
    let noAuth = options.disableAuth === true || options.tunnel === true;

    if (!noAuth) {
      if (options.auth) {
        authToken = options.auth;
      } else {
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
      folderMode: true, // Always use folder mode
      stt: options.stt || !!process.env.STT_ENABLED,
      sttEndpoint: options.sttEndpoint || process.env.STT_ENDPOINT,
      sttModelDir: options.sttModelDir || process.env.AI_OR_DIE_MODELS_DIR,
      sttThreads: options.sttThreads || process.env.STT_THREADS,
    };

    console.log('Starting ai-or-die...');
    console.log(`Port: ${port}`);
    console.log('Mode: Folder selection mode');
    console.log(`Plan: ${options.plan}`);
    console.log(`Aliases: Claude → "${serverOptions.claudeAlias}", Codex → "${serverOptions.codexAlias}", Copilot → "${serverOptions.copilotAlias}", Gemini → "${serverOptions.geminiAlias}", Terminal → "${serverOptions.terminalAlias}"`);

    // Display authentication status
    if (options.tunnel) {
      console.log('\n🌍 TUNNEL MODE — authentication disabled (tunnel controls access)');
    } else if (noAuth) {
      console.log('\n⚠️  AUTHENTICATION DISABLED - Server is accessible without a token');
      console.log('   (Use without --disable-auth flag for security in production)');
    } else {
      console.log('\n🔐 AUTHENTICATION ENABLED');
    }

    const app = new ClaudeCodeWebServer(serverOptions);
    const httpServer = await app.start();

    const protocol = options.https ? 'https' : 'http';
    const baseUrl = `${protocol}://localhost:${port}`;
    // For localhost with auth, embed token in URL so user can just click it
    const url = authToken ? `${baseUrl}?token=${authToken}` : baseUrl;

    console.log(`\n🚀 ai-or-die is running at: \x1b[1m\x1b[4m${url}\x1b[0m`);
    if (authToken) {
      console.log(`   Auth token: \x1b[1m\x1b[33m${authToken}\x1b[0m`);
    }

    // Dev tunnel or browser open
    let tunnel = null;
    if (options.tunnel) {
      const { TunnelManager } = require('../src/tunnel-manager');
      tunnel = new TunnelManager({
        port,
        allowAnonymous: options.tunnelAllowAnonymous,
        dev: options.dev,
        onUrl: (tunnelUrl) => {
          console.log(`\n  \x1b[1m\x1b[32mTunnel ready:\x1b[0m \x1b[1m\x1b[4m${tunnelUrl}\x1b[0m\n`);
          if (open && options.open) open(tunnelUrl).catch(() => {});
        }
      });
      app.setTunnelManager(tunnel);
      await tunnel.start();
    } else if (options.open) {
      try { if (open) await open(url); } catch (error) {
        console.warn('  Could not automatically open browser:', error.message);
      }
    }

    console.log('\nPress Ctrl+C to stop the server\n');

    const shutdown = async () => {
      console.log('\nShutting down server...');
      if (tunnel) await tunnel.stop();
      httpServer.close(() => {
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
