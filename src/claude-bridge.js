const BaseBridge = require('./base-bridge');

// Claude is ALWAYS launched through github-router (never the raw `claude`
// binary): `npx -y github-router@latest claude --browse [claude flags]`. This
// guarantees, every session, the Copilot proxy + injected MCP + `--browse`
// browser tools + the session-bind sidecar that powers turn-end detection
// (ADR-0026), so the fleet control plane's turn detection is always the
// high-confidence JSONL path.
//
// `--browse` degrades gracefully when no Chrome/Edge is installed (github-router
// simply registers no browser tools). `npx @latest` does a registry check at
// each spawn (startup latency + needs network; offline falls back to the npx
// cache). Override the launcher for offline/tests/a custom wrapper with
// AIORDIE_CLAUDE_LAUNCHER, e.g. `AIORDIE_CLAUDE_LAUNCHER="claude"` for the raw CLI.
function resolveClaudeLauncher(env = process.env, platform = process.platform) {
  const override = typeof env.AIORDIE_CLAUDE_LAUNCHER === 'string' ? env.AIORDIE_CLAUDE_LAUNCHER.trim() : '';
  if (override) {
    const parts = override.split(/\s+/);
    return { command: parts[0], prefixArgs: parts.slice(1) };
  }
  // Windows resolves the launcher shim as `npx.cmd` for node-pty's spawn.
  const npx = platform === 'win32' ? 'npx.cmd' : 'npx';
  return { command: npx, prefixArgs: ['-y', 'github-router@latest', 'claude', '--browse'] };
}

class ClaudeBridge extends BaseBridge {
  constructor() {
    super('Claude', {
      // Retained as a documented reference only — discovery is skipped while the
      // fixed launcher above is in effect (claude always runs via github-router).
      commandPaths: {
        linux: [
          '/home/ec2-user/.claude/local/claude',
          'claude',
          'claude-code',
          '{HOME}/.claude/local/claude',
          '{HOME}/.local/bin/claude',
          '/usr/local/bin/claude',
          '/usr/bin/claude'
        ],
        win32: [
          '{HOME}\\.claude\\local\\claude',
          'claude',
          'claude-code',
          '{HOME}\\AppData\\Local\\Programs\\claude\\claude'
        ]
      },
      defaultCommand: 'claude',
      dangerousFlag: '--dangerously-skip-permissions',
      autoAcceptTrust: true,
      launcher: resolveClaudeLauncher()
    });
    this._trustPromptHandled = new Map();
  }

  processOutput(sessionId, ptyProcess, dataBuffer) {
    if (this._trustPromptHandled.get(sessionId)) return;
    // Strip ANSI first: claude's Ink TUI interleaves escape codes between words,
    // so a clean-string `includes` misses the folder-trust modal (and the exact
    // wording shifts between claude versions). Match a stable substring of the
    // "Do you trust the files in this folder?" / "1. Yes, I trust this folder"
    // modal on the de-ANSI'd buffer, then accept the default (Enter = Yes). The
    // per-session guard makes this a one-shot. This is what lets HEADLESS /
    // fleet-spawned claude sessions (no human to click) get past trust.
    const plain = String(dataBuffer || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (/Do you trust the files in this folder|trust this folder/i.test(plain)) {
      this._trustPromptHandled.set(sessionId, true);
      console.log(`Auto-accepting trust prompt for session ${sessionId}`);
      setTimeout(() => {
        try { ptyProcess.write('\r'); } catch (_) { /* pty may have exited */ }
        console.log(`Sent Enter to accept trust prompt for session ${sessionId}`);
      }, 500);
    }
  }

  async stopSession(sessionId) {
    this._trustPromptHandled.delete(sessionId);
    return super.stopSession(sessionId);
  }
}

module.exports = ClaudeBridge;
module.exports.resolveClaudeLauncher = resolveClaudeLauncher;
