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
