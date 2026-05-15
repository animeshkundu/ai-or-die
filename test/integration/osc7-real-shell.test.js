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
const { execSync } = require('child_process');
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
  try { execSync('command -v ' + cmd, { stdio: 'ignore', shell: '/bin/sh' }); return true; }
  catch (_) { return false; }
}

const HAS_BASH = has('bash');
const HAS_ZSH  = has('zsh');
const HAS_TMUX = has('tmux');
const HAS_PWSH = has('pwsh');
const HAS_SUDO_NOPASSWD = (() => {
  if (!has('sudo')) return false;
  try { execSync('sudo -n true', { stdio: 'ignore', timeout: 2000 }); return true; }
  catch (_) { return false; }
})();

// ---------------------------------------------------------------------------
// Bottom-of-file mocha tests reference these handles.
// ---------------------------------------------------------------------------

let server, port, baseDir;

async function startServer() {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osc7-real-shell-'));
  // Pre-create the sub-dirs we'll be cd-ing into so realpath is stable.
  fs.mkdirSync(path.join(baseDir, 'a'));
  fs.mkdirSync(path.join(baseDir, 'b'));
  fs.mkdirSync(path.join(baseDir, 'foo bar'));        // path with spaces
  fs.mkdirSync(path.join(baseDir, 'résumé'));         // unicode
  fs.symlinkSync(path.join(baseDir, 'a'), path.join(baseDir, 'a-link'));
  const origCwd = process.cwd();
  process.chdir(baseDir);
  server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
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
  }

  async open(workingDir) {
    this.ws = new WebSocket('ws://127.0.0.1:' + port);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        this.outputAccum += raw.toString('utf-8');
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
    this.ws.send(JSON.stringify({ type: 'start_terminal', cols: 80, rows: 24 }));
    await this.waitFor('terminal_started', 10000);
    await sleep(300);
    return this;
  }

  send(data) { this.ws.send(JSON.stringify({ type: 'input', data })); }

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

  // ──────────────────────────────────────────────────────────────────────
  // 1. Bash PROMPT_COMMAND hook (verbatim from spec).
  // ──────────────────────────────────────────────────────────────────────

  it('bash --noprofile --norc + spec PROMPT_COMMAND → cwd_changed on cd', async function () {
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

  (HAS_PWSH ? it : it.skip)('pwsh + spec prompt function → cwd_changed on Set-Location', async function () {
    const sess = new Session();
    await sess.open(baseDir);
    await sess.startTerminal();
    sess.send('exec pwsh -NoLogo -NoProfile\n');
    await sleep(800);
    // Single-line collapse of the spec's multi-line $PROFILE function.
    const psHook =
      'function prompt { $loc = $executionContext.SessionState.Path.CurrentLocation; ' +
      '$out = "PS $loc> "; if ($loc.Provider.Name -eq "FileSystem") { ' +
      '$p = $loc.ProviderPath -replace "\\\\","/"; ' +
      '$out += "$([char]27)]7;file://$env:COMPUTERNAME/$p$([char]7)" }; $out }\n';
    sess.send(psHook);
    await sleep(400);
    sess.reset();

    sess.send('Set-Location ' + JSON.stringify(path.join(baseDir, 'a')) + '\n');
    const f = await sess.waitForCwdChanged(3000);
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
  it('login bash + spec hook → cwd_changed on cd (login-shell semantics fire PROMPT_COMMAND)', async function () {
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
  it('non-interactive bash -c does NOT emit OSC 7 (PROMPT_COMMAND doesn\'t fire)', async function () {
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
  it('OSC 7 followed immediately by 100 KB stdout — cwd_changed survives the burst', async function () {
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
  it('server-side session.liveCwd persists across WebSocket close (page reload)', async function () {
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

  it('path with spaces (`/foo bar`) — decoded correctly via fileURLToPath', async function () {
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

  it('unicode path (`/résumé`) — decoded correctly', async function () {
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

  it('symlink — liveCwd reports the realpath (validatePath canonicalizes)', async function () {
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

  it('cd outside the sandbox (e.g. /etc) — silently dropped, no cwd_changed', async function () {
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
