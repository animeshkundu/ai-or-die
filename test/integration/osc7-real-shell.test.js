// test/integration/osc7-real-shell.test.js — End-to-end validation that the
// OSC 7 contract from ADR-0019 actually fires when REAL shells run the
// documented prompt hooks from docs/specs/file-browser.md.
//
// Why this exists (regression context):
//   The original synthesized E2E + unit tests were green while the user-
//   facing copy-paste path was broken: the spec's bash hook emits
//   `file://$HOSTNAME$PWD`, and Node's url.fileURLToPath() throws
//   ERR_INVALID_FILE_URL_HOST for any non-localhost host on POSIX.
//   The parser silently caught the throw and dropped every prompt's
//   OSC 7 — meaning the documented one-liner had ZERO effect end-to-end
//   on macOS/Linux. Bug + parser fix: commit e878c77.
//
// This suite is the regression guard for that class of bug — a user
// types the documented hook into their real shell and we observe the
// resulting cwd_changed frames over a real WebSocket against the real
// server. Synthesised injection (which used `file:///path` with empty
// host) would never have caught it.
//
// Suite is heavy (~10s wall-clock) — gated to `npm run test:integration`,
// not the default `npm test`. Each shell is `before()`-checked and the
// suite skips cleanly if a tool isn't installed (CI-friendly).
//
// Tools probed at suite start:
//   - bash (required — most scenarios)
//   - zsh (required for the zsh-hook scenarios)
//   - tmux, pwsh, sudo, ssh (per-scenario skips)

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../../src/server'));
} catch (e) {
  // node-pty unloadable on this runner — entire suite skips.
}

// ---------------------------------------------------------------------------
// Tool availability — probed once before any test runs.
// ---------------------------------------------------------------------------

function has(cmd) {
  try {
    const probe = process.platform === 'win32' ? 'where.exe' : 'which';
    execFileSync(probe, [cmd], { stdio: 'ignore' });
    return true;
  }
  catch (_) { return false; }
}

const HAS_BASH = has('bash');
const HAS_ZSH  = has('zsh');
const HAS_TMUX = has('tmux');
// Scenarios that drive a POSIX shell inside the terminal (`exec bash ...`,
// PROMPT_COMMAND, `exec zsh`, tmux, sudo) are POSIX-only by construction.
// On Windows the terminal bridge spawns pwsh (src/terminal-bridge.js:112-115),
// where `exec` is not a command at all — bash never starts, the documented
// hook is never installed, and no OSC 7 is ever emitted. Those tests would
// report a harness mismatch as a product failure.
//
// This was previously invisible: the old `has()` probe shelled out through
// `/bin/sh`, which does not exist on Windows, so EVERY probe returned false
// and the entire suite silently skipped there. Fixing the probe (where.exe)
// un-skipped scenarios that were never written for this platform. The Windows
// contract is covered by the pwsh scenario below, which is the real user path.
const POSIX_SHELL = process.platform !== 'win32';
const posixIt = (HAS_BASH && POSIX_SHELL) ? it : it.skip;
// PowerShell's interactive terminal initialization requires emulator replies
// that this raw POSIX PTY harness cannot supply. The supported deployment
// contract is Windows ConPTY, so exercise this scenario there rather than
// reporting a harness-only Linux timeout as a product failure.
const HAS_PWSH = has('pwsh');
const HAS_WINDOWS_POWERSHELL = process.platform === 'win32' && has('powershell.exe');
const HAS_SUDO_NOPASSWD = (() => {
  if (!has('sudo')) return false;
  try { execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 2000 }); return true; }
  catch (_) { return false; }
})();

// ---------------------------------------------------------------------------
// Bottom-of-file mocha tests reference these handles.
// ---------------------------------------------------------------------------

let server, port, baseDir;
let hasSymlink = false;

async function startServer() {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osc7-real-shell-'));
  // Pre-create the sub-dirs we'll be cd-ing into so realpath is stable.
  fs.mkdirSync(path.join(baseDir, 'a'));
  fs.mkdirSync(path.join(baseDir, 'b'));
  fs.mkdirSync(path.join(baseDir, 'foo bar'));        // path with spaces
  fs.mkdirSync(path.join(baseDir, 'résumé'));         // unicode
  // Creating a symlink on Windows needs Developer Mode or elevation. CI runners
  // have it; a normal Windows dev box does not, and an unguarded symlinkSync
  // here threw EPERM in before(), taking down EVERY test in this file —
  // including the pwsh scenario, which is the one Windows case that matters.
  // The symlink is only consumed by a POSIX-gated test, so record whether it
  // exists rather than making the whole suite unrunnable locally.
  try {
    fs.symlinkSync(path.join(baseDir, 'a'), path.join(baseDir, 'a-link'));
    hasSymlink = true;
  } catch (_) {
    hasSymlink = false;
  }
  const origCwd = process.cwd();
  process.chdir(baseDir);
  server = new ClaudeCodeWebServer({
    port: 0,
    noAuth: true,
    sessionStoreOptions: { storageDir: path.join(baseDir, '.sessions') },
  });
  const httpServer = await server.start();
  port = httpServer.address().port;
  process.chdir(origCwd);
}

async function stopServer() {
  try { server.close(); } catch (_) {}
  try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.frames = [];
    this.cwdChangedFrames = [];
    this.outputAccum = '';
    this._dsrTail = '';
  }

  async open(workingDir) {
    this.ws = new WebSocket('ws://127.0.0.1:' + port);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const text = raw.toString('utf-8');
        this.outputAccum += text;
        this._answerDsr(text);
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.frames.push(msg);
      if (msg.type === 'cwd_changed') this.cwdChangedFrames.push(msg);
      if (msg.type === 'session_created') this.sessionId = msg.sessionId;
    });
    this.ws.send(JSON.stringify({ type: 'create_session', workingDir }));
    await this.waitFor('session_created', 5000);
    return this;
  }

  async startTerminal() {
    const outputLength = this.outputAccum.length;
    this.ws.send(JSON.stringify({ type: 'start_terminal', cols: 80, rows: 24 }));
    await this.waitFor('terminal_started', 10000);
    await this.waitForOutputAfter(outputLength, '', 5000);
    return this;
  }

  send(data) { this.ws.send(JSON.stringify({ type: 'input', data })); }

  _answerDsr(text) {
    const scan = this._dsrTail + text;
    let index = scan.indexOf('\x1b[6n');
    while (index !== -1) {
      this.send('\x1b[1;1R');
      index = scan.indexOf('\x1b[6n', index + 4);
    }
    this._dsrTail = scan.slice(-3);
  }

  waitFor(type, timeoutMs) {
    return new Promise((resolve, reject) => {
      const matched = this.frames.find((f) => f.type === type);
      if (matched) return resolve(matched);
      const t = setTimeout(() => reject(new Error('waitFor(' + type + ') timed out after ' + timeoutMs + 'ms')), timeoutMs);
      const handler = (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === type) {
          clearTimeout(t);
          this.ws.off('message', handler);
          resolve(msg);
        }
      };
      this.ws.on('message', handler);
    });
  }

  /**
   * Wait for a cwd_changed frame whose cwd resolves to `expected`.
   *
   * Prefer this over waitForCwdChanged() whenever a hook was installed earlier
   * in the test: installing a prompt hook makes the shell redraw immediately,
   * which legitimately emits a cwd_changed for the CURRENT directory before the
   * navigation under test happens. "Wait for the next frame" then races that
   * redraw and asserts against the wrong directory — non-deterministically,
   * depending on whether the redraw landed before or after the wait started.
   * Matching on the target path is order-independent.
   */
  waitForCwdChangedTo(expected, timeoutMs) {
    const want = path.resolve(expected);
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = setInterval(() => {
        const hit = this.cwdChangedFrames.find((f) => path.resolve(f.cwd) === want);
        if (hit) {
          clearInterval(tick);
          resolve(hit);
        } else if (Date.now() - start >= timeoutMs) {
          clearInterval(tick);
          const seen = this.cwdChangedFrames.map((f) => f.cwd).join(', ') || '(none)';
          reject(new Error(
            'cwd_changed for ' + want + ' timed out after ' + timeoutMs + 'ms; saw: ' + seen
          ));
        }
      }, 25);
    });
  }

  waitForCwdChanged(timeoutMs) {
    const before = this.cwdChangedFrames.length;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('cwd_changed timed out after ' + timeoutMs + 'ms')), timeoutMs);
      const tick = setInterval(() => {
        if (this.cwdChangedFrames.length > before) {
          clearInterval(tick);
          clearTimeout(t);
          resolve(this.cwdChangedFrames[this.cwdChangedFrames.length - 1]);
        }
      }, 25);
    });
  }

  waitForOutput(marker, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = setInterval(() => {
        if (this.outputAccum.includes(marker)) {
          clearInterval(tick);
          resolve();
        } else if (Date.now() - start >= timeoutMs) {
          clearInterval(tick);
          reject(new Error('terminal output timed out waiting for ' + JSON.stringify(marker)));
        }
      }, 25);
    });
  }

  waitForOutputAfter(offset, marker, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = setInterval(() => {
        const freshOutput = this.outputAccum.slice(offset);
        if (freshOutput.length > 0 && freshOutput.includes(marker)) {
          clearInterval(tick);
          resolve();
        } else if (Date.now() - start >= timeoutMs) {
          clearInterval(tick);
          reject(new Error('terminal output timed out waiting for fresh ' + JSON.stringify(marker)));
        }
      }, 25);
    });
  }

  async close() {
    try { this.ws.send(JSON.stringify({ type: 'stop' })); } catch (_) {}
    try { this.ws.close(); } catch (_) {}
    await sleep(150);
  }

  reset() {
    this.cwdChangedFrames = [];
    this.outputAccum = '';
  }
}

// The exact spec hook strings (verbatim from docs/specs/file-browser.md) — as
// they would appear when typed at a shell prompt. We send them through the
// PTY input channel; bash/zsh/pwsh re-parses them just like a user
// copy-pasting from the docs would.
const SPEC_BASH_HOOK =
  "PROMPT_COMMAND='printf \"\\e]7;file://%s%s\\e\\\\\\\\\" \"$HOSTNAME\" \"$PWD\"'\n";
const SPEC_ZSH_HOOK =
  "function chpwd() { printf \"\\e]7;file://%s%s\\e\\\\\\\\\" \"$HOST\" \"$PWD\" }\n";

// Convenience: cd a target, return the realpath form (validatePath()
// canonicalizes via realpathSync, so liveCwd values use the realpath).
function realA() { return fs.realpathSync(path.join(baseDir, 'a')); }
function realB() { return fs.realpathSync(path.join(baseDir, 'b')); }

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const suite = (ClaudeCodeWebServer && HAS_BASH) ? describe : describe.skip;

suite('OSC 7 real-shell integration (ADR-0019)', function () {
  // 60 s per-suite timeout — startServer alone can take ~5s on a cold
  // machine due to the shell-discovery probes BaseBridge runs at boot.
  this.timeout(60000);

  before(async function () {
    await startServer();
  });

  after(async function () {
    await stopServer();
  });

  posixIt('session-scoped bash hook emits cwd_changed without manual setup and preserves a custom prompt', async function () {
    const originalCommand = server.terminalBridge.command;
    const originalHome = process.env.HOME;
    const customHome = fs.mkdtempSync(path.join(baseDir, 'custom-home-'));
    fs.writeFileSync(
      path.join(customHome, '.bashrc'),
      'PS1="CUSTOM> "\nPROMPT_COMMAND=\'printf "CUSTOM_PROMPT "\'\n'
    );
    server.terminalBridge.command = execFileSync('which', ['bash'], { encoding: 'utf8' }).trim();
    process.env.HOME = customHome;
    const sess = new Session();
    try {
      await sess.open(baseDir);
      await sess.startTerminal();
    } finally {
      process.env.HOME = originalHome;
    }

    await sess.waitForOutput('CUSTOM_PROMPT', 5000);
    sess.reset();
    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'foo bar')) + '\n');
    const frame = await sess.waitForCwdChangedTo(fs.realpathSync(path.join(baseDir, 'foo bar')), 5000);
    assert.strictEqual(path.resolve(frame.cwd), fs.realpathSync(path.join(baseDir, 'foo bar')));
    await sess.waitForOutput('CUSTOM_PROMPT', 5000);
    await sess.close();
    server.terminalBridge.command = originalCommand;
  });

  posixIt('a shell that rejects the injected rc file falls back to a live vanilla terminal', async function () {
    const originalCommand = server.terminalBridge.command;
    const fakeBin = fs.mkdtempSync(path.join(baseDir, 'fallback-bin-'));
    const fakeBash = path.join(fakeBin, 'bash');
    fs.writeFileSync(
      fakeBash,
      '#!/bin/sh\nif [ "$1" = "--rcfile" ]; then exit 42; fi\nexec /bin/bash "$@"\n',
      { mode: 0o700 }
    );
    server.terminalBridge.command = fakeBash;
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('echo VANILLA_FALLBACK_OK\n');
    await sess.waitForOutput('VANILLA_FALLBACK_OK', 5000);
    await sess.close();
    server.terminalBridge.command = originalCommand;
  });

  (HAS_ZSH ? it : it.skip)('session-scoped zsh hook emits cwd_changed and preserves precmd', async function () {
    const originalCommand = server.terminalBridge.command;
    const originalZdotdir = process.env.ZDOTDIR;
    const customHome = fs.mkdtempSync(path.join(baseDir, 'zsh-home-'));
    fs.writeFileSync(path.join(customHome, '.zshrc'), 'precmd_functions+=(user_precmd)\nuser_precmd() { print -n "CUSTOM_ZSH " }\n');
    server.terminalBridge.command = execFileSync('which', ['zsh'], { encoding: 'utf8' }).trim();
    process.env.ZDOTDIR = customHome;
    const sess = new Session();
    try {
      await sess.open(baseDir);
      await sess.startTerminal();
    } finally {
      if (originalZdotdir === undefined) delete process.env.ZDOTDIR;
      else process.env.ZDOTDIR = originalZdotdir;
    }
    await sess.waitForOutput('CUSTOM_ZSH', 5000);
    sess.reset();
    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'foo bar')) + '\n');
    const frame = await sess.waitForCwdChangedTo(fs.realpathSync(path.join(baseDir, 'foo bar')), 5000);
    assert.strictEqual(path.resolve(frame.cwd), fs.realpathSync(path.join(baseDir, 'foo bar')));
    await sess.close();
    server.terminalBridge.command = originalCommand;
  });

  (HAS_PWSH ? it : it.skip)('session-scoped pwsh hook emits cwd_changed without manual setup', async function () {
    const originalCommand = server.terminalBridge.command;
    const originalHome = process.env.HOME;
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    let customHome = null;
    server.terminalBridge.command = process.platform === 'win32'
      ? execFileSync('where.exe', ['pwsh'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
      : execFileSync('which', ['pwsh'], { encoding: 'utf8' }).trim();
    if (process.platform !== 'win32') {
      customHome = fs.mkdtempSync(path.join(baseDir, 'pwsh-home-'));
      const profileDir = path.join(customHome, 'config', 'powershell');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, 'Microsoft.PowerShell_profile.ps1'),
        'function prompt { "CUSTOM_PS> " }\nfunction ProfileProbe { "PROFILE_SCOPE_OK" }\n'
      );
      process.env.HOME = customHome;
      process.env.XDG_CONFIG_HOME = path.join(customHome, 'config');
    }
    const sess = new Session();
    try {
      await sess.open(baseDir);
      await sess.startTerminal();
    } finally {
      process.env.HOME = originalHome;
      if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    await sess.waitForOutput(process.platform === 'win32' ? 'PS ' : 'CUSTOM_PS', 10000);
    if (customHome) {
      sess.send('ProfileProbe\r');
      await sess.waitForOutput('PROFILE_SCOPE_OK', 5000);
    }
    sess.reset();
    const target = path.join(baseDir, 'foo bar').replace(/'/g, "''");
    sess.send(`Set-Location -LiteralPath '${target}'\r`);
    const frame = await sess.waitForCwdChangedTo(fs.realpathSync(path.join(baseDir, 'foo bar')), 15000);
    assert.strictEqual(path.resolve(frame.cwd), fs.realpathSync(path.join(baseDir, 'foo bar')));
    if (customHome) await sess.waitForOutput('CUSTOM_PS', 5000);
    await sess.close();
    server.terminalBridge.command = originalCommand;
  });

  (process.platform === 'win32' ? it : it.skip)('session-scoped Windows PowerShell hook emits cwd_changed without manual setup', async function () {
    assert.strictEqual(HAS_WINDOWS_POWERSHELL, true, 'powershell.exe must be available on Windows');
    const originalCommand = server.terminalBridge.command;
    server.terminalBridge.command = execFileSync('where.exe', ['powershell.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    await sess.waitForOutput('PS ', 10000);
    sess.reset();
    const target = path.join(baseDir, 'foo bar').replace(/'/g, "''");
    sess.send(`Set-Location -LiteralPath '${target}'\r`);
    const frame = await sess.waitForCwdChangedTo(fs.realpathSync(path.join(baseDir, 'foo bar')), 15000);
    assert.strictEqual(path.resolve(frame.cwd), fs.realpathSync(path.join(baseDir, 'foo bar')));
    await sess.close();
    server.terminalBridge.command = originalCommand;
  });

  // ──────────────────────────────────────────────────────────────────────
  // 1. Bash PROMPT_COMMAND hook (verbatim from spec).
  // ──────────────────────────────────────────────────────────────────────

  posixIt('bash --noprofile --norc + spec PROMPT_COMMAND → cwd_changed on cd', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('exec bash --noprofile --norc\n');
    await sleep(400);
    sess.send(SPEC_BASH_HOOK);
    await sleep(400);
    sess.reset();

    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'a')) + '\n');
    const f1 = await sess.waitForCwdChanged(3000);
    assert.strictEqual(path.resolve(f1.cwd), realA(), 'cwd after cd a/');
    assert.strictEqual(f1.source, 'osc7');

    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'b')) + '\n');
    const f2 = await sess.waitForCwdChanged(3000);
    assert.strictEqual(path.resolve(f2.cwd), realB(), 'cwd after cd b/');
    assert.strictEqual(f2.prev, f1.cwd, 'prev should equal previous cwd');

    await sess.close();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. Zsh chpwd hook (verbatim from spec).
  // ──────────────────────────────────────────────────────────────────────

  (HAS_ZSH ? it : it.skip)('zsh --no-rcs + spec chpwd → cwd_changed on cd', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('exec zsh --no-rcs --no-globalrcs -i\n');
    await sleep(400);
    sess.send(SPEC_ZSH_HOOK);
    await sleep(400);
    sess.reset();

    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'a')) + '\n');
    const f = await sess.waitForCwdChanged(3000);
    assert.strictEqual(path.resolve(f.cwd), realA());
    await sess.close();
  });

  // 2b. Document the spec-amendment finding: bare interactive zsh does NOT
  //     emit OSC 7 without an explicit hook on macOS. (Spec previously
  //     claimed "emits natively under terminfo profile" — corrected
  //     post-task #7 amendment.)
  (HAS_ZSH ? it : it.skip)('zsh without an explicit hook does NOT emit OSC 7 — hook is required', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('exec zsh --no-rcs --no-globalrcs -i\n');
    await sleep(400);
    sess.reset();

    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'a')) + '\n');
    let observed = null;
    try { observed = await sess.waitForCwdChanged(1500); } catch (_) {}
    await sess.close();
    assert.strictEqual(observed, null,
      'zsh emitted OSC 7 natively (spec wording can be reverted): ' + JSON.stringify(observed));
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. PowerShell hook (verbatim from spec).
  // ──────────────────────────────────────────────────────────────────────

  // The documented prompt function is Windows-specific: a drive-style
  // ProviderPath forms file://C:/... , which fileURLToPath decodes to a clean
  // drive path. Validate the real user contract on its Windows target.
  //
  // NOTE: the Windows terminal bridge already spawns pwsh as the shell
  // (src/terminal-bridge.js:112-115), so there is nothing to exec into — an
  // earlier version of this test sent `exec pwsh -NoLogo -NoProfile\n`, which
  // is a POSIX builtin that pwsh does not have, terminated with \n where
  // ConPTY needs \r. It reported a harness mismatch as a product failure; the
  // OSC 7 emit path itself was verified working end-to-end on Windows.
  (HAS_PWSH && process.platform === 'win32' ? it : it.skip)('pwsh + spec prompt function → cwd_changed on Set-Location', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    // Single-line collapse of the spec's multi-line $PROFILE function.
    const psHook =
      'function prompt { $loc = $executionContext.SessionState.Path.CurrentLocation; ' +
      '$out = "PS $loc> "; if ($loc.Provider.Name -eq "FileSystem") { ' +
      '$p = $loc.ProviderPath -replace "\\\\","/"; ' +
      '$out += "$([char]27)]7;file://$p$([char]7)" }; $out }\r';
    sess.send(psHook);
    await sess.waitForOutput('PS ', 10000);
    sess.reset();

    sess.send('Set-Location ' + JSON.stringify(path.join(baseDir, 'a')) + '\r');
    // Match on the target dir, not "the next frame": installing the prompt hook
    // above makes pwsh redraw and emit a cwd_changed for the CURRENT directory,
    // which raced the Set-Location frame on CI and asserted against baseDir.
    const f = await sess.waitForCwdChangedTo(realA(), 15000);
    assert.strictEqual(path.resolve(f.cwd), realA());
    await sess.close();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Race conditions & masking failure modes.
  // ──────────────────────────────────────────────────────────────────────

  // 4a. tmux wraps the shell. tmux SWALLOWS OSC 7 by default — this test
  //     documents the limitation as an explicit assertion (it would FAIL
  //     if tmux ever started forwarding OSC 7, at which point we'd want
  //     to revise the spec).
  (HAS_TMUX ? it : it.skip)('tmux wrapping bash SWALLOWS OSC 7 (documented limitation)', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    const tname = 'osc7-rs-' + Date.now();
    sess.send('tmux new-session -d -s ' + tname + '\n');
    await sleep(400);
    sess.send('tmux attach -t ' + tname + '\n');
    await sleep(600);
    sess.send('exec bash --noprofile --norc\n');
    await sleep(400);
    sess.send(SPEC_BASH_HOOK);
    await sleep(400);
    sess.reset();

    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'a')) + '\n');
    let observed = null;
    try { observed = await sess.waitForCwdChanged(2000); } catch (_) {}
    sess.send('tmux kill-session -t ' + tname + '\n');
    await sleep(200);
    await sess.close();
    assert.strictEqual(observed, null,
      'tmux now forwards OSC 7 — spec Limitations entry can be relaxed: ' + JSON.stringify(observed));
  });

  // 4b. sudo subshell — only runs unattended if NOPASSWD is configured.
  (HAS_SUDO_NOPASSWD ? it : it.skip)('sudo bash subshell still surfaces OSC 7', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('exec bash --noprofile --norc\n');
    await sleep(400);
    sess.send('sudo -n bash --noprofile --norc -i\n');
    await sleep(800);
    sess.send(SPEC_BASH_HOOK);
    await sleep(400);
    sess.reset();

    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'a')) + '\n');
    const f = await sess.waitForCwdChanged(3000);
    assert.strictEqual(path.resolve(f.cwd), realA());
    sess.send('exit\n');
    await sleep(200);
    await sess.close();
  });

  // 4c. ssh — note the harness here can't drive the remote shell's
  //     PROMPT_COMMAND injection cleanly, so we mark it as a known-
  //     manual-smoke step. The skip carries the reason in its name.
  it.skip('ssh into a remote — manual smoke recommended (harness cannot drive remote PROMPT_COMMAND)', function () {});

  // 4d. Login shell — bash --login + hook.
  posixIt('login bash + spec hook → cwd_changed on cd (login-shell semantics fire PROMPT_COMMAND)', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('exec bash --login --noprofile --norc\n');
    await sleep(400);
    sess.send(SPEC_BASH_HOOK);
    await sleep(400);
    sess.reset();

    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'a')) + '\n');
    const f = await sess.waitForCwdChanged(3000);
    assert.strictEqual(path.resolve(f.cwd), realA());
    await sess.close();
  });

  // 4e. Non-interactive bash — PROMPT_COMMAND doesn't fire. This is
  //     EXPECTED behaviour (documented limit), asserted explicitly so a
  //     future change that suddenly DOES emit OSC 7 in non-interactive
  //     mode would surface here.
  posixIt('non-interactive bash -c does NOT emit OSC 7 (PROMPT_COMMAND doesn\'t fire)', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('bash --noprofile --norc -c \'PROMPT_COMMAND=\\\'printf "\\\\e]7;file://%s%s\\\\e\\\\\\\\\\\\\\\\" "$HOSTNAME" "$PWD"\\\' ; cd ' +
      JSON.stringify(path.join(baseDir, 'a')) + ' ; echo done\'\n');
    await sleep(1500);
    let observed = null;
    try { observed = await sess.waitForCwdChanged(500); } catch (_) {}
    await sess.close();
    assert.strictEqual(observed, null,
      'unexpected: non-interactive bash emitted OSC 7: ' + JSON.stringify(observed));
  });

  // 4f. Race: 100 KB stdout immediately after OSC 7 — confirms the
  //     parser's pending buffer doesn't get clobbered or out-of-sync.
  posixIt('OSC 7 followed immediately by 100 KB stdout — cwd_changed survives the burst', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('exec bash --noprofile --norc\n');
    await sleep(400);
    sess.send(SPEC_BASH_HOOK);
    await sleep(400);
    sess.reset();

    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'a')) + ' && yes x | head -c 102400\n');
    const f = await sess.waitForCwdChanged(5000);
    assert.strictEqual(path.resolve(f.cwd), realA());
    await sess.close();
  });

  // 4g. Reconnect — server-side liveCwd must persist across WebSocket
  //     close so a page reload doesn't reset the panel root.
  posixIt('server-side session.liveCwd persists across WebSocket close (page reload)', async function () {
    const sess1 = new Session();
    await sess1.open(baseDir);
    const sessionId = sess1.sessionId;
    await sess1.startTerminal();
    sess1.send('exec bash --noprofile --norc\n');
    await sleep(400);
    sess1.send(SPEC_BASH_HOOK);
    await sleep(400);
    sess1.reset();
    sess1.send('cd ' + JSON.stringify(path.join(baseDir, 'a')) + '\n');
    await sess1.waitForCwdChanged(3000);
    try { sess1.ws.close(); } catch (_) {}
    await sleep(300);

    const sessRec = server.claudeSessions.get(sessionId);
    assert.ok(sessRec, 'session record still exists');
    assert.strictEqual(sessRec.liveCwd, realA(),
      'liveCwd should survive WS close (got ' + sessRec.liveCwd + ')');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. Path edge cases through the live OSC 7 flow.
  // ──────────────────────────────────────────────────────────────────────

  posixIt('path with spaces (`/foo bar`) — decoded correctly via fileURLToPath', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('exec bash --noprofile --norc\n');
    await sleep(400);
    sess.send(SPEC_BASH_HOOK);
    await sleep(400);
    sess.reset();

    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'foo bar')) + '\n');
    const f = await sess.waitForCwdChanged(3000);
    assert.ok(f.cwd.endsWith('foo bar'), 'expected path with space, got ' + f.cwd);
    await sess.close();
  });

  posixIt('unicode path (`/résumé`) — decoded correctly', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('exec bash --noprofile --norc\n');
    await sleep(400);
    sess.send(SPEC_BASH_HOOK);
    await sleep(400);
    sess.reset();

    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'résumé')) + '\n');
    const f = await sess.waitForCwdChanged(3000);
    assert.ok(f.cwd.indexOf('résumé') !== -1, 'expected unicode path, got ' + f.cwd);
    await sess.close();
  });

  posixIt('symlink — liveCwd reports the realpath (validatePath canonicalizes)', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('exec bash --noprofile --norc\n');
    await sleep(400);
    sess.send(SPEC_BASH_HOOK);
    await sleep(400);
    sess.reset();

    sess.send('cd ' + JSON.stringify(path.join(baseDir, 'a-link')) + '\n');
    const f = await sess.waitForCwdChanged(3000);
    assert.strictEqual(f.cwd, realA(),
      'symlink not realpath-resolved: got ' + f.cwd + ', expected ' + realA());
    await sess.close();
  });

  posixIt('cd outside the sandbox (e.g. /etc) — silently dropped, no cwd_changed', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('exec bash --noprofile --norc\n');
    await sleep(400);
    sess.send(SPEC_BASH_HOOK);
    await sleep(400);
    sess.reset();

    sess.send('cd /etc\n');
    let observed = null;
    try { observed = await sess.waitForCwdChanged(1500); } catch (_) {}
    await sess.close();
    assert.strictEqual(observed, null,
      'sandbox escape: /etc was NOT silently dropped — got frame: ' + JSON.stringify(observed));
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. AI CLI bridges no-op contract (claude/codex/copilot/gemini bridges
  //    intentionally have no OSC 7 plumbing — their PTY-running CLIs
  //    don't chdir their host process).
  // ──────────────────────────────────────────────────────────────────────

  it('AI CLI bridges have no OSC 7 plumbing (Claude/Codex/Copilot/Gemini)', function () {
    const ClaudeBridge = require('../../src/claude-bridge');
    const CodexBridge = require('../../src/codex-bridge');
    const CopilotBridge = require('../../src/copilot-bridge');
    const GeminiBridge = require('../../src/gemini-bridge');
    for (const [name, B] of [['Claude', ClaudeBridge], ['Codex', CodexBridge], ['Copilot', CopilotBridge], ['Gemini', GeminiBridge]]) {
      const b = new B();
      assert.strictEqual(typeof b.getLiveCwd, 'undefined',
        name + 'Bridge unexpectedly exposes getLiveCwd');
      assert.strictEqual(b._osc7Parsers, undefined,
        name + 'Bridge unexpectedly has _osc7Parsers map');
    }
  });
});
