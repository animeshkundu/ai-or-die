'use strict';

// F14 — turn detection must fire for a HEADLESS control-spawned claude (no
// WebSocket viewer ever expands the sticky-note card). Before the fix, turn_ended
// + lastGrowing/lastEndsOnAssistant were computed only inside the
// _isStickyExpandedActive gate, so a fleet session's await_turn never unblocked.
// We drive the real _pumpStickyJsonl on the prototype against a real temp
// transcript, with the card reported as collapsed, and assert that turn detection
// runs anyway while the (expensive) note summariser stays gated.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../../src/server');

const proto = ClaudeCodeWebServer.prototype;

function userLine(text) {
  return JSON.stringify({ type: 'user', message: { content: text } }) + '\n';
}
function assistantLine(text) {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';
}

function makeFake(file, sessionId, { expanded }) {
  const events = [];
  const feeds = [];
  const session = { id: sessionId, active: true, agent: 'claude', _sidecarSeen: true };
  const binding = {
    file,
    offset: 0,
    titleOffset: 0,
    lastTitle: null,
    claudeSessionId: 'claude-sess-1',
    boundMtimeMs: 0,
    idleTicks: 0,
    _ticks: 0,
  };
  const fake = {
    _stickyJsonl: new Map([[sessionId, binding]]),
    claudeSessions: new Map([[sessionId, session]]),
    _claudeOffsets: new Map(),
    controlEventBus: null,
    stickyNoteSummarizer: { feedTurns: (id, text, title) => feeds.push({ id, text, title }) },
    _readClaudeBindSidecar: async () => null, // _sidecarSeen=true → keep binding, skip inference
    _statQuiet: async (f) => {
      try { const st = fs.statSync(f); return { size: st.size, mtimeMs: st.mtimeMs }; }
      catch { return null; }
    },
    _isStickyExpandedActive: () => !!expanded,
    _controlAppendStateEvent: (id, kind) => events.push({ id, kind }),
    _controlEmitInteractionTransition: async () => {},
    _applyAiTitle: () => {},
  };
  return { fake, binding, events, feeds, session };
}

describe('F14 headless turn detection (un-gated from UI expand)', function () {
  let dir;
  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f14-'));
  });
  afterEach(function () {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  it('emits turn_ended for a COLLAPSED (headless) session and does NOT summarise', async function () {
    const file = path.join(dir, 'transcript.jsonl');
    const sessionId = 's-headless';
    // Mid-turn: only a user prompt so far.
    fs.writeFileSync(file, userLine('hello claude'));
    const { fake, binding, events, feeds } = makeFake(file, sessionId, { expanded: false });

    // Tick 1: turnOffset initialises to current EOF ("from now"); nothing settled yet.
    await proto._pumpStickyJsonl.call(fake, sessionId, dir);
    assert.equal(events.filter((e) => e.kind === 'turn_ended').length, 0, 'no turn_ended before assistant completes');
    assert.ok(!binding.lastEndsOnAssistant, 'no completed assistant turn yet');

    // Assistant completes the turn.
    fs.appendFileSync(file, assistantLine('hi, how can I help?'));

    // Tick 2: a new settled assistant turn appears AFTER turnOffset → turn_ended.
    await proto._pumpStickyJsonl.call(fake, sessionId, dir);
    assert.equal(events.filter((e) => e.kind === 'turn_ended').length, 1, 'turn_ended fires headless');
    assert.equal(binding.lastEndsOnAssistant, true, 'lastEndsOnAssistant updated headless');
    assert.equal(binding.lastGrowing, false, 'settled turn is not growing');

    // The note summariser (the expensive model path) stays gated while collapsed.
    assert.equal(feeds.length, 0, 'feedTurns NOT called while collapsed');
    // Note horizon (binding.offset) is frozen; only the independent turnOffset advanced.
    assert.equal(binding.offset, 0, 'note offset frozen while collapsed');
    assert.ok(binding.turnOffset > 0, 'turnOffset advanced independently');
  });

  it('marks lastGrowing=true headless while an assistant turn is still streaming', async function () {
    const file = path.join(dir, 'transcript.jsonl');
    const sessionId = 's-busy';
    fs.writeFileSync(file, userLine('do a thing'));
    const { fake, binding, events } = makeFake(file, sessionId, { expanded: false });
    await proto._pumpStickyJsonl.call(fake, sessionId, dir); // turnOffset := EOF

    // A user line then an assistant line, but the LAST turn is the user (next user
    // prompt arrived) → not ending on assistant → growing/busy.
    fs.appendFileSync(file, assistantLine('working...'));
    fs.appendFileSync(file, userLine('and another'));
    await proto._pumpStickyJsonl.call(fake, sessionId, dir);
    assert.equal(binding.lastGrowing, true, 'ends on a user turn → growing/busy');
    assert.equal(binding.lastEndsOnAssistant, false);
    assert.equal(events.filter((e) => e.kind === 'turn_ended').length, 0, 'no turn_ended while busy');
  });

  it('still summarises when EXPANDED (regression: note path intact)', async function () {
    const file = path.join(dir, 'transcript.jsonl');
    const sessionId = 's-expanded';
    fs.writeFileSync(file, userLine('hello'));
    const { fake, feeds } = makeFake(file, sessionId, { expanded: true });
    // Expanded reads from binding.offset (0) → sees the content → feeds the summariser.
    await proto._pumpStickyJsonl.call(fake, sessionId, dir);
    assert.ok(feeds.length >= 1, 'feedTurns called when expanded');
  });

  it('emits became_busy / became_idle headless as derived interaction state flips', async function () {
    // _controlEmitInteractionTransition is NOT expand-gated; F14 keeps its inputs
    // (lastGrowing/lastEndsOnAssistant) fresh headless, so transitions fire.
    const sessionId = 's-trans';
    const events = [];
    const seq = ['busy', 'busy', 'idle']; let i = 0;
    const srv = {
      _stickyJsonl: new Map([[sessionId, {}]]),
      _controlDerivedStatus: async () => ({ interactionState: seq[Math.min(i++, seq.length - 1)] }),
      _controlEventKindForInteractionState: proto._controlEventKindForInteractionState,
      _controlAppendStateEvent: (id, kind) => events.push(kind),
    };
    await proto._controlEmitInteractionTransition.call(srv, sessionId); // busy → became_busy
    await proto._controlEmitInteractionTransition.call(srv, sessionId); // busy (same) → no event
    await proto._controlEmitInteractionTransition.call(srv, sessionId); // idle → became_idle
    assert.deepEqual(events, ['became_busy', 'became_idle']);
  });

  it('PROMOTE: emits turn_ended for the FIRST turn after a pending bind promotes (turnOffset from 0)', async function () {
    const sessionId = 's-promote';
    const tp = path.join(dir, 'proj', 'late.jsonl');
    const events = [];
    const session = { id: sessionId, active: true, agent: 'claude', _sidecarSeen: false, claudeBindSidecar: 'sc' };
    const fake = {
      _stickyJsonl: new Map(),
      claudeSessions: new Map([[sessionId, session]]),
      _claudeOffsets: new Map(),
      _claudeNotes: new Map(),
      controlEventBus: null,
      sessionStore: { markDirty: () => {} },
      stickyNoteSummarizer: { feedTurns: () => {}, onRebind: () => {} },
      broadcastToSession: () => {},
      _ownedClaudeSessions: proto._ownedClaudeSessions,
      _bindStickyJsonl: proto._bindStickyJsonl,
      _readClaudeBindSidecar: async () => ({ claudeSessionId: 'cs-1', transcriptPath: tp, event: 'start' }),
      _statQuiet: async (f) => { try { const st = fs.statSync(f); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; } },
      _isStickyExpandedActive: () => false,
      _controlAppendStateEvent: (id, kind) => events.push({ id, kind }),
      _controlEmitInteractionTransition: async () => {},
      _applyAiTitle: () => {},
    };
    // Tick 1: transcript absent → pending identity bind; no turn events.
    await proto._pumpStickyJsonl.call(fake, sessionId, dir);
    const b1 = fake._stickyJsonl.get(sessionId);
    assert.ok(b1 && b1.transcriptPending === true, 'pending after tick 1');
    assert.equal(events.length, 0, 'no turn events while pending');
    // The first turn completes and the transcript appears ALL AT ONCE (a fast turn
    // landing within one poll interval). Promotion must tail from byte 0 so this
    // already-complete first turn still emits turn_ended (not skipped "from now").
    fs.mkdirSync(path.dirname(tp), { recursive: true });
    fs.writeFileSync(tp, userLine('do it') + assistantLine('done'));
    await proto._pumpStickyJsonl.call(fake, sessionId, dir);
    const b2 = fake._stickyJsonl.get(sessionId);
    assert.equal(b2.transcriptPending, false, 'promoted to a full tail');
    assert.equal(b2.file, tp);
    assert.equal(events.filter((e) => e.kind === 'turn_ended').length, 1, 'first turn emits turn_ended (turnOffset started at 0)');
  });

  it('PROMOTE: a >24KB first turn promotes with offset 0 (tails the whole new file, not a 24KB window)', async function () {
    const sessionId = 's-bigturn';
    const tp = path.join(dir, 'big', 'late.jsonl');
    const events = [];
    const session = { id: sessionId, active: true, agent: 'claude', _sidecarSeen: false, claudeBindSidecar: 'sc' };
    const fake = {
      _stickyJsonl: new Map(),
      claudeSessions: new Map([[sessionId, session]]),
      _claudeOffsets: new Map(),
      _claudeNotes: new Map(),
      controlEventBus: null,
      sessionStore: { markDirty: () => {} },
      stickyNoteSummarizer: { feedTurns: () => {}, onRebind: () => {} },
      broadcastToSession: () => {},
      _ownedClaudeSessions: proto._ownedClaudeSessions,
      _bindStickyJsonl: proto._bindStickyJsonl,
      _readClaudeBindSidecar: async () => ({ claudeSessionId: 'cs-big', transcriptPath: tp, event: 'start' }),
      _statQuiet: async (f) => { try { const st = fs.statSync(f); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; } },
      _isStickyExpandedActive: () => false,
      _controlAppendStateEvent: (id, kind) => events.push({ id, kind }),
      _controlEmitInteractionTransition: async () => {},
      _applyAiTitle: () => {},
    };
    await proto._pumpStickyJsonl.call(fake, sessionId, dir); // tick 1 → pending
    // First turn is large (> the 24KB INITIAL_WINDOW) and lands all at once.
    fs.mkdirSync(path.dirname(tp), { recursive: true });
    fs.writeFileSync(tp, userLine('do it') + assistantLine('x'.repeat(30000)));
    await proto._pumpStickyJsonl.call(fake, sessionId, dir); // tick 2 → promote
    const b = fake._stickyJsonl.get(sessionId);
    assert.equal(b.transcriptPending, false, 'promoted');
    assert.equal(b.offset, 0, 'note offset starts at 0 for a brand-new transcript (not size-24KB)');
    assert.equal(events.filter((e) => e.kind === 'turn_ended').length, 1, 'the large first turn still emits turn_ended');
  });
});
