'use strict';

const assert = require('assert');
const { applySshClipboardHint } = require('../src/base-bridge');

describe('base-bridge SSH clipboard hint (remote TUI copy fix)', function () {
  const VARS = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'AIORDIE_NO_SSH_CLIPBOARD_HINT'];
  let saved = {};

  beforeEach(function () {
    saved = {};
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(function () {
    for (const v of VARS) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
      else delete process.env[v];
    }
  });

  it('sets SSH_CONNECTION/SSH_CLIENT when no SSH vars are present', function () {
    const env = applySshClipboardHint({});
    assert.ok(env.SSH_CONNECTION, 'SSH_CONNECTION set');
    assert.ok(env.SSH_CLIENT, 'SSH_CLIENT set');
    assert.strictEqual(env.SSH_TTY, undefined, 'SSH_TTY left alone (path semantics)');
  });

  it('never overrides a real SSH session (process env)', function () {
    process.env.SSH_CONNECTION = '10.0.0.5 51234 10.0.0.9 22';
    const env = applySshClipboardHint({});
    assert.strictEqual(env.SSH_CONNECTION, undefined);
    assert.strictEqual(env.SSH_CLIENT, undefined);
  });

  it('never overrides explicit per-session env', function () {
    const env = applySshClipboardHint({ SSH_TTY: '/dev/pts/3' });
    assert.strictEqual(env.SSH_CONNECTION, undefined);
    assert.strictEqual(env.SSH_TTY, '/dev/pts/3');
  });

  it('respects the AIORDIE_NO_SSH_CLIPBOARD_HINT=1 opt-out', function () {
    process.env.AIORDIE_NO_SSH_CLIPBOARD_HINT = '1';
    const env = applySshClipboardHint({});
    assert.strictEqual(env.SSH_CONNECTION, undefined);
    assert.strictEqual(env.SSH_CLIENT, undefined);
  });

  it('is a safe no-op for null/non-object input', function () {
    assert.strictEqual(applySshClipboardHint(null), null);
    assert.strictEqual(applySshClipboardHint(undefined), undefined);
  });
});
