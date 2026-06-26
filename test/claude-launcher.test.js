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
});
