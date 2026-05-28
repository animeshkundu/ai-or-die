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

/**
 * Process-wide OSC 7 validated-path cache size + TTL bounds.
 *
 * MAX_ENTRIES: LRU cap. 256 covers any realistic distinct-cwd set under
 * sustained use; a perverse shell that emits 1000 distinct paths/s still
 * only ever holds 256 entries.
 *
 * TTL_MS: 5 s. Long enough to absorb prompt-redraw bursts (every keystroke
 * on pwsh + oh-my-posh/Starship), short enough that the user's manual
 * `mkdir` / `rm` is reflected at the next emission without a server
 * restart. Combined with the per-session `_lastRawOsc7` fast-path
 * (sub-microsecond string-identity check), the cache makes cross-session
 * + alternating-cwd workloads O(unique-paths) instead of O(emissions).
 *
 * See docs/audits/hot-01-osc7-dedupe.md and HOT-06 fix-PR.
 */
const OSC7_CACHE_MAX_ENTRIES = 256;
const OSC7_CACHE_TTL_MS = 5000;

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
     * Raw OSC 7 path most recently seen for each session — first-level
     * filter, sub-microsecond string-identity compare. Catches the common
     * "shell re-emits the same path on every prompt redraw" pattern
     * (pwsh + oh-my-posh/Starship on every keystroke).
     *
     * Defeated by intra-session alternation (e.g. `pushd`/`popd` patterns,
     * multi-segment prompts that emit cwd then git-root then cwd) and by
     * multi-session same-cwd ⇒ the second-level process-wide cache below
     * is what catches those.
     *
     * @type {Map<string, string|null>}
     */
    this._lastRawOsc7 = new Map();

    /**
     * Process-wide OSC 7 validated-path cache. Second-level dedupe after
     * `_lastRawOsc7` — keyed by the RAW decoded OSC 7 path (NOT the
     * validatePath-canonical form, because that would require syscalls
     * to compute), valued by `{ validated, expiresAt }`. Caches both
     * VALID and INVALID results so a junk path doesn't pay validatePath
     * syscalls on every emission across sessions.
     *
     * Cache invariants:
     *   - Map insertion order = LRU order (ES2015+ Maps preserve it;
     *     pre-existing pattern in Node). Cache hits delete + re-set to
     *     bump entry to the end (most-recently-used).
     *   - Bounded at OSC7_CACHE_MAX_ENTRIES; oldest entries evicted on
     *     overflow.
     *   - TTL = OSC7_CACHE_TTL_MS from the insertion moment; expired
     *     entries are re-validated on next miss.
     *
     * Closes the cross-session-validation-cost gap documented in
     * docs/audits/hot-01-osc7-dedupe.md.
     *
     * @type {Map<string, {validated: {valid:boolean, path?:string}, expiresAt:number}>}
     */
    this._osc7ValidationCache = new Map();
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
    // The validation cache is process-wide (not per-session), but on
    // full bridge cleanup we drop it too so a fresh start gets a fresh
    // cache. This matches the behaviour callers got before HOT-06.
    this._osc7ValidationCache.clear();
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
      // ---- Level 1: per-session same-raw fast-path. ---------------------
      // Catches the steady-state shell-emits-same-cwd-every-keystroke
      // case (pwsh + oh-my-posh / Starship). Sub-microsecond string
      // identity compare; no Map insertion churn.
      const lastRaw = this._lastRawOsc7.get(sessionId);
      if (raw === lastRaw) continue;
      this._lastRawOsc7.set(sessionId, raw);

      // ---- Level 2: process-wide validated-path cache. ------------------
      // Catches multi-tab same-cwd AND intra-session alternating-cwd
      // workloads, both of which defeat Level 1. Caches valid AND invalid
      // results (an out-of-sandbox path doesn't pay validatePath syscalls
      // on every emission across every session). See
      // docs/audits/hot-01-osc7-dedupe.md.
      const now = Date.now();
      const cached = this._osc7ValidationCache.get(raw);
      let validated;
      if (cached && cached.expiresAt > now) {
        // Cache hit — bump to MRU via delete + reinsert (preserves Map
        // insertion order = LRU order).
        this._osc7ValidationCache.delete(raw);
        this._osc7ValidationCache.set(raw, cached);
        validated = cached.validated;
      } else {
        try {
          validated = hooks.validatePath(raw);
        } catch (_) {
          validated = { valid: false }; // validator threw — treat as rejection.
        }
        // Normalize so the cache always stores a plain `{valid, path?}`
        // shape regardless of what the caller returned.
        const normalized = validated && validated.valid
          ? { valid: true, path: validated.path || raw }
          : { valid: false };
        this._osc7ValidationCache.set(raw, {
          validated: normalized,
          expiresAt: now + OSC7_CACHE_TTL_MS,
        });
        validated = normalized;
        // Bounded-LRU eviction — drop oldest entries first.
        while (this._osc7ValidationCache.size > OSC7_CACHE_MAX_ENTRIES) {
          const oldest = this._osc7ValidationCache.keys().next().value;
          this._osc7ValidationCache.delete(oldest);
        }
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
