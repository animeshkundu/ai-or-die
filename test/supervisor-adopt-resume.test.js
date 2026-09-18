'use strict';

// Adopt-respawn (ADR-0058): after a binary swap the new Server relaunches
// each transferred session headlessly — same cwd, persisted launch options,
// CLI-native resume argv where the bridge knows one.

const assert = require('assert');
const os = require('os');
const BaseBridge = require('../src/base-bridge');
const ClaudeBridge = require('../src/claude-bridge');
const CopilotBridge = require('../src/copilot-bridge');
const { ClaudeCodeWebServer } = require('../src/server');

describe('bridge resumeArgsForAdopt', function () {
  it('base default is a fresh respawn (no extra argv)', function () {
    const base = new BaseBridge('Test', { commandPaths: { linux: [] }, defaultCommand: 'true' });
    assert.deepStrictEqual(base.resumeArgsForAdopt({ stickyClaudeSessionId: 'abc' }), []);
  });

  it('claude resumes the exact session when its id is known', function () {
    const claude = new ClaudeBridge();
    assert.deepStrictEqual(
      claude.resumeArgsForAdopt({ stickyClaudeSessionId: 'sess-123' }),
      ['--resume', 'sess-123']
    );
    assert.deepStrictEqual(
      claude.resumeArgsForAdopt({ claudePinnedSessionId: 'pinned-9' }),
      ['--resume', 'pinned-9']
    );
  });

  it('claude never duplicates a user-supplied resume flag', function () {
    const claude = new ClaudeBridge();
    assert.deepStrictEqual(
      claude.resumeArgsForAdopt({
        stickyClaudeSessionId: 'sess-123',
        launchOptions: { agentArgs: ['--resume', 'other'] },
      }),
      []
    );
    assert.deepStrictEqual(
      claude.resumeArgsForAdopt({
        stickyClaudeSessionId: 'sess-123',
        launchOptions: { agentArgs: ['--continue'] },
      }),
      []
    );
  });

  it('claude falls back to a fresh start without an id', function () {
    const claude = new ClaudeBridge();
    assert.deepStrictEqual(claude.resumeArgsForAdopt({}), []);
    assert.deepStrictEqual(claude.resumeArgsForAdopt(null), []);
  });

  it('copilot continues the most recent session unless told otherwise', function () {
    const copilot = new CopilotBridge();
    assert.deepStrictEqual(copilot.resumeArgsForAdopt({}), ['--continue']);
    assert.deepStrictEqual(
      copilot.resumeArgsForAdopt({ launchOptions: { agentArgs: ['--continue'] } }),
      []
    );
  });

  it('copilot buildArgs passes agentArgs through', function () {
    const copilot = new CopilotBridge();
    assert.deepStrictEqual(
      copilot.buildArgs({ agentArgs: ['--continue'] }),
      ['--continue']
    );
  });
});

describe('server _adoptHandoffSessions', function () {
  let server;
  const spawned = [];

  function fakeBridge(resumeArgs) {
    return {
      _commandReady: Promise.resolve(),
      isAvailable: () => true,
      resumeArgsForAdopt: () => resumeArgs,
      startSession: async (sessionId, opts) => {
        spawned.push({ sessionId, opts });
        return { started: true };
      },
    };
  }

  before(function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    server.terminalBridge = fakeBridge([]);
    server.claudeBridge = fakeBridge(['--resume', 'sess-123']);
  });

  after(function () {
    return server.close().catch(() => { /* ignore */ });
  });

  beforeEach(function () {
    spawned.length = 0;
    for (const id of Array.from(server.claudeSessions.keys())) {
      if (id.startsWith('adopt-')) server.claudeSessions.delete(id);
    }
  });

  function persistedEntry(overrides = {}) {
    return {
      id: 'adopt-1',
      name: 'adopted',
      workingDir: os.tmpdir(),
      active: false,
      wasActive: true,
      agent: 'terminal',
      outputBuffer: [],
      connections: [],
      stickyClaudeSessionId: null,
      launchOptions: null,
      ...overrides,
    };
  }

  it('respawns a terminal session in place with persisted launch options', async function () {
    server.sessionStore.loadSessions = async () => new Map([
      ['adopt-1', persistedEntry({
        launchOptions: { dangerouslySkipPermissions: true, permissionMode: null, agentArgs: null },
      })],
    ]);
    const result = await server._adoptHandoffSessions([{ ptyId: 'adopt-1', bridgeType: 'Terminal', pid: 1 }]);
    assert.deepStrictEqual(result, { adopted: 1, skipped: 0 });
    assert.strictEqual(spawned.length, 1);
    assert.strictEqual(spawned[0].opts.workingDir, os.tmpdir());
    assert.strictEqual(spawned[0].opts.dangerouslySkipPermissions, true);
    const session = server.claudeSessions.get('adopt-1');
    assert.ok(session && session.active, 'adopted session is live on the new server');
  });

  it('claude adopt carries --resume for the known session', async function () {
    server.sessionStore.loadSessions = async () => new Map([
      ['adopt-2', persistedEntry({ id: 'adopt-2', agent: 'claude', stickyClaudeSessionId: 'sess-123' })],
    ]);
    const result = await server._adoptHandoffSessions([{ ptyId: 'adopt-2', bridgeType: 'Claude', pid: 2 }]);
    assert.deepStrictEqual(result, { adopted: 1, skipped: 0 });
    assert.deepStrictEqual(spawned[0].opts.agentArgs, ['--resume', 'sess-123']);
  });

  it('skips unknown agents and missing sessions', async function () {
    server.sessionStore.loadSessions = async () => new Map();
    const result = await server._adoptHandoffSessions([
      { ptyId: 'adopt-x', bridgeType: 'Nope', pid: 3 },
      { ptyId: 'adopt-y', bridgeType: 'Terminal', pid: 4 },
    ]);
    assert.deepStrictEqual(result, { adopted: 0, skipped: 2 });
    assert.strictEqual(spawned.length, 0);
  });

  it('skips sessions already running here', async function () {
    server.sessionStore.loadSessions = async () => new Map([
      ['adopt-3', persistedEntry({ id: 'adopt-3' })],
    ]);
    server.claudeSessions.set('adopt-3', { id: 'adopt-3', active: true, agent: 'terminal', workingDir: os.tmpdir(), connections: new Set(), outputBuffer: [] });
    const result = await server._adoptHandoffSessions([{ ptyId: 'adopt-3', bridgeType: 'Terminal', pid: 5 }]);
    assert.deepStrictEqual(result, { adopted: 0, skipped: 1 });
    assert.strictEqual(spawned.length, 0);
  });
});
