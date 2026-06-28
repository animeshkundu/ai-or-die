'use strict';

const assert = require('assert');
const ClaudeBridge = require('../src/claude-bridge');
const { resolveClaudeLauncher } = require('../src/claude-bridge');

describe('claude launcher (always via github-router)', function () {
  describe('resolveClaudeLauncher', function () {
    it('defaults to `npx -y github-router@latest claude --browse` on POSIX', function () {
      const l = resolveClaudeLauncher({}, 'linux');
      assert.equal(l.command, 'npx');
      assert.deepEqual(l.prefixArgs, ['-y', 'github-router@latest', 'claude', '--browse']);
    });

    it('uses npx.cmd on Windows', function () {
      const l = resolveClaudeLauncher({}, 'win32');
      assert.equal(l.command, 'npx.cmd');
      assert.deepEqual(l.prefixArgs, ['-y', 'github-router@latest', 'claude', '--browse']);
    });

    it('AIORDIE_CLAUDE_LAUNCHER="claude" selects the raw CLI (offline/tests)', function () {
      const l = resolveClaudeLauncher({ AIORDIE_CLAUDE_LAUNCHER: 'claude' }, 'linux');
      assert.equal(l.command, 'claude');
      assert.deepEqual(l.prefixArgs, []);
    });

    it('AIORDIE_CLAUDE_LAUNCHER accepts a multi-word custom wrapper', function () {
      const l = resolveClaudeLauncher({ AIORDIE_CLAUDE_LAUNCHER: 'github-router claude' }, 'linux');
      assert.equal(l.command, 'github-router');
      assert.deepEqual(l.prefixArgs, ['claude']);
    });

    it('blank override falls back to the npx default', function () {
      const l = resolveClaudeLauncher({ AIORDIE_CLAUDE_LAUNCHER: '   ' }, 'linux');
      assert.equal(l.command, 'npx');
    });
  });

  describe('ClaudeBridge wiring', function () {
    it('spawns via the launcher command (not raw claude) and prepends prefix args', function () {
      const bridge = new ClaudeBridge();
      // command is the launcher binary (npx / npx.cmd), never the bare claude path.
      assert.ok(bridge.command === 'npx' || bridge.command === 'npx.cmd');
      const args = bridge.buildArgs();
      assert.deepEqual(args.slice(0, 4), ['-y', 'github-router@latest', 'claude', '--browse']);
    });

    it('appends the dangerous flag AFTER the github-router prefix', function () {
      const bridge = new ClaudeBridge();
      const args = bridge.buildArgs({ dangerouslySkipPermissions: true });
      assert.deepEqual(args, ['-y', 'github-router@latest', 'claude', '--browse', '--dangerously-skip-permissions']);
    });
  });

  describe('F10 — ClaudeBridge.buildArgs permission mode', function () {
    const PREFIX = ['-y', 'github-router@latest', 'claude', '--browse'];

    it('appends --permission-mode <mode> AFTER the launcher prefix', function () {
      const bridge = new ClaudeBridge();
      const args = bridge.buildArgs({ permissionMode: 'plan' });
      assert.deepEqual(args, [...PREFIX, '--permission-mode', 'plan']);
    });

    it('accepts every allowlisted mode', function () {
      const bridge = new ClaudeBridge();
      for (const mode of ['plan', 'acceptEdits', 'default', 'bypassPermissions']) {
        assert.deepEqual(bridge.buildArgs({ permissionMode: mode }), [...PREFIX, '--permission-mode', mode]);
      }
    });

    it('permissionMode supersedes the legacy dangerous flag (github-router drops it)', function () {
      const bridge = new ClaudeBridge();
      const args = bridge.buildArgs({ permissionMode: 'plan', dangerouslySkipPermissions: true });
      assert.deepEqual(args, [...PREFIX, '--permission-mode', 'plan']);
      assert.ok(!args.includes('--dangerously-skip-permissions'));
    });

    it('appends caller agentArgs after the permission flag', function () {
      const bridge = new ClaudeBridge();
      const args = bridge.buildArgs({ permissionMode: 'acceptEdits', agentArgs: ['--model', 'opus'] });
      assert.deepEqual(args, [...PREFIX, '--permission-mode', 'acceptEdits', '--model', 'opus']);
    });

    it('rejects an unknown permissionMode with INVALID_ARGUMENT', function () {
      const bridge = new ClaudeBridge();
      assert.throws(
        () => bridge.buildArgs({ permissionMode: 'yolo' }),
        (e) => e.code === 'INVALID_ARGUMENT'
      );
    });

    it('rejects agentArgs carrying --permission-mode (conflict) with INVALID_ARGUMENT', function () {
      const bridge = new ClaudeBridge();
      assert.throws(
        () => bridge.buildArgs({ agentArgs: ['--permission-mode', 'plan'] }),
        (e) => e.code === 'INVALID_ARGUMENT'
      );
      assert.throws(
        () => bridge.buildArgs({ agentArgs: ['--permission-mode=plan'] }),
        (e) => e.code === 'INVALID_ARGUMENT'
      );
    });

    it('rejects agentArgs carrying --dangerously-skip-permissions (conflict) with INVALID_ARGUMENT', function () {
      const bridge = new ClaudeBridge();
      assert.throws(
        () => bridge.buildArgs({ permissionMode: 'plan', agentArgs: ['--dangerously-skip-permissions'] }),
        (e) => e.code === 'INVALID_ARGUMENT'
      );
    });

    it('rejects a non-array agentArgs with INVALID_ARGUMENT', function () {
      const bridge = new ClaudeBridge();
      assert.throws(
        () => bridge.buildArgs({ agentArgs: '--model opus' }),
        (e) => e.code === 'INVALID_ARGUMENT'
      );
    });

    it('no permissionMode + no dangerous flag → bare prefix (back-compat)', function () {
      const bridge = new ClaudeBridge();
      assert.deepEqual(bridge.buildArgs(), [...PREFIX]);
    });

    it('terminal agent ignores permissionMode/agentArgs (no flags, no throw)', function () {
      const TerminalBridge = require('../src/terminal-bridge');
      const bridge = new TerminalBridge();
      assert.deepEqual(bridge.buildArgs({ permissionMode: 'plan', agentArgs: ['--permission-mode', 'x'] }), []);
    });
  });
});
