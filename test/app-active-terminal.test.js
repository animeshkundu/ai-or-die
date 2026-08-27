'use strict';

// App-level active-terminal resolver coverage. The production class remains
// private to app.js; this harness exposes it only in the evaluated test VM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadAppClass() {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/public/app.js'),
    'utf8'
  );
  const noop = function () {};
  const element = {
    classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
    addEventListener: noop,
    appendChild: noop,
    setAttribute: noop,
    style: {},
    dataset: {},
  };
  const sandbox = {
    window: { addEventListener: noop, innerWidth: 1280 },
    document: {
      addEventListener: noop,
      createElement: () => element,
      body: { appendChild: noop },
      head: { appendChild: noop },
    },
    navigator: { userAgent: '' },
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext('var self = globalThis;', sandbox);
  vm.runInContext(
    source + '\n;globalThis.__ClaudeCodeWebInterface = ClaudeCodeWebInterface;',
    sandbox,
    { filename: 'app.js' }
  );
  return sandbox.__ClaudeCodeWebInterface;
}

describe('ClaudeCodeWebInterface.getActiveTerminal', function () {
  let getActiveTerminal;

  before(function () {
    const App = loadAppClass();
    getActiveTerminal = App.prototype.getActiveTerminal;
    assert.strictEqual(typeof getActiveTerminal, 'function');
  });

  it('returns the main terminal when split view is disabled or absent', function () {
    const main = { marker: 'main' };
    assert.strictEqual(getActiveTerminal.call({ terminal: main }), main);
    assert.strictEqual(
      getActiveTerminal.call({ terminal: main, splitContainer: { enabled: false } }),
      main
    );
  });

  it('returns the right split terminal for a valid active integer index', function () {
    const main = { marker: 'hidden-main' };
    const left = { marker: 'left' };
    const right = { marker: 'right' };
    const app = {
      terminal: main,
      splitContainer: {
        enabled: true,
        activeSplitIndex: 1,
        splits: [{ terminal: left }, { terminal: right }],
      },
    };

    assert.strictEqual(getActiveTerminal.call(app), right);
    assert.notStrictEqual(getActiveTerminal.call(app), main);
  });

  it('returns null for every malformed or unavailable enabled split target', function () {
    const main = { marker: 'hidden-main' };
    const cases = [
      { activeSplitIndex: undefined, splits: [{ terminal: { marker: 'left' } }] },
      { activeSplitIndex: '1', splits: [{ terminal: { marker: 'left' } }, { terminal: { marker: 'right' } }] },
      { activeSplitIndex: -1, splits: [{ terminal: { marker: 'left' } }] },
      { activeSplitIndex: 2, splits: [{ terminal: { marker: 'left' } }, { terminal: { marker: 'right' } }] },
      { activeSplitIndex: 1, splits: null },
      { activeSplitIndex: 1, splits: {} },
      { activeSplitIndex: 1, splits: [{ terminal: { marker: 'left' } }, {}] },
    ];

    for (const splitContainer of cases) {
      assert.strictEqual(
        getActiveTerminal.call({ terminal: main, splitContainer: { enabled: true, ...splitContainer } }),
        null,
        `expected null for ${JSON.stringify(splitContainer)}`
      );
    }
  });

  it('never falls back to the hidden main terminal in enabled split mode', function () {
    const main = { marker: 'hidden-main' };
    const app = {
      terminal: main,
      splitContainer: { enabled: true, activeSplitIndex: 0, splits: [] },
    };

    assert.strictEqual(getActiveTerminal.call(app), null);
    app.splitContainer.activeSplitIndex = 1;
    app.splitContainer.splits = [{ terminal: null }, { terminal: undefined }];
    assert.strictEqual(getActiveTerminal.call(app), null);
  });
});
