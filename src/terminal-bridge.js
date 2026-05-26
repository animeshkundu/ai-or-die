// src/terminal-bridge.js — Raw shell access via PTY.
//
// Spawns the user's default shell (bash/zsh on POSIX, pwsh/PowerShell/cmd
// on Windows) and, when the shell emits OSC 7 escape sequences from its
// prompt, parses them into live CWD updates that get broadcast to the
// browser over WebSocket as `cwd_changed` frames. See ADR-0019 for the
// full rationale (OSC 7 vs PID polling vs static).
//
// Bridge contract — only TerminalBridge parses OSC 7. Claude/Codex/Gemini
// bridges no-op (their `session.liveCwd === null`); see docs/specs/bridges.md.

'use strict';

const BaseBridge = require('./base-bridge');
const Osc7Parser = require('./osc7-parser');

class TerminalBridge extends BaseBridge {
  constructor() {
    super('Terminal', {
      defaultCommand: 'bash'
    });

    /**
     * Per-session OSC 7 parser instances. Created in startSession when the
     * caller passes onCwdChange + validatePath, torn down in stopSession
     * (and on any cleanup path).
     * @type {Map<string, Osc7Parser>}
     */
    this._osc7Parsers = new Map();

    /**
     * Per-session validation + emit callbacks captured at startSession time.
     * Each entry: { onCwdChange, validatePath }.
     * @type {Map<string, {onCwdChange: Function, validatePath: Function}>}
     */
    this._osc7Hooks = new Map();

    /**
     * Latest validated CWD per session, or null if no OSC 7 has been seen
     * yet (or all OSC 7 sequences were rejected by validatePath). Caller
     * inspects via getLiveCwd(sessionId).
     * @type {Map<string, string|null>}
     */
    this._liveCwd = new Map();

    /**
     * Raw OSC 7 path most recently seen for each session — used to skip the
     * entire validate-and-emit chain when the shell re-emits the same path
     * (every prompt redraw on pwsh/oh-my-posh/Starship). Without this, each
     * redraw fires 3–4 fs.realpathSync syscalls per session; on a SUBST or
     * mapped Windows drive (e.g. Q:\), those syscalls are 10–50ms each and
     * pending requests pile up faster than they complete, blocking the event
     * loop. The dedupe at line ~205 below only saves the *broadcast* — this
     * one saves the syscalls.
     * @type {Map<string, string|null>}
     */
    this._lastRawOsc7 = new Map();
  }

  // Override async command discovery — use default shell instead of searching PATH
  async initCommand() {
    this.command = await this.getDefaultShell();
  }

  async getDefaultShell() {
    if (this.isWindows) {
      // Prefer PowerShell 7 (pwsh), fall back to Windows PowerShell, then cmd.exe
      const pwshPath = await this.resolveFullPathAsync('pwsh');
      if (pwshPath) return pwshPath;
      return process.env.COMSPEC || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  isAvailable() {
    // Terminal is always available — there's always a shell
    return true;
  }

  // Terminal doesn't use dangerous flags or any special args
  buildArgs() {
    return [];
  }

  /**
   * Override BaseBridge.startSession to install the OSC 7 parser BEFORE the
   * PTY spawn and to wrap the caller's onOutput so each PTY chunk is fed
   * through the parser. We deliberately do not strip OSC 7 from the
   * forwarded output — xterm.js silently ignores unknown OSC and we want
   * parity with native terminals so future addons can re-parse.
   *
   * Recognised options (in addition to BaseBridge.startSession):
   *
   *   - onCwdChange(cwd, prev): fired when the validated live CWD changes.
   *   - validatePath(p): callback returning { valid, path, error } — same
   *     shape as ClaudeCodeWebServer#validatePath. Required when
   *     onCwdChange is provided; OSC 7 events for paths outside the
   *     sandbox are silently dropped.
   *
   * Both options are entirely optional; absent them, the bridge behaves
   * identically to BaseBridge (no OSC 7 parsing, no live CWD tracking).
   */
  async startSession(sessionId, options = {}) {
    const { onCwdChange, validatePath, onOutput, ...rest } = options || {};

    // Install OSC 7 state up front so the wrapped onOutput can dereference
    // it on the first PTY chunk without a TOCTOU race.
    if (typeof onCwdChange === 'function') {
      this._installOsc7State(sessionId, {
        onCwdChange,
        validatePath: typeof validatePath === 'function' ? validatePath : (p) => ({ valid: true, path: p }),
      });
    }

    const wrappedOnOutput = (chunk) => {
      // Feed the chunk to the OSC 7 parser BEFORE forwarding so the live
      // CWD event arrives at the client side either before or alongside
      // the bytes that triggered it. Wrap defensively — a parser bug
      // must never break the output pipeline.
      try {
        if (this._osc7Parsers.has(sessionId)) {
          this._handleOsc7Chunk(sessionId, chunk);
        }
      } catch (err) {
        if (process.env.DEBUG) {
          // eslint-disable-next-line no-console
          console.warn('terminal-bridge: OSC 7 handler threw:', err && err.message);
        }
      }
      if (typeof onOutput === 'function') onOutput(chunk);
    };

    try {
      return await super.startSession(sessionId, { ...rest, onOutput: wrappedOnOutput });
    } catch (err) {
      // If the spawn fails after we installed OSC 7 state, clean it up so
      // a retry in the same sessionId starts from a fresh parser.
      this._uninstallOsc7State(sessionId);
      throw err;
    }
  }

  async stopSession(sessionId) {
    try {
      return await super.stopSession(sessionId);
    } finally {
      this._uninstallOsc7State(sessionId);
    }
  }

  async cleanup() {
    const ids = Array.from(this._osc7Hooks.keys());
    for (const id of ids) this._uninstallOsc7State(id);
    return super.cleanup();
  }

  // ------------------------------------------------------------------------
  // Internal OSC 7 plumbing — exposed via underscore-prefixed methods so
  // unit tests can drive them without spawning a real PTY.
  // ------------------------------------------------------------------------

  /**
   * Install per-session OSC 7 parser + callbacks. Idempotent — calling
   * with the same sessionId replaces the prior state (and resets the
   * parser's pending buffer + the cached liveCwd).
   * @private
   */
  _installOsc7State(sessionId, hooks) {
    this._osc7Parsers.set(sessionId, new Osc7Parser());
    this._osc7Hooks.set(sessionId, hooks);
    this._liveCwd.set(sessionId, null);
    this._lastRawOsc7.set(sessionId, null);
  }

  /**
   * Tear down per-session OSC 7 state. Safe to call for sessions that
   * never had OSC 7 state installed.
   * @private
   */
  _uninstallOsc7State(sessionId) {
    const parser = this._osc7Parsers.get(sessionId);
    if (parser) parser.reset();
    this._osc7Parsers.delete(sessionId);
    this._osc7Hooks.delete(sessionId);
    this._liveCwd.delete(sessionId);
    this._lastRawOsc7.delete(sessionId);
  }

  /**
   * Feed one PTY chunk through the parser, run each yielded path through
   * the per-session validatePath, and fire onCwdChange when the validated
   * path actually changes. Safe no-op for sessions with no OSC 7 state.
   * @private
   */
  _handleOsc7Chunk(sessionId, chunk) {
    const parser = this._osc7Parsers.get(sessionId);
    const hooks = this._osc7Hooks.get(sessionId);
    if (!parser || !hooks) return;

    const decoded = parser.feed(chunk);
    if (!decoded.length) return;

    for (const raw of decoded) {
      // Fast-path: skip the entire validate-and-emit chain when the shell
      // re-emits the same raw path. pwsh + oh-my-posh/Starship redraws on
      // every keystroke, so the same `file:///Q:/src` arrives N times per
      // second. validatePath does 3–4 fs.realpathSync syscalls per call;
      // on a SUBST/mapped/network drive each syscall is 10–50ms, and
      // pending requests pile up faster than they complete. The dedupe
      // at the cwd-level below (line 207) only saves the BROADCAST — it
      // can't save the syscalls because they happen during validation.
      const lastRaw = this._lastRawOsc7.get(sessionId);
      if (raw === lastRaw) continue;
      this._lastRawOsc7.set(sessionId, raw);

      let validated;
      try {
        validated = hooks.validatePath(raw);
      } catch (_) {
        continue; // validator threw — treat as rejection.
      }
      if (!validated || !validated.valid) continue;

      // Prefer the canonical path from validatePath (it realpaths symlinks
      // and matches the form every other /api/files/* response uses).
      const cwd = validated.path || raw;
      const prev = this._liveCwd.get(sessionId) || null;

      // Defence-in-depth: even if validation collapses two different raw
      // strings to the same canonical cwd, don't broadcast a no-op change.
      if (cwd === prev) continue;

      this._liveCwd.set(sessionId, cwd);
      try {
        hooks.onCwdChange(cwd, prev);
      } catch (err) {
        if (process.env.DEBUG) {
          // eslint-disable-next-line no-console
          console.warn('terminal-bridge: onCwdChange threw:', err && err.message);
        }
      }
    }
  }

  /**
   * Public read of the latest validated live CWD for a session, or null.
   * Used by HTTP endpoints (notably /api/files/find) so the active root
   * follows the user's `cd` automatically.
   */
  getLiveCwd(sessionId) {
    return this._liveCwd.get(sessionId) || null;
  }
}

module.exports = TerminalBridge;
