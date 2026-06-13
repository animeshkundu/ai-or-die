'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { ClaudeCodeWebServer } = require('../src/server');
const SessionStore = require('../src/utils/session-store');

// Exercise the sticky-note server wiring at the method level (no port binding):
// we invoke the handler methods against a lightweight stub `this`, plus a real
// SessionStore round-trip for the persisted fields.

function makeStub(overrides = {}) {
  const sessions = new Map();
  const broadcasts = [];
  const summarizerCalls = [];
  const self = {
    claudeSessions: sessions,
    webSocketConnections: new Map([['ws1', { claudeSessionId: 's1' }]]),
    sessionStore: { markDirty() {} },
    _stickyNotesEnabledGlobally: true,
    stickyNoteEngine: { _enabled: true, getStatus: () => 'ready', getDownloadProgress: () => null },
    stickyNoteSummarizer: {
      enable: (id, opts) => summarizerCalls.push(['enable', id, opts]),
      disable: (id) => summarizerCalls.push(['disable', id]),
      cancel: (id) => summarizerCalls.push(['cancel', id]),
      isEnabled: () => false,
    },
    broadcastToSession: (id, data) => broadcasts.push({ id, data }),
    _ensureStickyNoteEngine: () => {},
    _maybeStartStickyNotes: ClaudeCodeWebServer.prototype._maybeStartStickyNotes,
    _isAiAgent: ClaudeCodeWebServer.prototype._isAiAgent,
    _isStickyEligible: ClaudeCodeWebServer.prototype._isStickyEligible,
    _startStickyJsonlPoll: () => {},
    _stickyJsonl: new Map(),
  };
  Object.assign(self, overrides);
  self._broadcasts = broadcasts;
  self._summarizerCalls = summarizerCalls;
  return self;
}

describe('sticky-note server wiring', function () {
  it('_isAiAgent recognises AI tools but not terminal', function () {
    const f = ClaudeCodeWebServer.prototype._isAiAgent;
    assert.strictEqual(f('claude'), true);
    assert.strictEqual(f('codex'), true);
    assert.strictEqual(f('copilot'), true);
    assert.strictEqual(f('gemini'), true);
    assert.strictEqual(f('terminal'), false);
    assert.strictEqual(f(null), false);
  });

  it('_isStickyEligible includes terminal tabs as well as AI tools', function () {
    const self = makeStub();
    const f = (t) => ClaudeCodeWebServer.prototype._isStickyEligible.call(self, t);
    assert.strictEqual(f('claude'), true);
    assert.strictEqual(f('codex'), true);
    assert.strictEqual(f('terminal'), true, 'terminal tabs are summarisable');
    assert.strictEqual(f('shell'), false);
    assert.strictEqual(f(null), false);
  });

  it('_onStickyNoteResult merges state + prepends an update, and broadcasts with rev', function () {
    const self = makeStub();
    self.claudeSessions.set('s1', { nameIsUserSet: false });
    ClaudeCodeWebServer.prototype._onStickyNoteResult.call(self, 's1', {
      note: { goal: 'g', done: ['a'], remaining: ['b'], update: 'started work' },
      autoTitle: 'Fix auth',
      rev: 3,
    });
    const session = self.claudeSessions.get('s1');
    assert.strictEqual(session.stickyNote.title, 'Fix auth');
    assert.strictEqual(session.stickyNote.goal, 'g');
    assert.deepStrictEqual(session.stickyNote.done, ['a']);
    assert.deepStrictEqual(session.stickyNote.remaining, ['b']);
    assert.strictEqual(session.stickyNote.updates.length, 1);
    assert.strictEqual(session.stickyNote.updates[0].text, 'started work');
    assert.strictEqual(session.stickyNote.rev, 3);
    assert.strictEqual(session.autoTitle, 'Fix auth');
    assert.strictEqual(self._broadcasts.length, 1);
    assert.strictEqual(self._broadcasts[0].data.type, 'sticky_note_update');
  });

  it('_onStickyNoteResult appends updates newest-first and caps the log', function () {
    const self = makeStub();
    self.claudeSessions.set('s1', { nameIsUserSet: false });
    for (let i = 1; i <= 30; i++) {
      ClaudeCodeWebServer.prototype._onStickyNoteResult.call(self, 's1', {
        note: { goal: 'g', done: [], remaining: [], update: 'u' + i },
        autoTitle: 'T',
        rev: i,
      });
    }
    const updates = self.claudeSessions.get('s1').stickyNote.updates;
    assert.strictEqual(updates.length, 25, 'capped at 25');
    assert.strictEqual(updates[0].text, 'u30', 'newest first');
    assert.strictEqual(updates[24].text, 'u6', 'oldest kept');
  });

  it('_onStickyNoteResult keeps prior goal/done when a weak gen returns empty', function () {
    const self = makeStub();
    self.claudeSessions.set('s1', { nameIsUserSet: false });
    ClaudeCodeWebServer.prototype._onStickyNoteResult.call(self, 's1', {
      note: { goal: 'real goal', done: ['x'], remaining: [], update: 'first' }, autoTitle: 'T', rev: 1,
    });
    ClaudeCodeWebServer.prototype._onStickyNoteResult.call(self, 's1', {
      note: { goal: '', done: [], remaining: [], update: 'second' }, autoTitle: 'T', rev: 2,
    });
    const note = self.claudeSessions.get('s1').stickyNote;
    assert.strictEqual(note.goal, 'real goal', 'empty goal keeps prior');
    assert.deepStrictEqual(note.done, ['x'], 'empty done keeps prior');
    assert.strictEqual(note.updates[0].text, 'second');
  });

  it('_onStickyNoteResult does not override a user-renamed tab title', function () {
    const self = makeStub();
    self.claudeSessions.set('s1', { nameIsUserSet: true, name: 'My Tab' });
    ClaudeCodeWebServer.prototype._onStickyNoteResult.call(self, 's1', {
      note: { goal: 'g', done: [], remaining: [], update: 'u' },
      autoTitle: 'Auto',
      rev: 1,
    });
    const session = self.claudeSessions.get('s1');
    assert.strictEqual(session.autoTitle, undefined, 'autoTitle not set when user-renamed');
    assert.strictEqual(self._broadcasts[0].data.autoTitle, null, 'broadcast suppresses autoTitle');
  });

  it('_handleSetTabName pins the name and sets nameIsUserSet', function () {
    const self = makeStub();
    self.claudeSessions.set('s1', { nameIsUserSet: false, name: 'old', connections: new Set(['ws1']) });
    ClaudeCodeWebServer.prototype._handleSetTabName.call(self, 'ws1', { sessionId: 's1', name: 'Renamed' });
    const session = self.claudeSessions.get('s1');
    assert.strictEqual(session.name, 'Renamed');
    assert.strictEqual(session.nameIsUserSet, true);
  });

  it('_handleSetTabName ignores an empty name (does not pin)', function () {
    const self = makeStub();
    self.claudeSessions.set('s1', { nameIsUserSet: false, name: 'old', connections: new Set(['ws1']) });
    ClaudeCodeWebServer.prototype._handleSetTabName.call(self, 'ws1', { sessionId: 's1', name: '   ' });
    const session = self.claudeSessions.get('s1');
    assert.strictEqual(session.nameIsUserSet, false, 'empty name must not pin the tab');
    assert.strictEqual(session.name, 'old');
  });

  it('rejects mutations from a socket that does not belong to the session', function () {
    const self = makeStub();
    self.claudeSessions.set('s1', { nameIsUserSet: false, name: 'old', stickyNotesEnabled: true, connections: new Set(['other']) });
    ClaudeCodeWebServer.prototype._handleSetTabName.call(self, 'ws1', { sessionId: 's1', name: 'Hijack' });
    ClaudeCodeWebServer.prototype._handleSetStickyNotes.call(self, 'ws1', { sessionId: 's1', enabled: false });
    const session = self.claudeSessions.get('s1');
    assert.strictEqual(session.name, 'old', 'cross-session rename rejected');
    assert.strictEqual(session.nameIsUserSet, false);
    assert.strictEqual(session.stickyNotesEnabled, true, 'cross-session toggle rejected');
    assert.strictEqual(self._summarizerCalls.length, 0);
  });

  it('_onStickyNoteResult drops stale (older rev) and opted-out results', function () {
    const self = makeStub();
    self.claudeSessions.set('s1', { nameIsUserSet: false, stickyNotesEnabled: true, stickyNote: { title: 'Cur', rev: 5 } });
    ClaudeCodeWebServer.prototype._onStickyNoteResult.call(self, 's1', {
      note: { goal: '', done: [], remaining: [], update: 'old' }, autoTitle: 'Old', rev: 4,
    });
    assert.strictEqual(self.claudeSessions.get('s1').stickyNote.title, 'Cur', 'stale rev dropped');
    assert.strictEqual(self._broadcasts.length, 0);

    self.claudeSessions.set('s2', { nameIsUserSet: false, stickyNotesEnabled: false, stickyNote: null });
    ClaudeCodeWebServer.prototype._onStickyNoteResult.call(self, 's2', {
      note: { goal: '', done: [], remaining: [], update: 'x' }, autoTitle: 'X', rev: 1,
    });
    assert.strictEqual(self.claudeSessions.get('s2').stickyNote, null, 'opted-out result dropped');
  });

  it('_handleSetStickyNotes disables and re-enables the summariser', function () {
    const self = makeStub();
    self.claudeSessions.set('s1', { active: true, agent: 'claude', stickyNote: null, connections: new Set(['ws1']) });

    ClaudeCodeWebServer.prototype._handleSetStickyNotes.call(self, 'ws1', { sessionId: 's1', enabled: false });
    assert.strictEqual(self.claudeSessions.get('s1').stickyNotesEnabled, false);
    assert.deepStrictEqual(self._summarizerCalls.pop(), ['disable', 's1']);

    ClaudeCodeWebServer.prototype._handleSetStickyNotes.call(self, 'ws1', { sessionId: 's1', enabled: true });
    assert.strictEqual(self.claudeSessions.get('s1').stickyNotesEnabled, true);
    assert.strictEqual(self._summarizerCalls.pop()[0], 'enable');
  });

  it('_maybeStartStickyNotes summarises terminal tabs too, but skips disabled sessions', function () {
    const self = makeStub();
    // Terminal tab is now eligible (users run AI CLIs inside a shell).
    self.claudeSessions.set('term', { stickyNotesEnabled: true, stickyNote: null });
    ClaudeCodeWebServer.prototype._maybeStartStickyNotes.call(self, 'term', 'terminal', 80, 24);
    assert.strictEqual(self._summarizerCalls.length, 1, 'terminal tab IS summarised');
    assert.strictEqual(self._summarizerCalls[0][0], 'enable');

    // Explicitly opted-out session is skipped regardless of kind.
    self.claudeSessions.set('off', { stickyNotesEnabled: false });
    ClaudeCodeWebServer.prototype._maybeStartStickyNotes.call(self, 'off', 'terminal', 80, 24);
    assert.strictEqual(self._summarizerCalls.length, 1, 'opted-out terminal not summarised');

    // AI-agent tab still summarised.
    self.claudeSessions.set('on', { stickyNotesEnabled: true, stickyNote: null });
    ClaudeCodeWebServer.prototype._maybeStartStickyNotes.call(self, 'on', 'claude', 80, 24);
    assert.strictEqual(self._summarizerCalls.length, 2);
    assert.strictEqual(self._summarizerCalls[1][0], 'enable');
  });
});

describe('sticky-note persistence (session-store round-trip)', function () {
  let dir;
  beforeEach(async function () {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aod-store-'));
  });
  afterEach(async function () {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('persists and restores stickyNote / autoTitle / nameIsUserSet / stickyNotesEnabled', async function () {
    const store = new SessionStore({ storageDir: dir });
    const sessions = new Map();
    sessions.set('s1', {
      name: 'T',
      workingDir: '/tmp',
      stickyNote: { title: 'X', goal: 'g', done: ['a'], remaining: ['b'], updates: [{ text: 'u1', at: 'now' }], rev: 2, updatedAt: 'now', status: 'idle', error: null },
      autoTitle: 'X',
      nameIsUserSet: true,
      stickyNotesEnabled: false,
    });
    store.markDirty();
    await store.saveSessions(sessions);

    const loaded = await store.loadSessions();
    const s = loaded.get('s1');
    assert.ok(s, 'session restored');
    assert.strictEqual(s.stickyNote.title, 'X');
    assert.deepStrictEqual(s.stickyNote.done, ['a']);
    assert.deepStrictEqual(s.stickyNote.remaining, ['b']);
    assert.strictEqual(s.stickyNote.updates[0].text, 'u1');
    assert.strictEqual(s.stickyNote.rev, 2);
    assert.strictEqual(s.autoTitle, 'X');
    assert.strictEqual(s.nameIsUserSet, true);
    assert.strictEqual(s.stickyNotesEnabled, false);
  });

  it('restores old sessions without the new fields (clean migration)', async function () {
    // Write a legacy file shape directly.
    const legacy = {
      version: '1.0',
      savedAt: new Date().toISOString(),
      sessions: [{ id: 'old', name: 'Legacy', workingDir: '/tmp', outputBuffer: [] }],
    };
    await fsp.writeFile(path.join(dir, 'sessions.json'), JSON.stringify(legacy));
    const store = new SessionStore({ storageDir: dir });
    const loaded = await store.loadSessions();
    const s = loaded.get('old');
    assert.ok(s, 'legacy session loads without error');
    assert.ok(!s.stickyNote, 'no sticky note for a legacy session (null/undefined)');
    assert.notStrictEqual(s.stickyNotesEnabled, false); // undefined -> treated as enabled
  });

  it('migrates a legacy progress/waitingOn note to done/remaining/updates', function () {
    const m = SessionStore.migrateStickyNote({
      title: 'T', goal: 'g', progress: ['did a', 'did b'], waitingOn: ['need c'], rev: 7, updatedAt: 'then',
    });
    assert.deepStrictEqual(m.done, ['did a', 'did b']);
    assert.deepStrictEqual(m.remaining, ['need c']);
    assert.deepStrictEqual(m.updates, []);
    assert.strictEqual(m.title, 'T');
    assert.strictEqual(m.rev, 7);
    // A v2 note passes through, but always gains an updates[] array.
    const v2 = SessionStore.migrateStickyNote({ goal: 'g', done: [], remaining: [] });
    assert.ok(Array.isArray(v2.updates));
  });
});
