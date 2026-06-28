const BaseBridge = require('./base-bridge');
const { TRUST_PROMPT_REGEX } = require('./control/session-status');

// claude's --permission-mode allowlist (F10). The fleet/control plane forwards one
// of these; an unknown value is rejected up front rather than passed to claude (a
// flag silently ignored by a skewed claude is a dishonest "mode set").
const VALID_PERMISSION_MODES = ['plan', 'acceptEdits', 'default', 'bypassPermissions'];

function invalidArgument(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGUMENT';
  return err;
}

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

  /**
   * F10 — the ONE canonical translation layer from a high-level launch intent
   * (permissionMode + caller agentArgs) to claude's argv, appended AFTER the
   * github-router launcher prefix (`npx -y github-router@latest claude --browse`).
   *
   * claude is launched through github-router, whose `claude` subcommand emits
   * `--dangerously-skip-permissions` by default and DROPS it when a non-bypass
   * `--permission-mode` is present. So here we only need to forward the mode flag;
   * github-router reconciles the dangerous flag on its side.
   *
   * Conflict policy: `agentArgs` may NOT itself carry
   * `--permission-mode` or `--dangerously-skip-permissions` — that would emit
   * duplicate/conflicting flags. We throw INVALID_ARGUMENT so the create fails
   * cleanly instead of launching an ambiguous claude. An unknown `permissionMode`
   * is likewise rejected.
   */
  buildArgs(options = {}) {
    const prefix = this._prefixArgs || [];
    const out = [...prefix];
    const { permissionMode, agentArgs, dangerouslySkipPermissions } = options;

    if (agentArgs != null && !Array.isArray(agentArgs)) {
      throw invalidArgument('agentArgs must be an array of strings');
    }
    const extra = Array.isArray(agentArgs) ? agentArgs.map((a) => String(a)) : [];
    for (const a of extra) {
      if (/^--permission-mode(=|$)/.test(a) || a === '--dangerously-skip-permissions') {
        throw invalidArgument(
          `agentArgs may not contain '${a}'; use permissionMode for permission control`
        );
      }
    }

    if (permissionMode != null && permissionMode !== '') {
      const mode = String(permissionMode);
      if (!VALID_PERMISSION_MODES.includes(mode)) {
        throw invalidArgument(
          `Unknown permissionMode '${mode}' (expected one of: ${VALID_PERMISSION_MODES.join(', ')})`
        );
      }
      // permissionMode is the source of truth: emit the canonical flag and let
      // github-router drop --dangerously-skip-permissions for non-bypass modes.
      out.push('--permission-mode', mode);
    } else if (dangerouslySkipPermissions && this.dangerousFlag) {
      // Back-compat: no explicit mode → honor the legacy skip-permissions toggle.
      out.push(this.dangerousFlag);
    }

    out.push(...extra);
    return out;
  }

  processOutput(sessionId, ptyProcess, dataBuffer) {
    if (this._trustPromptHandled.get(sessionId)) return;
    // Strip ANSI first: claude's Ink TUI interleaves escape codes between words,
    // so a clean-string match misses the folder-trust modal (and the exact wording
    // shifts between claude versions). Match the shared TRUST_PROMPT_REGEX on the
    // de-ANSI'd buffer — but ONLY act when the modal's numbered "1. / 2." choice
    // list is ALSO present. That structural guard (mirroring awaitingFromScreen)
    // prevents a false positive from claude merely PRINTING a trust phrase in prose
    // / a file / a commit message, which would otherwise inject a spurious keystroke
    // into the live PTY. Then send the EXPLICIT "1" choice + Enter (not a bare Enter,
    // which could land on a wrong default) — matching _controlMapResponseKeys. The
    // per-session guard makes this a one-shot. This is what lets HEADLESS /
    // fleet-spawned claude sessions (no human to click) get past trust.
    const plain = String(dataBuffer || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const numbered = /\b1\.\s/.test(plain) && /\b2\.\s/.test(plain);
    if (numbered && TRUST_PROMPT_REGEX.test(plain)) {
      this._trustPromptHandled.set(sessionId, true);
      console.log(`Auto-accepting trust prompt for session ${sessionId}`);
      setTimeout(() => {
        try { ptyProcess.write('1\r'); } catch (_) { /* pty may have exited */ }
        console.log(`Sent "1" + Enter to accept trust prompt for session ${sessionId}`);
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
module.exports.VALID_PERMISSION_MODES = VALID_PERMISSION_MODES;
