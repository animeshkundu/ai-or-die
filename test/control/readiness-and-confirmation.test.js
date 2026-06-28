'use strict';

// F1/F17/F18 — readiness barrier + message-targeted confirmation, exercised on the
// real prototype methods with hand-built fakes (no live PTY), mirroring the
// steering-helpers test style.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../../src/server');

const proto = ClaudeCodeWebServer.prototype;
const norm = (s) => proto._controlNormalizeForMatch.call(proto, s);
const matches = (want, got) => proto._controlUserEntryMatches.call(proto, want, got);
const turnClass = (id, session) => proto._controlIsTurnAgent.call({ _stickyJsonl: session._map || new Map() }, id, session);

function userLine(text) {
  return JSON.stringify({ type: 'user', message: { content: text } }) + '\n';
}
function assistantLine(text) {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';
}

describe('F1 _controlIsTurnAgent (three-way)', function () {
  it('non-claude agent → terminal', function () {
    assert.equal(turnClass('s', { agent: 'terminal' }), 'terminal');
    assert.equal(turnClass('s', { agent: 'codex' }), 'terminal');
  });
  it('claude with no binding → unbound; with binding → bound', function () {
    assert.equal(turnClass('s', { agent: 'claude', _map: new Map() }), 'unbound');
    assert.equal(turnClass('s', { agent: 'claude', _map: new Map([['s', {}]]) }), 'bound');
  });
});

describe('F18 message↔transcript match helpers', function () {
  it('normalises whitespace + case + clips', function () {
    assert.equal(norm('  Hello\n  World  '), 'hello world');
    assert.equal(norm(null), '');
    assert.equal(norm('x'.repeat(100)).length, 64);
  });
  it('matches by prefix containment in either direction (tolerates clipping)', function () {
    assert.equal(matches('hello world', 'Hello World, how are you'), true); // got starts with want
    assert.equal(matches('the quick brown fox', 'the quick'), true);        // want starts with got
    assert.equal(matches('run the tests', 'please run the tests now'), true); // contains
    assert.equal(matches('hello', 'completely different'), false);
    assert.equal(matches('', 'anything'), false);
  });
});

describe('F18 _controlAwaitSubmission', function () {
  let dir;
  beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f18-')); });
  afterEach(function () { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  const srv = { _controlNormalizeForMatch: proto._controlNormalizeForMatch, _controlUserEntryMatches: proto._controlUserEntryMatches };
  const await_ = (binding, pre, text, ms) => proto._controlAwaitSubmission.call(srv, binding, pre, text, ms);

  it('returns true once a matching new user entry appears after preSize', async function () {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, assistantLine('earlier reply'));
    const preSize = fs.statSync(file).size;
    fs.appendFileSync(file, userLine('please refactor the parser'));
    assert.equal(await await_({ file }, preSize, 'please refactor the parser', 1000), true);
  });

  it('returns false when no matching entry appears (timeout)', async function () {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, assistantLine('earlier reply'));
    const preSize = fs.statSync(file).size;
    fs.appendFileSync(file, userLine('a totally unrelated thing'));
    assert.equal(await await_({ file }, preSize, 'please refactor the parser', 400), false);
  });

  it('empty message is treated as submitted', async function () {
    assert.equal(await await_({ file: path.join(dir, 'none.jsonl') }, 0, '', 200), true);
  });
});

describe('F1 _controlSendMessage terminal honest delivery', function () {
  function fakeTerminal() {
    const inputs = [];
    return {
      inputs,
      claudeSessions: new Map([['t1', { id: 't1', active: true, agent: 'terminal' }]]),
      _stickyJsonl: new Map(),
      _controlWithIdempotency: (id, key, fn) => fn(),
      _controlSteeringLock: proto._controlSteeringLock,
      _controlInputBridge: () => ({ sendInput: async (id, data) => { inputs.push(data); } }),
      _controlClampInt: proto._controlClampInt,
      _controlIsTurnAgent: proto._controlIsTurnAgent,
      _controlDerivedStatus: async () => ({ interactionState: 'idle' }),
      _statQuiet: async () => ({ size: 0 }),
      _controlSessionSeqFor: () => 0,
      controlEventBus: null,
    };
  }
  const send = (srv, opts) => proto._controlSendMessage.call(srv, opts);

  it('no false negative: confirmed:true, confirmation:delivered, no reaper Enter', async function () {
    this.timeout(4000);
    const srv = fakeTerminal();
    const out = await send(srv, { sessionId: 't1', message: 'ls -la', awaitMs: 1000 });
    assert.deepEqual(srv.inputs, ['ls -la', '\r']); // no extra reaped \r for a shell
    assert.equal(out.confirmed, true);
    assert.equal(out.confirmation, 'delivered');
    assert.equal(out.submission.status, 'not_applicable');
    assert.equal(out.turn.status, 'not_applicable');
    assert.equal(out.confidence, 'low');
  });
});

describe('F18 _controlSendMessage bound claude proves the specific message ran', function () {
  let dir;
  beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f18s-')); });
  afterEach(function () { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it('submission matched + turn_ended → confirmed with structured statuses', async function () {
    this.timeout(5000);
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, assistantLine('prior turn'));
    const inputs = [];
    const binding = { file };
    const srv = {
      inputs,
      claudeSessions: new Map([['c1', { id: 'c1', active: true, agent: 'claude' }]]),
      _stickyJsonl: new Map([['c1', binding]]),
      _controlWithIdempotency: (id, key, fn) => fn(),
      _controlSteeringLock: proto._controlSteeringLock,
      // The bridge "delivers" the message: appends a matching user entry AND a
      // settled assistant reply to the transcript (a fast completed turn), as a
      // real claude composer + model would.
      _controlInputBridge: () => ({ sendInput: async (id, data) => {
        inputs.push(data);
        if (data === 'fix the flaky test') {
          fs.appendFileSync(file, userLine('fix the flaky test'));
          fs.appendFileSync(file, assistantLine('done — fixed the flake'));
        }
      } }),
      _controlClampInt: proto._controlClampInt,
      _controlIsTurnAgent: proto._controlIsTurnAgent,
      _controlNormalizeForMatch: proto._controlNormalizeForMatch,
      _controlUserEntryMatches: proto._controlUserEntryMatches,
      _controlAwaitSubmission: proto._controlAwaitSubmission,
      _controlAwaitTurnComplete: proto._controlAwaitTurnComplete,
      _statQuiet: async (f) => { const st = fs.statSync(f); return { size: st.size, mtimeMs: st.mtimeMs }; },
      _controlDerivedStatus: async () => ({ interactionState: 'idle', awaiting: { kind: 'next_message' } }),
      _controlSessionSeqFor: () => 1,
      controlEventBus: null,
    };
    const out = await proto._controlSendMessage.call(srv, { sessionId: 'c1', message: 'fix the flaky test', awaitMs: 2000 });
    assert.equal(out.submission.status, 'submitted', 'matched the new user entry');
    assert.equal(out.turn.status, 'completed');
    assert.equal(out.confirmed, true);
    assert.equal(out.confirmation, 'turn_completed');
    assert.equal(out.confidence, 'high');
  });

  it('submitted but turn awaits a permission prompt → not confirmed, confirmationTimedOut', async function () {
    this.timeout(5000);
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, assistantLine('prior turn'));
    const binding = { file };
    const toolUseLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tu1' }] } }) + '\n';
    const srv = {
      claudeSessions: new Map([['c3', { id: 'c3', active: true, agent: 'claude' }]]),
      _stickyJsonl: new Map([['c3', binding]]),
      _controlWithIdempotency: (id, key, fn) => fn(),
      _controlSteeringLock: proto._controlSteeringLock,
      _controlInputBridge: () => ({ sendInput: async (id, data) => {
        if (data === 'run a command') { fs.appendFileSync(file, userLine('run a command')); fs.appendFileSync(file, toolUseLine); }
      } }),
      _controlClampInt: proto._controlClampInt,
      _controlIsTurnAgent: proto._controlIsTurnAgent,
      _controlNormalizeForMatch: proto._controlNormalizeForMatch,
      _controlUserEntryMatches: proto._controlUserEntryMatches,
      _controlAwaitSubmission: proto._controlAwaitSubmission,
      _controlAwaitTurnComplete: proto._controlAwaitTurnComplete,
      _statQuiet: async (f) => { const st = fs.statSync(f); return { size: st.size, mtimeMs: st.mtimeMs }; },
      _controlDerivedStatus: async () => ({ interactionState: 'waiting_input', awaiting: { kind: 'tool_approval' } }),
      _controlSessionSeqFor: () => 1,
      controlEventBus: null,
    };
    const out = await proto._controlSendMessage.call(srv, { sessionId: 'c3', message: 'run a command', awaitMs: 800 });
    assert.equal(out.submission.status, 'submitted');
    assert.equal(out.turn.status, 'pending');
    assert.equal(out.confirmed, false);
    assert.equal(out.confirmationTimedOut, true);
    assert.deepEqual(out.turn.awaiting, { kind: 'tool_approval' });
  });

  it('unbound claude (no binding) never claims a confirmed turn', async function () {
    this.timeout(6000);
    const inputs = [];
    const srv = {
      inputs,
      claudeSessions: new Map([['c2', { id: 'c2', active: true, agent: 'claude' }]]),
      _stickyJsonl: new Map(), // not bound
      _controlWithIdempotency: (id, key, fn) => fn(),
      _controlSteeringLock: proto._controlSteeringLock,
      _controlInputBridge: () => ({ sendInput: async (id, data) => { inputs.push(data); } }),
      _controlClampInt: proto._controlClampInt,
      _controlIsTurnAgent: proto._controlIsTurnAgent,
      _controlDerivedStatus: async () => ({ interactionState: 'idle' }), // never starts → reaper
      _controlAwaitActivityEdge: proto._controlAwaitActivityEdge,
      _controlSessionSeqFor: () => 0,
      controlEventBus: null,
    };
    const out = await proto._controlSendMessage.call(srv, { sessionId: 'c2', message: 'hello', awaitMs: 1000 });
    assert.equal(out.confirmed, false);
    assert.equal(out.confirmation, 'no_turn_binding');
    assert.equal(out.submission.status, 'no_turn_binding');
    assert.deepEqual(inputs, ['hello', '\r', '\r']); // cold-boot reaper still re-sends Enter once
  });
});

describe('F17 readiness barrier', function () {
  function fakeServer({ agent, bound, hadOutput, screen }) {
    return {
      claudeSessions: new Map([['s', {
        id: 's', active: true, agent,
        outputBuffer: { size: hadOutput ? 3 : 0 },
        _ctlTranscript: screen != null ? { snapshot: async () => screen } : null,
      }]]),
      _stickyJsonl: bound ? new Map([['s', { file: 'x' }]]) : new Map(),
      _controlReadinessState: proto._controlReadinessState,
    };
  }
  const state = (srv) => proto._controlReadinessState.call(srv, 's');

  it('claude not yet bound → ready:false, blocker binding_pending', async function () {
    const out = await state(fakeServer({ agent: 'claude', bound: false, hadOutput: true }));
    assert.equal(out.ready, false);
    assert.equal(out.bound, false);
    assert.equal(out.blocker.kind, 'binding_pending');
  });

  it('claude bound + output → ready:true, bound:true', async function () {
    const out = await state(fakeServer({ agent: 'claude', bound: true, hadOutput: true }));
    assert.deepEqual({ ready: out.ready, bound: out.bound }, { ready: true, bound: true });
  });

  it('trust modal on screen → blocker trust (not ready even if bound)', async function () {
    const out = await state(fakeServer({ agent: 'claude', bound: true, hadOutput: true, screen: 'Do you trust the files in this folder?\n 1. Yes  2. No' }));
    assert.equal(out.ready, false);
    assert.equal(out.blocker.kind, 'trust');
  });

  it('terminal agent ready once active with output (no binding needed)', async function () {
    const out = await state(fakeServer({ agent: 'terminal', bound: false, hadOutput: true }));
    assert.deepEqual({ ready: out.ready, bound: out.bound }, { ready: true, bound: false });
  });

  it('_controlAwaitReady resolves once the binding attaches mid-wait', async function () {
    this.timeout(3000);
    const srv = fakeServer({ agent: 'claude', bound: false, hadOutput: true });
    setTimeout(() => srv._stickyJsonl.set('s', { file: 'x' }), 400); // binding attaches late
    const out = await proto._controlAwaitReady.call(srv, 's', 2000);
    assert.equal(out.ready, true);
    assert.equal(out.bound, true);
  });
});
