'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', 'src', 'public', 'command-palette.js');

function loadManager(options) {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const originalWindow = global.window;
  const originalDocument = global.document;
  const originalSetTimeout = global.setTimeout;
  const ninja = {
    data: [],
    addEventListener() {},
    open() {},
  };
  global.document = {
    readyState: 'complete',
    addEventListener() {},
    querySelector(selector) { return selector === 'ninja-keys' ? ninja : null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    activeElement: null,
  };
  global.window = { app: options && options.app, feedback: options && options.feedback };
  global.setTimeout = () => 0;
  try {
    // eslint-disable-next-line no-eval
    eval(source);
    const Manager = global.window.commandPaletteManager.constructor;
    return { manager: new Manager(options), ninja };
  } finally {
    global.window = originalWindow;
    global.document = originalDocument;
    global.setTimeout = originalSetTimeout;
  }
}

describe('command palette terminal copy seam', function () {
  it('resolves the main terminal in single-pane mode', function () {
    const app = { terminal: { marker: 'main' } };
    const { manager } = loadManager({ app });

    assert.strictEqual(manager._getActiveTerminal(app), app.terminal);
  });

  it('resolves the active split terminal when split view is enabled', async function () {
    const calls = [];
    const left = { marker: 'left' };
    const right = { marker: 'right' };
    const app = {
      terminal: { marker: 'hidden-main' },
      splitContainer: {
        enabled: true,
        activeSplitIndex: 1,
        splits: [{ terminal: left }, { terminal: right }],
      },
    };
    const loaded = loadManager({
      app,
      copyBuffer: async (terminal) => {
        calls.push(terminal);
        return { ok: true, source: 'buffer' };
      },
    });

    assert.strictEqual(loaded.manager._getActiveTerminal(app), right);
    assert.deepStrictEqual(await loaded.manager._copyActiveBuffer(app), {
      ok: true,
      source: 'buffer',
    });
    assert.deepStrictEqual(calls, [right]);
  });

  it('returns empty without copying when the enabled active pane is missing or invalid', async function () {
    const calls = [];
    const hiddenMain = { marker: 'hidden-main' };
    const app = {
      terminal: hiddenMain,
      splitContainer: {
        enabled: true,
        activeSplitIndex: 1,
        splits: [{ terminal: { marker: 'left' } }],
      },
    };
    const loaded = loadManager({
      app,
      copyBuffer: (terminal) => {
        calls.push(terminal);
        return { ok: true, source: 'buffer' };
      },
    });

    assert.strictEqual(loaded.manager._getActiveTerminal(app), null);
    assert.deepStrictEqual(await loaded.manager._copyActiveBuffer(app), {
      ok: false,
      reason: 'empty',
    });
    assert.deepStrictEqual(calls, []);

    app.splitContainer.activeSplitIndex = 2;
    assert.strictEqual(loaded.manager._getActiveTerminal(app), null);
    assert.deepStrictEqual(await loaded.manager._copyActiveBuffer(app), {
      ok: false,
      reason: 'empty',
    });
    assert.deepStrictEqual(calls, []);

    app.splitContainer.activeSplitIndex = '1';
    assert.strictEqual(loaded.manager._getActiveTerminal(app), null);
    assert.deepStrictEqual(await loaded.manager._copyActiveBuffer(app), {
      ok: false,
      reason: 'empty',
    });
    assert.deepStrictEqual(calls, []);
  });

  it('copies the complete active buffer through the injected seam', async function () {
    const calls = [];
    const app = { terminal: { marker: 'active' } };
    const loaded = loadManager({
      app,
      copyBuffer: async (terminal) => {
        calls.push(terminal);
        return { ok: true, source: 'buffer' };
      },
    });
    assert.ok(loaded.manager, 'manager should load');
    const result = await loaded.manager._copyActiveBuffer(app);
    assert.deepStrictEqual(result, { ok: true, source: 'buffer' });
    assert.deepStrictEqual(calls, [app.terminal]);
  });

  it('does not require selectAll or document.execCommand', async function () {
    const app = {
      terminal: {
        selectAll() { throw new Error('must not select'); },
      },
    };
    const loaded = loadManager({
      app,
      copyBuffer: () => ({ ok: false, reason: 'empty' }),
    });
    const source = fs.readFileSync(SOURCE, 'utf8');
    assert.ok(!source.includes('execCommand'), 'palette must not use execCommand');
    assert.deepStrictEqual(await loaded.manager._copyActiveBuffer(app), { ok: false, reason: 'empty' });
  });
});
