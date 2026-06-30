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
const { isBun } = require('../src/utils/runtime');

const program = new Command();

program
  .name('ai-or-die')
  .description('ai-or-die — Universal AI coding terminal')
  .version(require('../package.json').version)
  .option('-p, --port <number>', 'port to run the server on', '7777')
  .option('--open', 'open the browser on start (default: off; never on supervised restart)')
  .option('--auth <token>', 'authentication token for secure access')
  .option('--disable-auth', 'disable authentication (not recommended for production)')
  .option('--https', 'enable HTTPS (auto-generates self-signed cert if --cert/--key not provided)')
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
  .option('--mesh', 'expose this instance over a permanent Tailscale mesh (userspace; requires tailscale installed; set AIORDIE_TS_AUTHKEY to enroll)')
  .option('--no-stt', 'disable local speech-to-text (on by default; downloads ~670MB Parakeet V3 model on first use)')
  .option('--stt-endpoint <url>', 'use external STT endpoint (OpenAI-compatible)')
  .option('--stt-model-dir <path>', 'custom directory for STT model files')
  .option('--stt-threads <number>', 'CPU threads for STT inference (default: auto, max 4)')
  .option('--no-sticky-notes', 'disable per-tab AI session summaries + auto tab titles (on by default)')
  .option('--sticky-notes-model-dir <path>', 'custom directory for the sticky-note model file')
  .option('--sticky-notes-model <url>', 'override the sticky-note model GGUF download URL')
  .option('--sticky-notes-threads <number>', 'CPU threads for sticky-note inference (default: auto — three-quarters of the cores on CPU, gentle on GPU)')
  .option('--no-keepalive', 'disable keeping the machine awake while the server runs (Windows only; on by default)')
  .option('--keepalive-display', 'also keep the display on (default keeps the system awake but lets the monitor sleep)');

// Auto-open is OFF by default and opt-in via --open. Legacy callers may still pass
// --no-open (the old opt-out flag); filter it out so it parses harmlessly as a no-op.
program.parse(process.argv.filter((arg) => arg !== '--no-open'));

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

    // Bun: limited support. The app continues to run, but two native
    // incompatibilities apply (both externally confirmed, neither fixable here):
    //   • node-llama-cpp's N-API addon crashes Bun (NAPI FATAL ERROR, exit 133),
    //     so the sticky-note model is force-disabled (server + engine self-gate).
    //   • node-pty cannot read the PTY master under Bun (oven-sh/bun#25822) — the
    //     terminal may "start" but never show a prompt (it hangs).
    // STT still works under Bun. For a guaranteed-working terminal, use Node.js.
    if (isBun()) {
      const bunVer = (process.versions && process.versions.bun) || 'unknown';
      console.log(`\n\x1b[33m⚠  Running under Bun ${bunVer} — limited support. Continuing with sticky-notes disabled.\x1b[0m`);
      console.log('   • Sticky-note summaries are disabled under Bun (node-llama-cpp crashes Bun’s N-API).');
      console.log('   • Heads-up: terminal output can hang under Bun (node-pty/#25822).');
      console.log('     If the prompt never appears, run with Node.js instead:');
      console.log(`       \x1b[1mnode ${path.relative(process.cwd(), __filename) || 'bin/ai-or-die.js'} ${process.argv.slice(2).join(' ')}\x1b[0m\n`);
    }

    // Handle authentication logic
    // Tunnel mode disables auth — the tunnel controls access — even with --mesh.
    // (--mesh alone keeps the Bearer token on; --tunnel always wins.)
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
      // Mesh terminates real TLS at the tailnet edge (the sidecar serves the
      // <host>.ts.net cert) and reverse-proxies to a loopback backend, so in
      // mesh mode the local server stays plain HTTP on 127.0.0.1 regardless of
      // --https. (Mesh forces a loopback-only bind anyway, so --https's LAN
      // secure-context role does not apply.) --https WITHOUT --mesh is unchanged.
      https: options.mesh ? false : options.https,
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
      stt: options.stt !== false && process.env.STT_DISABLED !== '1',
      sttEndpoint: options.sttEndpoint || process.env.STT_ENDPOINT,
      sttModelDir: options.sttModelDir || process.env.AI_OR_DIE_MODELS_DIR,
      sttThreads: options.sttThreads || process.env.STT_THREADS,
      // Per-tab AI session summaries (on by default; --no-sticky-notes disables).
      stickyNotes: options.stickyNotes !== false && process.env.STICKY_NOTES_DISABLED !== '1',
      stickyNotesModelDir: options.stickyNotesModelDir || process.env.STICKY_NOTES_MODEL_DIR,
      stickyNotesModel: options.stickyNotesModel || process.env.STICKY_NOTES_MODEL,
      stickyNotesThreads: options.stickyNotesThreads || process.env.STICKY_NOTES_THREADS,
      // Keep the host awake while the server runs (Windows only; on by default;
      // --no-keepalive / AIORDIE_DISABLE_KEEPALIVE=1 disables). System-awake by
      // default; --keepalive-display / AIORDIE_KEEPALIVE_DISPLAY=1 also holds
      // the display on.
      keepalive: options.keepalive !== false && process.env.AIORDIE_DISABLE_KEEPALIVE !== '1',
      keepaliveDisplay: options.keepaliveDisplay === true || process.env.AIORDIE_KEEPALIVE_DISPLAY === '1',
      // Mesh binds loopback-only always: the tailnet `serve` proxy reaches the
      // port, the LAN never does (even with --https). Other modes: all interfaces.
      bindHost: options.mesh ? '127.0.0.1' : undefined,
    };

    console.log('Starting ai-or-die...');
    console.log(`Port: ${port}`);
    console.log('Mode: Folder selection mode');
    console.log(`Plan: ${options.plan}`);
    console.log(`Aliases: Claude → "${serverOptions.claudeAlias}", Codex → "${serverOptions.codexAlias}", Copilot → "${serverOptions.copilotAlias}", Gemini → "${serverOptions.geminiAlias}", Terminal → "${serverOptions.terminalAlias}"`);

    // Display authentication status. --tunnel disables auth (tunnel controls
    // access) even with --mesh; --mesh alone keeps the Bearer token on.
    if (options.tunnel) {
      console.log('\n🌍 TUNNEL MODE — authentication disabled (tunnel controls access)');
    } else if (noAuth) {
      console.log('\n⚠️  AUTHENTICATION DISABLED - Server is accessible without a token');
      console.log('   (Use without --disable-auth flag for security in production)');
    } else {
      console.log('\n🔐 AUTHENTICATION ENABLED');
    }

    const app = new ClaudeCodeWebServer(serverOptions);
    await app.start();

    const protocol = serverOptions.https ? 'https' : 'http';
    const baseUrl = `${protocol}://localhost:${port}`;
    // For localhost with auth, embed token in URL so user can just click it
    const url = authToken ? `${baseUrl}?token=${authToken}` : baseUrl;

    console.log(`\n🚀 ai-or-die is running at: \x1b[1m\x1b[4m${url}\x1b[0m`);
    if (authToken) {
      console.log(`   Auth token: \x1b[1m\x1b[33m${authToken}\x1b[0m`);
    }

    // Warn if STT is enabled without HTTPS or tunnel. Skip in mesh mode: it
    // binds loopback-only (no LAN), the mic works on http://localhost locally,
    // and remotely via the mesh edge's real TLS.
    if ((serverOptions.stt || serverOptions.sttEndpoint) && !options.https && !options.tunnel && !options.mesh) {
      console.log('\n\x1b[33m⚠  STT enabled over plain HTTP \u2014 microphone only works on localhost.\x1b[0m');
      console.log('   For LAN access, restart with \x1b[1m--https\x1b[0m or \x1b[1m--tunnel\x1b[0m.');
    }

    // Dev tunnel or browser open.
    // Auto-open only when explicitly requested (--open) AND this is the first launch,
    // never on a supervised restart (the supervisor sets AOD_SUPERVISOR_RESTART on respawn),
    // so crash/memory restarts don't spawn a new browser tab each time.
    const shouldOpen = !!options.open && !process.env.AOD_SUPERVISOR_RESTART;
    let tunnel = null;
    if (options.tunnel) {
      const { TunnelManager } = require('../src/tunnel-manager');
      tunnel = new TunnelManager({
        port,
        allowAnonymous: options.tunnelAllowAnonymous,
        dev: options.dev,
        onUrl: (tunnelUrl) => {
          console.log(`\n  \x1b[1m\x1b[32mTunnel ready:\x1b[0m \x1b[1m\x1b[4m${tunnelUrl}\x1b[0m\n`);
          if (open && shouldOpen) open(tunnelUrl).catch(() => {});
        }
      });
      app.setTunnelManager(tunnel);
      await tunnel.start();
    } else if (shouldOpen) {
      try { if (open) await open(url); } catch (error) {
        console.warn('  Could not automatically open browser:', error.message);
      }
    }

    // Mesh: permanent Tailscale reachability. Coexists with --tunnel (mesh for
    // owned devices, tunnel fallback for borrowed ones). Auth token stays ON.
    if (options.mesh) {
      if (options.https) {
        console.log('\n  \x1b[33mNote: --https is handled by the mesh edge (real .ts.net TLS); the local server stays HTTP on loopback.\x1b[0m');
      }
      const { MeshManager } = require('../src/mesh-manager');
      const mesh = new MeshManager({
        port,
        dev: options.dev,
        onUrl: (meshUrl) => {
          const t = authToken ? `${meshUrl}?token=${authToken}` : meshUrl;
          console.log(`\n  \x1b[1m\x1b[32mMesh ready:\x1b[0m \x1b[1m\x1b[4m${t}\x1b[0m\n`);
        },
      });
      app.setMeshManager(mesh);
      await mesh.start();
    }

    console.log('\nPress Ctrl+C to stop the server\n');

    // Shutdown is owned by the server's single SIGINT/SIGTERM handler
    // (ClaudeCodeWebServer.handleShutdown), which performs the ordered graceful
    // teardown: cooperative disposal of the local-LLM (sticky-note) and STT
    // native worker threads, tunnel stop, session save, then server close.
    // A second handler here used to race it — its httpServer.close() callback
    // fires immediately when there are no open connections and called
    // process.exit(0) before the worker threads could dispose their ggml-based
    // native models, which aborted the process (SIGABRT / exit 134) on Ctrl+C.
    // So we deliberately do NOT register a SIGINT/SIGTERM handler here.

  } catch (error) {
    console.error('Error starting server:', error.message);
    process.exit(1);
  }
}

main();
