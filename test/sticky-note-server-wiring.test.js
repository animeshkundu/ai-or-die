'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { ClaudeCodeWebServer } = require('../src/server');
const SessionStore = require('../src/utils/session-store');
const StickyNoteJsonl = require('../src/sticky-note-jsonl');

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
    _claudeNotes: new Map(),
    _claudeOffsets: new Map(),
    _claudeNotesCap: 300,
    _mergeStickyNote: ClaudeCodeWebServer.prototype._mergeStickyNote,
    _capClaudeNotes: ClaudeCodeWebServer.prototype._capClaudeNotes,
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

  it('_onStickyNoteResult mirrors the note into _claudeNotes by claude sessionId', function () {
    const self = makeStub();
    self._claudeNotes = new Map();
    self._claudeNotesCap = 300;
    self._capClaudeNotes = ClaudeCodeWebServer.prototype._capClaudeNotes;
    self.claudeSessions.set('s1', { nameIsUserSet: false });
    self._stickyJsonl.set('s1', { file: '/p/CID.jsonl', offset: 0, claudeSessionId: 'CID' });
    ClaudeCodeWebServer.prototype._onStickyNoteResult.call(self, 's1', {
      note: { goal: 'g', done: ['a'], remaining: [], update: 'did work' }, autoTitle: 'T', rev: 1, claudeSessionId: 'CID',
    });
    assert.ok(self._claudeNotes.has('CID'), 'note stored under the claude sessionId');
    assert.strictEqual(self._claudeNotes.get('CID').goal, 'g');
  });

  it('_onStickyNoteResult routes a rebound result to the OUTGOING session (durable), not the current one', function () {
    const self = makeStub();
    self._claudeNotes = new Map([['OLD', { title: 'Old', goal: 'old goal', done: [], remaining: [], updates: [], rev: 3, updatedAt: 'then' }]]);
    self._claudeOffsets = new Map();
    self._claudeNotesCap = 300;
    self._mergeStickyNote = ClaudeCodeWebServer.prototype._mergeStickyNote;
    self._capClaudeNotes = ClaudeCodeWebServer.prototype._capClaudeNotes;
    self.claudeSessions.set('s1', { nameIsUserSet: false, stickyNote: { goal: 'current session', rev: 2 } });
    self._stickyJsonl.set('s1', { file: '/p/NEW.jsonl', offset: 0, claudeSessionId: 'NEW' });
    // Result carries the OLD session id (tab rebound while the inference ran).
    ClaudeCodeWebServer.prototype._onStickyNoteResult.call(self, 's1', {
      note: { goal: 'old refined goal', done: ['finished old work'], remaining: [], update: 'old final update' }, autoTitle: null, rev: null, claudeSessionId: 'OLD',
    });
    assert.strictEqual(self.claudeSessions.get('s1').stickyNote.goal, 'current session', 'current session UI untouched');
    assert.strictEqual(self._broadcasts.length, 0, 'no broadcast for the rebound session');
    assert.ok(self._claudeNotes.has('OLD'), 'outgoing session note preserved');
    assert.strictEqual(self._claudeNotes.get('OLD').goal, 'old refined goal', 'outgoing note refined + saved');
    assert.strictEqual(self._claudeNotes.get('OLD').updates[0].text, 'old final update');
  });
});

describe('sticky-note JSONL binding (ownership + resume)', function () {
  let dir, projects;
  function slug(cwd) { return StickyNoteJsonl.slugForCwd(cwd); }
  function writeSession(cwd, name, body, ageSec) {
    const d = path.join(projects, slug(cwd));
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, name);
    fs.writeFileSync(f, body || (JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n'));
    if (ageSec) { const t = Date.now() / 1000 - ageSec; fs.utimesSync(f, t, t); }
    return f;
  }
  function makeBindStub() {
    const feeds = [];
    const seeds = [];
    const broadcasts = [];
    const self = {
      _stickyJsonl: new Map(),
      _claudeNotes: new Map(),
      _claudeOffsets: new Map(),
      _stickyActive: new Map(),
      _claudeNotesCap: 300,
      _stickyResumeIdleTicks: 8,
      _stickyProjectsDir: projects,
      claudeSessions: new Map(),
      sessionStore: { markDirty() {} },
      stickyNoteSummarizer: {
        isEnabled: () => true,
        setNote: (id, note, rev) => seeds.push({ id, note, rev }),
        onRebind: (id, opts) => seeds.push(Object.assign({ id }, opts)),
        feedTurns: (id, text, title) => feeds.push({ id, text, title }),
      },
      broadcastToSession: (id, data) => broadcasts.push({ id, data }),
      sessionStore: { markDirty() {} },
      _ownedClaudeSessions: ClaudeCodeWebServer.prototype._ownedClaudeSessions,
      _bindStickyJsonl: ClaudeCodeWebServer.prototype._bindStickyJsonl,
      _capClaudeNotes: ClaudeCodeWebServer.prototype._capClaudeNotes,
      _statQuiet: ClaudeCodeWebServer.prototype._statQuiet,
      _isStickyExpandedActive: ClaudeCodeWebServer.prototype._isStickyExpandedActive,
      _applyAiTitle: ClaudeCodeWebServer.prototype._applyAiTitle,
      _pumpStickyJsonl: ClaudeCodeWebServer.prototype._pumpStickyJsonl,
    };
    self._feeds = feeds; self._seeds = seeds; self._broadcasts = broadcasts;
    // helper: mark a tab's card as "expanded" so note inference runs in the test
    self._expand = (tab) => self._stickyActive.set(tab, new Set(['ws']));
    return self;
  }

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snbind-'));
    projects = path.join(dir, 'projects');
    fs.mkdirSync(projects, { recursive: true });
  });
  afterEach(function () {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  it('binds a tab to its claude session and skips agent-*.jsonl', async function () {
    const cwd = '/Users/x/proj';
    writeSession(cwd, 'real-session.jsonl', null, 5);    // active, non-agent
    writeSession(cwd, 'agent-deadbeef.jsonl', null, 0);   // newest, but a subagent log
    const self = makeBindStub();
    self.claudeSessions.set('tab1', { nameIsUserSet: false });
    await self._pumpStickyJsonl('tab1', cwd);
    const b = self._stickyJsonl.get('tab1');
    assert.ok(b, 'tab bound');
    assert.strictEqual(b.claudeSessionId, 'real-session', 'agent-*.jsonl skipped; real session bound');
  });

  it('two tabs in the same project bind to distinct sessions (ownership)', async function () {
    const cwd = '/Users/x/proj';
    writeSession(cwd, 'sessA.jsonl', null, 50);
    writeSession(cwd, 'sessB.jsonl', null, 10); // newer
    const self = makeBindStub();
    self.claudeSessions.set('tab1', { nameIsUserSet: false });
    self.claudeSessions.set('tab2', { nameIsUserSet: false });
    await self._pumpStickyJsonl('tab1', cwd); // tab1 takes newest (sessB)
    await self._pumpStickyJsonl('tab2', cwd); // tab2 must NOT also take sessB
    const b1 = self._stickyJsonl.get('tab1');
    const b2 = self._stickyJsonl.get('tab2');
    assert.strictEqual(b1.claudeSessionId, 'sessB');
    assert.strictEqual(b2.claudeSessionId, 'sessA', 'second tab gets the other (unowned) session');
    assert.notStrictEqual(b1.file, b2.file);
  });

  it('resumes the durable note when binding a claude session that has one', async function () {
    const cwd = '/Users/x/proj';
    writeSession(cwd, 'resumed.jsonl', null, 0);
    const self = makeBindStub();
    const priorNote = { title: 'Prev', goal: 'old goal', done: ['x'], remaining: [], updates: [{ text: 'u', at: 'now' }], rev: 4, updatedAt: 'now' };
    self._claudeNotes.set('resumed', priorNote);
    self.claudeSessions.set('tab1', { nameIsUserSet: false });
    await self._pumpStickyJsonl('tab1', cwd);
    const session = self.claudeSessions.get('tab1');
    assert.strictEqual(session.stickyClaudeSessionId, 'resumed', 'binding recorded for persistence');
    assert.strictEqual(session.stickyNote.goal, 'old goal', 'resumed note shown on the card');
    const seed = self._seeds.find((s) => s.id === 'tab1');
    assert.ok(seed && seed.note && seed.note.rev === 4, 'summariser seeded with prior note + rev');
    assert.ok(self._broadcasts.some((b) => b.data.type === 'sticky_note_update' && b.data.stickyNote && b.data.stickyNote.goal === 'old goal'));
  });

  it('starts fresh (null note) when binding a brand-new claude session', async function () {
    const cwd = '/Users/x/proj';
    writeSession(cwd, 'fresh.jsonl', null, 0);
    const self = makeBindStub();
    self.claudeSessions.set('tab1', { nameIsUserSet: false, stickyNote: { goal: 'stale from other session', rev: 9 } });
    await self._pumpStickyJsonl('tab1', cwd);
    const session = self.claudeSessions.get('tab1');
    assert.strictEqual(session.stickyNote, null, 'no prior note → card cleared for the new session');
    assert.strictEqual(session.stickyClaudeSessionId, 'fresh');
  });

  it('_capClaudeNotes keeps only the most-recent notes', function () {
    const self = makeBindStub();
    self._claudeNotesCap = 2;
    self._claudeNotes.set('a', { updatedAt: '2026-06-10T00:00:00Z' });
    self._claudeNotes.set('b', { updatedAt: '2026-06-12T00:00:00Z' });
    self._claudeNotes.set('c', { updatedAt: '2026-06-11T00:00:00Z' });
    ClaudeCodeWebServer.prototype._capClaudeNotes.call(self);
    assert.strictEqual(self._claudeNotes.size, 2);
    assert.ok(self._claudeNotes.has('b') && self._claudeNotes.has('c'), 'oldest (a) evicted');
    assert.ok(!self._claudeNotes.has('a'));
  });

  it('an active tab is NOT stolen by a newer unrelated unowned session', async function () {
    const cwd = '/Users/x/proj';
    writeSession(cwd, 'sessA.jsonl', null, 50);
    const self = makeBindStub();
    self.claudeSessions.set('tab1', { nameIsUserSet: false });
    await self._pumpStickyJsonl('tab1', cwd); // binds sessA
    const b = self._stickyJsonl.get('tab1');
    assert.strictEqual(b.claudeSessionId, 'sessA');
    // A newer, unowned session appears (e.g. a foreign claude in the same project).
    writeSession(cwd, 'sessC.jsonl', null, 0);
    b._ticks = 4; b.idleTicks = 0; // force a rescan next pump; tab is still ACTIVE
    await self._pumpStickyJsonl('tab1', cwd);
    assert.strictEqual(self._stickyJsonl.get('tab1').claudeSessionId, 'sessA', 'active tab stays put');
  });

  it('an idle tab follows an in-session /resume to a newer unowned session', async function () {
    const cwd = '/Users/x/proj';
    writeSession(cwd, 'sessA.jsonl', null, 50);
    const self = makeBindStub();
    self.claudeSessions.set('tab1', { nameIsUserSet: false });
    await self._pumpStickyJsonl('tab1', cwd); // binds sessA
    writeSession(cwd, 'sessC.jsonl', null, 0); // newer session (the resumed one)
    const b = self._stickyJsonl.get('tab1');
    b._ticks = 4; b.idleTicks = 10; // sessA has gone quiet past the threshold
    await self._pumpStickyJsonl('tab1', cwd);
    assert.strictEqual(self._stickyJsonl.get('tab1').claudeSessionId, 'sessC', 'idle tab follows the resume');
  });

  it('a QUIET tab stays isolated when another tab\'s session is the ONLY one being appended', async function () {
    // The user's exact worry: two claude sessions in one project. Tab1 goes quiet
    // while Tab2's session is the only one growing — Tab1 must never read Tab2's.
    const cwd = '/Users/x/proj';
    const uA = JSON.stringify({ type: 'user', message: { role: 'user', content: 'build the login page' } }) + '\n';
    const uB = JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the db migration' } }) + '\n';
    writeSession(cwd, 'sA-login.jsonl', uA, 50);     // older
    writeSession(cwd, 'sB-migration.jsonl', uB, 10); // newer
    const self = makeBindStub();
    self.claudeSessions.set('t1', { nameIsUserSet: false });
    self.claudeSessions.set('t2', { nameIsUserSet: false });
    self._expand('t1'); self._expand('t2'); // both cards EXPANDED → both summarise
    await self._pumpStickyJsonl('t1', cwd); // t1 binds newest unowned = sB-migration
    await self._pumpStickyJsonl('t2', cwd); // t2 binds the other = sA-login
    const t1Sess = self._stickyJsonl.get('t1').claudeSessionId;
    const t2File = self._stickyJsonl.get('t2').file;
    assert.notStrictEqual(t1Sess, self._stickyJsonl.get('t2').claudeSessionId, 'distinct sessions');

    // t2's session is now the ONLY one being appended; t1's stays quiet + idle.
    const asst = (x) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: x }] } }) + '\n';
    for (let i = 0; i < 12; i++) {
      fs.appendFileSync(t2File, asst('migration constraint detail ' + i));
      const b1 = self._stickyJsonl.get('t1');
      b1._ticks = 4; b1.idleTicks = 99; // t1 quiet + forcibly eligible to "follow" — it must still NOT steal t2's owned session
      await self._pumpStickyJsonl('t1', cwd);
      await self._pumpStickyJsonl('t2', cwd);
    }
    assert.strictEqual(self._stickyJsonl.get('t1').claudeSessionId, t1Sess, 't1 binding never drifted to the active session');
    const t1Fed = self._feeds.filter((f) => f.id === 't1').map((f) => f.text).join(' \n ');
    assert.ok(!/migration constraint detail/.test(t1Fed), 't1 was NEVER fed the other tab\'s session content');
  });

  it('does NOT bind a fresh tab to a STALE pre-existing session (no stale title/note)', async function () {
    // A terminal tab opens in a project that already has an OLD claude session.
    // The tab never ran claude — it must not adopt that session's title/note.
    const cwd = '/Users/x/proj';
    writeSession(cwd, 'old-session.jsonl', null, 600); // 10 min old → stale
    const self = makeBindStub();
    self.claudeSessions.set('term', { nameIsUserSet: false });
    self._expand('term');
    await self._pumpStickyJsonl('term', cwd);
    assert.ok(!self._stickyJsonl.get('term'), 'fresh tab does not bind a stale session');
    assert.strictEqual(self.claudeSessions.get('term').autoTitle, undefined, 'no stale title applied');
    // Now the user actually runs claude → a freshly-written session appears.
    writeSession(cwd, 'new-session.jsonl', null, 0);
    await self._pumpStickyJsonl('term', cwd);
    assert.ok(self._stickyJsonl.get('term'), 'binds once a session is actively written');
    assert.strictEqual(self._stickyJsonl.get('term').claudeSessionId, 'new-session');
  });

  it('DOES re-bind a restored tab to its OWN idle session (resume), despite recency', async function () {
    // A restored tab knows its prior claude session (stickyClaudeSessionId). Even
    // if that session is idle (>60s), it must re-bind to resume — the recency gate
    // is only for adopting STRANGER sessions.
    const cwd = '/Users/x/proj';
    writeSession(cwd, 'my-session.jsonl', null, 600); // 10 min old, but it's THIS tab's
    const self = makeBindStub();
    self.claudeSessions.set('tab1', { nameIsUserSet: false, stickyClaudeSessionId: 'my-session' });
    self._expand('tab1');
    await self._pumpStickyJsonl('tab1', cwd);
    assert.ok(self._stickyJsonl.get('tab1'), 'restored tab re-binds to its own idle session');
    assert.strictEqual(self._stickyJsonl.get('tab1').claudeSessionId, 'my-session');
  });

  it('does NOT summarise a collapsed tab, but DOES tail its ai-title; expanding starts summarising', async function () {
    const cwd = '/Users/x/proj';
    const body =
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }) + '\n' +
      JSON.stringify({ type: 'ai-title', aiTitle: 'My Session Title' }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it now' }] } }) + '\n';
    writeSession(cwd, 'sess.jsonl', body, 0);
    const self = makeBindStub();
    self.claudeSessions.set('tab1', { nameIsUserSet: false });
    // Collapsed (NOT expanded): no summarisation, but the title is tailed.
    await self._pumpStickyJsonl('tab1', cwd);
    assert.strictEqual(self._feeds.length, 0, 'collapsed tab does not feed the summariser');
    assert.strictEqual(self.claudeSessions.get('tab1').autoTitle, 'My Session Title', 'ai-title tailed while collapsed (no model)');
    // Expand → note summarisation resumes from the frozen horizon.
    self._expand('tab1');
    await self._pumpStickyJsonl('tab1', cwd);
    assert.ok(self._feeds.some((f) => f.id === 'tab1'), 'expanded tab feeds the summariser');
  });
  it('_handleSetStickyActive ref-counts expanded viewers; disconnect purges without leaking', function () {
    const self = makeStub();
    self._stickyActive = new Map();
    self._isStickyExpandedActive = ClaudeCodeWebServer.prototype._isStickyExpandedActive;
    self._handleSetStickyActive = ClaudeCodeWebServer.prototype._handleSetStickyActive;
    self._clearStickyActiveForWs = ClaudeCodeWebServer.prototype._clearStickyActiveForWs;
    self.webSocketConnections = new Map([['wsA', {}], ['wsB', {}]]);
    self.claudeSessions.set('s1', { connections: new Set(['wsA', 'wsB']) });

    self._handleSetStickyActive('wsA', { sessionId: 's1', active: true });
    assert.ok(self._isStickyExpandedActive('s1'), 'active once a viewer expands');
    self._handleSetStickyActive('wsB', { sessionId: 's1', active: true });
    self._handleSetStickyActive('wsA', { sessionId: 's1', active: false });
    assert.ok(self._isStickyExpandedActive('s1'), 'still active while another viewer is expanded');
    self._clearStickyActiveForWs('wsB'); // wsB disconnects
    assert.ok(!self._isStickyExpandedActive('s1'), 'inactive once the last viewer is gone — no leak');

    // A socket not belonging to the session cannot activate it.
    self._handleSetStickyActive('wsZ', { sessionId: 's1', active: true });
    assert.ok(!self._isStickyExpandedActive('s1'), 'foreign socket cannot mark active');
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

  it('persists and restores stickyClaudeSessionId (cross-restart resume key)', async function () {
    const store = new SessionStore({ storageDir: dir });
    const sessions = new Map();
    sessions.set('s1', {
      name: 'T', workingDir: '/tmp',
      stickyNote: { goal: 'g', done: [], remaining: [], updates: [], rev: 1, updatedAt: 'now' },
      stickyClaudeSessionId: '4c71fe78-3191',
    });
    store.markDirty();
    await store.saveSessions(sessions);
    const loaded = await store.loadSessions();
    assert.strictEqual(loaded.get('s1').stickyClaudeSessionId, '4c71fe78-3191');
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
