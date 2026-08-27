'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ShellIntegrationManager,
  bashShim,
  zshEncoderAndHook,
  powershellShim,
} = require('../src/shell-integration');

function has(command) {
  try {
    childProcess.execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

describe('session-scoped shell integration', function () {
  let root;
  let manager;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-integration-test-'));
    manager = new ShellIntegrationManager({ root: path.join(root, '.ai-or-die-shell') });
  });

  afterEach(function () {
    manager.cleanupAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates private per-session files without exposing the session id', function () {
    const integration = manager.prepare('secret-session-id', process.platform === 'win32' ? 'pwsh.exe' : '/bin/bash');
    assert(integration);
    assert(!integration.dir.includes('secret-session-id'));
    if (process.platform === 'win32') {
      const acl = childProcess.execFileSync('icacls.exe', [integration.dir], { encoding: 'utf8' });
      assert(!/(?:Everyone|BUILTIN\\Users|Authenticated Users):[^\r\n]*\((?:F|M|W)\)/i.test(acl), acl);
    } else {
      const dirMode = fs.statSync(integration.dir).mode & 0o777;
      assert.strictEqual(dirMode & 0o077, 0, `directory mode was ${dirMode.toString(8)}`);
      for (const name of fs.readdirSync(integration.dir)) {
        const fileMode = fs.statSync(path.join(integration.dir, name)).mode & 0o777;
        assert.strictEqual(fileMode & 0o077, 0, `${name} mode was ${fileMode.toString(8)}`);
      }
    }
    manager.cleanup('secret-session-id');
    assert.strictEqual(fs.existsSync(integration.dir), false);
  });

  it('builds PowerShell, bash, and zsh launch configurations without editing user rc files', function () {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const rcFiles = ['.bashrc', '.bash_profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin'];
    const before = new Map();
    for (const name of rcFiles) {
      const file = path.join(home, name);
      fs.writeFileSync(file, `original ${name}\n`);
      const stat = fs.statSync(file);
      before.set(file, { content: fs.readFileSync(file, 'utf8'), mtimeMs: stat.mtimeMs });
    }

    const bash = manager.prepare('bash-session', '/bin/bash', { HOME: home });
    assert.deepStrictEqual(bash.args.slice(0, 1), ['--rcfile']);
    assert(fs.readFileSync(bash.args[1], 'utf8').includes('. "$HOME/.bashrc"'));

    const powershell = manager.prepare('ps-session', 'powershell.exe', { HOME: home });
    assert.deepStrictEqual(
      powershell.args.slice(0, 7),
      ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', powershell.script]
    );

    const zsh = manager.prepare('zsh-session', '/usr/bin/zsh', { HOME: home, ZDOTDIR: home });
    assert.strictEqual(zsh.env.ZDOTDIR, zsh.dir);
    for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      assert(fs.existsSync(path.join(zsh.dir, name)), `${name} shim missing`);
    }

    for (const [file, snapshot] of before) {
      const stat = fs.statSync(file);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), snapshot.content);
      assert.strictEqual(stat.mtimeMs, snapshot.mtimeMs);
    }
  });

  it('wraps prompt hooks rather than replacing them', function () {
    const bash = bashShim();
    assert(bash.indexOf('. "$HOME/.bashrc"') < bash.indexOf('_aiordie_emit_osc7()'));
    assert(bash.includes('PROMPT_COMMAND="${PROMPT_COMMAND:+${PROMPT_COMMAND};}_aiordie_emit_osc7"'));
    assert(bash.includes('"$_aiordie_flags" != *r*'));
    assert(bash.includes('"$_aiordie_flags" != *n*'));
    assert(bash.includes('PROMPT_COMMAND+=(_aiordie_emit_osc7)'));

    const zsh = zshEncoderAndHook();
    assert(zsh.includes('precmd_functions+=(_aiordie_emit_osc7)'));
    assert(!zsh.includes('add-zsh-hook'));

    const powershell = powershellShim();
    assert(powershell.includes('$global:AiOrDieOriginalPrompt = $promptCommand.ScriptBlock'));
    assert(powershell.includes('return & $global:AiOrDieOriginalPrompt'));
    assert(!powershell.includes('$host ='));
    assert(!powershell.includes('EscapeUriString'));
  });

  (has('pwsh') ? it : it.skip)('PowerShell URI builder encodes drive, UNC, spaces, unicode, hash, and question mark paths', function () {
    // A cold pwsh process on a hosted Ubuntu runner can exceed the 5s core
    // default even though its own child-process bound is 10s. Keep this
    // external-process test bounded without widening the whole unit suite.
    this.timeout(15000);
    const integration = manager.prepare('uri-session', 'pwsh');
    const script = integration.script.replace(/'/g, "''");
    const home = path.join(root, 'empty-home');
    const config = path.join(root, 'empty-config');
    fs.mkdirSync(home);
    fs.mkdirSync(config);
    const command = [
      `. '${script}'`,
      '$values = @(',
      "  'C:\\dir with space\\résumé#?.txt',",
      "  '\\\\server\\share\\dir with space',",
      "  '/tmp/dir with space/résumé#?.txt'",
      ')',
      '$values | ForEach-Object { _AiOrDieOsc7Uri $_ }',
    ].join('\n');
    const result = childProcess.spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', command], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: config,
        AIORDIE_SHELL_READY: integration.readyFile,
      },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines[0], 'file:///C:/dir%20with%20space/r%C3%A9sum%C3%A9%23%3F.txt');
    assert.strictEqual(
      lines[1],
      process.platform === 'win32'
        ? 'file://server/share/dir%20with%20space'
        : 'file:///server/share/dir%20with%20space'
    );
    assert.strictEqual(lines[2], 'file:///tmp/dir%20with%20space/r%C3%A9sum%C3%A9%23%3F.txt');
  });

  it('does nothing for fish, cmd.exe, and unknown shells', function () {
    assert.strictEqual(manager.prepare('fish', '/usr/bin/fish'), null);
    assert.strictEqual(manager.prepare('cmd', 'cmd.exe'), null);
    assert.strictEqual(manager.prepare('other', '/bin/sh'), null);
  });

  it('prefers in-box Windows PowerShell over cmd.exe when pwsh is absent', async function () {
    const TerminalBridge = require('../src/terminal-bridge');
    const bridge = new TerminalBridge();
    await bridge._commandReady;
    bridge.isWindows = true;
    bridge.resolveFullPathAsync = async (command) => {
      if (command === 'pwsh') return null;
      if (command === 'powershell.exe') return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      return null;
    };
    assert.strictEqual(
      await bridge.getDefaultShell(),
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    );
    await bridge.cleanup();
  });

  it('rejects a duplicate session before replacing its live shell integration state', async function () {
    const TerminalBridge = require('../src/terminal-bridge');
    const bridge = new TerminalBridge();
    await bridge._commandReady;
    bridge.command = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    const existingIntegration = bridge._shellIntegration.prepare('duplicate', bridge.command);
    bridge.sessions.set('duplicate', { active: true });
    await assert.rejects(
      bridge.startSession('duplicate'),
      /already exists/
    );
    assert.strictEqual(bridge._shellIntegration.get('duplicate'), existingIntegration);
    bridge.sessions.delete('duplicate');
    await bridge.cleanup();
  });

  it('fails safely when the integration root is a symlink', function () {
    if (process.platform === 'win32') this.skip();
    const target = path.join(root, 'target');
    const link = path.join(root, 'unsafe-root');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);
    const unsafe = new ShellIntegrationManager({ root: link });
    assert.strictEqual(unsafe.prepare('session', '/bin/bash'), null);
  });
});
