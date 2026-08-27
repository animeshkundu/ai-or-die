'use strict';

// Regression coverage for dragover acceptance when browsers protect custom
// DataTransfer values until the final drop event.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', 'src', 'public', 'splits.js');

function loadSplitContainer() {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const noop = function () {};
  const makeElement = () => ({
    classList: { add: noop, remove: noop },
    appendChild: noop,
    addEventListener: noop,
    setAttribute: noop,
    style: {},
  });
  const main = makeElement();
  const terminalContainer = makeElement();
  terminalContainer.id = 'terminalContainer';
  terminalContainer.getBoundingClientRect = () => ({ right: 800 });
  const document = {
    querySelector: () => main,
    getElementById: (id) => id === 'terminalContainer' ? terminalContainer : null,
    createElement: makeElement,
    addEventListener: noop,
    body: makeElement(),
  };
  const sandbox = {
    window: {},
    document,
    localStorage: { getItem: () => null, setItem: noop },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    WebSocket: { OPEN: 1 },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\n;globalThis.__SplitContainer = SplitContainer;', sandbox, {
    filename: 'splits.js',
  });
  return { SplitContainer: sandbox.__SplitContainer, terminalContainer };
}

describe('SplitContainer dragover payload acceptance', function () {
  it('accepts a custom session payload when dragover getData is protected', function () {
    const { SplitContainer, terminalContainer } = loadSplitContainer();
    const listeners = {};
    terminalContainer.addEventListener = (type, handler) => { listeners[type] = handler; };
    const container = Object.create(SplitContainer.prototype);
    container.enabled = false;
    container.app = { currentClaudeSessionId: 'current' };
    container.splitContainerEl = null;
    container.setupDropZones();

    assert.strictEqual(typeof listeners.dragover, 'function');
    const dataTransfer = {
      dropEffect: 'none',
      types: ['text/plain', 'x-source-pane', 'application/x-session-id'],
      getData: () => '',
    };
    const event = {
      dataTransfer,
      clientX: 799,
      preventDefaultCalled: false,
      preventDefault() { this.preventDefaultCalled = true; },
    };

    listeners.dragover(event);

    assert.strictEqual(event.preventDefaultCalled, true);
    assert.strictEqual(dataTransfer.dropEffect, 'move');
  });

  it('does not accept an unrelated drag without a session payload', function () {
    const { SplitContainer, terminalContainer } = loadSplitContainer();
    const listeners = {};
    terminalContainer.addEventListener = (type, handler) => { listeners[type] = handler; };
    const container = Object.create(SplitContainer.prototype);
    container.enabled = false;
    container.app = { currentClaudeSessionId: 'current' };
    container.setupDropZones();

    const event = {
      dataTransfer: { types: ['Files'], getData: () => '', dropEffect: 'none' },
      clientX: 799,
      preventDefaultCalled: false,
      preventDefault() { this.preventDefaultCalled = true; },
    };
    listeners.dragover(event);
    assert.strictEqual(event.preventDefaultCalled, false);
  });
});
