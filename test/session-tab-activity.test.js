const assert = require('assert');

// Minimal DOM shim for Node.js
const mockElement = (tag) => {
  const el = {
    _tag: tag,
    _children: [],
    _attrs: {},
    _classes: new Set(),
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
      contains(c) { return el._classes.has(c); },
      toggle(c) { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); },
    },
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return el._attrs[k] || null; },
    querySelector(sel) {
      if (sel === '.tab-name') return el._tabNameChild || null;
      if (sel === '.tab-status-border') return el._statusChild || null;
      return null;
    },
    querySelectorAll() { return []; },
    appendChild(child) { el._children.push(child); },
    remove() {},
    closest() { return null; },
    addEventListener() {},
  };
  return el;
};

// Stub out globals that session-manager.js expects
global.window = global.window || {};
global.document = global.document || {
  createElement(tag) { return mockElement(tag); },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  head: { appendChild() {} },
  body: { appendChild() {} },
  title: '',
  visibilityState: 'visible',
};

if (!global.window.addEventListener) global.window.addEventListener = () => {};
if (!global.window.innerWidth) global.window.innerWidth = 1024;

// Load module (will attach to global.window.SessionTabManager)
const { SessionTabManager } = require('../src/public/session-manager');

/**
 * Build a minimal SessionTabManager instance with a fake tab and session.
 */
function buildManager(sessionId, sessionName, toolType) {
  const mgr = Object.create(SessionTabManager.prototype);
  mgr.tabs = new Map();
  mgr.activeSessions = new Map();
  mgr.activeTabId = null;
  mgr.tabOrder = [];
  mgr.tabHistory = [];
  mgr._tabActivityTimestamps = new Map();
  mgr.claudeInterface = { getAlias: (kind) => kind === 'codex' ? 'Codex' : 'Claude' };

  // Create a mock tab element with a .tab-name child
  const tab = mockElement('div');
  const nameEl = mockElement('span');
  nameEl.textContent = sessionName;
  nameEl._attrs.title = sessionName;
  tab._tabNameChild = nameEl;

  mgr.tabs.set(sessionId, tab);
  mgr.activeSessions.set(sessionId, {
    id: sessionId,
    name: sessionName,
    status: 'idle',
    toolType: toolType || 'claude',
    lastAccessed: Date.now(),
    lastActivity: Date.now(),
  });

  return { mgr, tab, nameEl };
}

describe('SessionTabManager.updateTabActivity', () => {
  it('should set "Thinking..." when output contains thinking indicator', () => {
    const { mgr, nameEl } = buildManager('s1', 'MySession', 'claude');
    mgr.updateTabActivity('s1', 'Some preamble... Thinking about the problem');
    assert.strictEqual(nameEl.textContent, 'Claude: Thinking...');
    assert.strictEqual(nameEl._attrs.title, 'Claude: Thinking...');
  });

  it('should set "Reading..." when output contains reading indicator', () => {
    const { mgr, nameEl } = buildManager('s1', 'MySession', 'claude');
    mgr.updateTabActivity('s1', 'Reading file src/index.js');
    assert.strictEqual(nameEl.textContent, 'Claude: Reading...');
  });

  it('should set "Running..." when output contains shell prompt', () => {
    const { mgr, nameEl } = buildManager('s1', 'MySession', 'claude');
    mgr.updateTabActivity('s1', '$ npm test');
    assert.strictEqual(nameEl.textContent, 'Claude: Running...');
  });

  it('should set "Running..." when output contains running keyword', () => {
    const { mgr, nameEl } = buildManager('s1', 'MySession', 'claude');
    mgr.updateTabActivity('s1', 'running tests...');
    assert.strictEqual(nameEl.textContent, 'Claude: Running...');
  });

  it('should restore original name when no activity pattern matches', () => {
    const { mgr, nameEl } = buildManager('s1', 'MySession', 'claude');
    // First set an activity label
    mgr.updateTabActivity('s1', 'Thinking hard');
    assert.strictEqual(nameEl.textContent, 'Claude: Thinking...');

    // Advance throttle timestamp so next update is allowed
    mgr._tabActivityTimestamps.set('s1', Date.now() - 3000);

    // Now send non-matching output
    mgr.updateTabActivity('s1', 'Hello world, just normal output');
    assert.strictEqual(nameEl.textContent, 'MySession');
  });

  it('should throttle updates within 2 seconds', () => {
    const { mgr, nameEl } = buildManager('s1', 'MySession', 'claude');
    mgr.updateTabActivity('s1', 'Thinking about it');
    assert.strictEqual(nameEl.textContent, 'Claude: Thinking...');

    // Second call within 2s should be skipped
    mgr.updateTabActivity('s1', 'Reading file foo.js');
    assert.strictEqual(nameEl.textContent, 'Claude: Thinking...');
  });

  it('should allow update after throttle period expires', () => {
    const { mgr, nameEl } = buildManager('s1', 'MySession', 'claude');
    mgr.updateTabActivity('s1', 'Thinking about it');
    assert.strictEqual(nameEl.textContent, 'Claude: Thinking...');

    // Simulate time passing
    mgr._tabActivityTimestamps.set('s1', Date.now() - 3000);

    mgr.updateTabActivity('s1', 'Reading file foo.js');
    assert.strictEqual(nameEl.textContent, 'Claude: Reading...');
  });

  it('should use the correct alias for codex tool type', () => {
    const { mgr, nameEl } = buildManager('s1', 'MySession', 'codex');
    mgr.updateTabActivity('s1', 'Thinking');
    assert.strictEqual(nameEl.textContent, 'Codex: Thinking...');
  });

  it('should strip ANSI codes before matching patterns', () => {
    const { mgr, nameEl } = buildManager('s1', 'MySession', 'claude');
    mgr.updateTabActivity('s1', '\x1b[1m\x1b[34mThinking about approach\x1b[0m');
    assert.strictEqual(nameEl.textContent, 'Claude: Thinking...');
  });

  it('should be a no-op for unknown session ID', () => {
    const { mgr } = buildManager('s1', 'MySession', 'claude');
    // Should not throw
    mgr.updateTabActivity('unknown-id', 'Thinking');
  });
});

describe('SessionTabManager.restoreTabTitle', () => {
  it('should restore the original session name', () => {
    const { mgr, nameEl } = buildManager('s1', 'MySession', 'claude');
    // Trigger an activity update to store _originalName
    mgr.updateTabActivity('s1', 'Thinking');
    assert.strictEqual(nameEl.textContent, 'Claude: Thinking...');

    mgr.restoreTabTitle('s1');
    assert.strictEqual(nameEl.textContent, 'MySession');
    assert.strictEqual(nameEl._attrs.title, 'MySession');
  });

  it('should clear the throttle timestamp', () => {
    const { mgr } = buildManager('s1', 'MySession', 'claude');
    mgr.updateTabActivity('s1', 'Thinking');
    assert.ok(mgr._tabActivityTimestamps.has('s1'));

    mgr.restoreTabTitle('s1');
    assert.ok(!mgr._tabActivityTimestamps.has('s1'));
  });

  it('should be a no-op for unknown session ID', () => {
    const { mgr } = buildManager('s1', 'MySession', 'claude');
    // Should not throw
    mgr.restoreTabTitle('unknown-id');
  });
});
