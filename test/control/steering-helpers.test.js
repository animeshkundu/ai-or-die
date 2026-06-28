'use strict';

// Unit tests for the real PTY-facing steering helpers on ClaudeCodeWebServer.
// The /api/control route tests inject fake deps, so the actual key-translation
// and response-mapping logic (the bug-prone, harness-specific parts) would
// otherwise be uncovered. We exercise them directly on the prototype.

const assert = require('assert');
const { ClaudeCodeWebServer } = require('../../src/server');

const proto = ClaudeCodeWebServer.prototype;
const keyBytes = (keys, raw) => proto._controlKeyBytes.call(proto, keys, raw);
const mapResp = (kind, opts) => proto._controlMapResponseKeys.call(proto, kind, opts);

describe('control steering helpers', function () {
  describe('_controlKeyBytes', function () {
    it('translates named keys to control bytes', function () {
      assert.equal(keyBytes('Enter', false), '\r');
      assert.equal(keyBytes('Escape', false), '\x1b');
      assert.equal(keyBytes('Esc', false), '\x1b');
      assert.equal(keyBytes('Tab', false), '\t');
      assert.equal(keyBytes('C-c', false), '\x03');
      assert.equal(keyBytes('Ctrl-C', false), '\x03');
      assert.equal(keyBytes('Up', false), '\x1b[A');
      assert.equal(keyBytes('Down', false), '\x1b[B');
      assert.equal(keyBytes('Right', false), '\x1b[C');
      assert.equal(keyBytes('Left', false), '\x1b[D');
      assert.equal(keyBytes('Backspace', false), '\x7f');
    });

    it('is case-insensitive on named keys', function () {
      assert.equal(keyBytes('enter', false), '\r');
      assert.equal(keyBytes('ESCAPE', false), '\x1b');
    });

    it('passes through unknown names verbatim', function () {
      assert.equal(keyBytes('y', false), 'y');
      assert.equal(keyBytes('hello', false), 'hello');
    });

    it('raw mode sends bytes verbatim (no name translation)', function () {
      assert.equal(keyBytes('Enter', true), 'Enter');
      assert.equal(keyBytes('\x1b[A', true), '\x1b[A');
    });

    it('joins an array of keys', function () {
      assert.equal(keyBytes(['C-c', 'Enter'], false), '\x03\r');
    });

    it('F3: maps Shift+Tab to CSI Z (back-tab) — claude permission-mode cycle', function () {
      assert.equal(keyBytes('Shift-Tab', false), '\x1b[Z');
      assert.equal(keyBytes('shift-tab', false), '\x1b[Z'); // case-insensitive
      assert.equal(keyBytes('SHIFT-TAB', false), '\x1b[Z');
      assert.equal(keyBytes('S-Tab', false), '\x1b[Z');      // alias
    });

    it('F3: maps the other added navigation/editing keys', function () {
      assert.equal(keyBytes('Home', false), '\x1b[H');
      assert.equal(keyBytes('End', false), '\x1b[F');
      assert.equal(keyBytes('PageUp', false), '\x1b[5~');
      assert.equal(keyBytes('PageDown', false), '\x1b[6~');
      assert.equal(keyBytes('Delete', false), '\x1b[3~');
    });

    it('F3: Shift+Tab still passes through verbatim in raw mode', function () {
      assert.equal(keyBytes('Shift-Tab', true), 'Shift-Tab');
      assert.equal(keyBytes('\x1b[Z', true), '\x1b[Z');
    });

    it('F3: array join includes Shift+Tab translation', function () {
      assert.equal(keyBytes(['Shift-Tab', 'Shift-Tab'], false), '\x1b[Z\x1b[Z');
    });
  });

  describe('_controlMapResponseKeys (best-effort; B3 calibrates live)', function () {
    it('plan_approval: accept → Enter, reject → Esc (numbered modal)', function () {
      assert.equal(mapResp('plan_approval', { choice: 'accept' }), '\r');
      assert.equal(mapResp('plan_approval', { choice: 'yes' }), '\r');
      assert.equal(mapResp('plan_approval', { choice: 'reject' }), '\x1b');
      assert.equal(mapResp('plan_approval', { choice: 'no' }), '\x1b');
    });

    it('tool_approval: accept → Enter, deny → Esc (numbered modal)', function () {
      assert.equal(mapResp('tool_approval', { choice: 'allow' }), '\r');
      assert.equal(mapResp('tool_approval', { choice: 'accept' }), '\r');
      assert.equal(mapResp('tool_approval', { choice: 'deny' }), '\x1b');
    });

    it('choice_question: optionValue is sent + Enter', function () {
      assert.equal(mapResp('choice_question', { optionValue: '2' }), '2\r');
    });

    it('trust_prompt: accept → explicit "1\\r" (not bare Enter), reject → "2\\r"', function () {
      assert.equal(mapResp('trust_prompt', { choice: 'accept' }), '1\r');
      assert.equal(mapResp('trust_prompt', { choice: 'yes' }), '1\r');
      assert.equal(mapResp('trust_prompt', { choice: 'trust' }), '1\r');
      assert.equal(mapResp('trust_prompt', { choice: 'reject' }), '2\r');
      assert.equal(mapResp('trust_prompt', { choice: 'no' }), '2\r');
      assert.equal(mapResp('trust_prompt', { choice: 'maybe' }), null);
    });

    it('unmappable choice returns null (caller surfaces an error / uses keys override)', function () {
      assert.equal(mapResp('plan_approval', { choice: 'maybe' }), null);
    });
  });

  describe('_controlSendMessage cold-boot submit reaper', function () {
    function fakeServer(statusSequence) {
      const inputs = [];
      let pollIdx = 0;
      return {
        inputs,
        claudeSessions: new Map([['s1', { id: 's1', active: true, agent: 'claude' }]]),
        _controlWithIdempotency: (id, key, fn) => fn(),
        _controlSteeringLock: proto._controlSteeringLock,
        _controlInputBridge: () => ({ sendInput: async (id, data) => { inputs.push(data); } }),
        _controlClampInt: proto._controlClampInt,
        _controlIsTurnAgent: proto._controlIsTurnAgent,
        _controlDerivedStatus: async () => statusSequence[Math.min(pollIdx++, statusSequence.length - 1)],
        _controlAwaitActivityEdge: proto._controlAwaitActivityEdge,
        _stickyJsonl: new Map(),
        _controlSessionSeqFor: () => 0,
        controlEventBus: null, // no cursor → falls back to the status-poll reaper gate
      };
    }
    const send = (srv, opts) => proto._controlSendMessage.call(srv, opts);

    it('re-sends Enter ONCE when claude never starts (dropped submit)', async function () {
      this.timeout(6000);
      const srv = fakeServer([{ interactionState: 'idle' }]); // stays idle → submit was dropped
      await send(srv, { sessionId: 's1', message: 'hello', awaitMs: 1000 });
      assert.deepEqual(srv.inputs, ['hello', '\r', '\r']); // text, submit, reaped Enter
    });

    it('does NOT re-send when claude starts (turn began)', async function () {
      this.timeout(6000);
      const srv = fakeServer([{ interactionState: 'busy' }]); // started → no reap
      await send(srv, { sessionId: 's1', message: 'hello', awaitMs: 1000 });
      assert.deepEqual(srv.inputs, ['hello', '\r']);
    });

    it('does NOT reap on fire-and-forget dispatch (awaitMs=0)', async function () {
      const srv = fakeServer([{ interactionState: 'idle' }]);
      await send(srv, { sessionId: 's1', message: 'hello', awaitMs: 0 });
      assert.deepEqual(srv.inputs, ['hello', '\r']); // no reaper poll, instant dispatch
    });

    it('multiline message uses bracketed paste, then the reaper still applies', async function () {
      this.timeout(6000);
      const srv = fakeServer([{ interactionState: 'idle' }]);
      await send(srv, { sessionId: 's1', message: 'a\nb', awaitMs: 1000 });
      assert.deepEqual(srv.inputs, ['\x1b[200~a\nb\x1b[201~', '\r', '\r']);
    });
  });

  describe('F13 — unbound reaper gates on a NEW activity edge (event bus)', function () {
    const { ControlEventBus } = require('../../src/control/event-bus');

    function fakeServerBus({ emitOnSend = false, preBusy = false } = {}) {
      const inputs = [];
      const bus = new ControlEventBus();
      const srv = {
        inputs,
        controlEventBus: bus,
        claudeSessions: new Map([['s1', { id: 's1', active: true, agent: 'claude' }]]),
        _stickyJsonl: new Map(), // unbound (no JSONL binding)
        _controlWithIdempotency: (id, key, fn) => fn(),
        _controlSteeringLock: proto._controlSteeringLock,
        _controlInputBridge: () => ({
          sendInput: async (id, data) => {
            inputs.push(data);
            // Simulate claude producing output (PTY recency → became_busy) on submit.
            if (emitOnSend && data === '\r') bus.append('s1', 'became_busy', { interactionState: 'busy' });
          },
        }),
        _controlClampInt: proto._controlClampInt,
        _controlIsTurnAgent: proto._controlIsTurnAgent,
        // Only consulted on the no-bus fallback; the bus path ignores it.
        _controlDerivedStatus: async () => ({ interactionState: 'idle' }),
        _controlAwaitActivityEdge: proto._controlAwaitActivityEdge,
        _controlSessionSeqFor: () => 0,
      };
      // A lingering PRIOR turn's busy edge, emitted BEFORE the send captures its
      // cursor → must NOT be counted as confirmation of this message.
      if (preBusy) bus.append('s1', 'became_busy', { interactionState: 'busy' });
      return srv;
    }
    const send = (srv, opts) => proto._controlSendMessage.call(srv, opts);

    it('re-sends Enter when only a lingering prior busy exists (no NEW edge)', async function () {
      this.timeout(6000);
      const srv = fakeServerBus({ preBusy: true, emitOnSend: false });
      await send(srv, { sessionId: 's1', message: 'hello', awaitMs: 1000 });
      assert.deepEqual(srv.inputs, ['hello', '\r', '\r']); // dropped Enter reaped
    });

    it('does NOT re-send when a NEW became_busy edge appears after the send', async function () {
      this.timeout(6000);
      const srv = fakeServerBus({ emitOnSend: true });
      await send(srv, { sessionId: 's1', message: 'hello', awaitMs: 1000 });
      assert.deepEqual(srv.inputs, ['hello', '\r']); // fresh edge → no reap
    });
  });

  describe('F12 — coarse PTY-activity edges for unbound sessions', function () {
    const { ControlEventBus } = require('../../src/control/event-bus');

    function fakeServer(statusGetter, { bound = false } = {}) {
      const bus = new ControlEventBus();
      return {
        controlEventBus: bus,
        claudeSessions: new Map([['s1', { id: 's1', active: true, agent: bound ? 'claude' : 'terminal' }]]),
        _stickyJsonl: bound ? new Map([['s1', {}]]) : new Map(),
        _controlDerivedStatus: async () => statusGetter(),
        _controlEmitInteractionTransition: proto._controlEmitInteractionTransition,
        _controlEventKindForInteractionState: proto._controlEventKindForInteractionState,
        _controlAppendStateEvent: proto._controlAppendStateEvent,
        _controlBumpSessionSeq: proto._controlBumpSessionSeq,
        _controlSessionSeqFor: proto._controlSessionSeqFor,
      };
    }
    const emit = (srv) => proto._controlEmitInteractionTransition.call(srv, 's1');

    it('emits became_busy then became_idle across a PTY activity→quiet edge (debounced)', async function () {
      let state = 'busy';
      const srv = fakeServer(() => ({ interactionState: state, confidence: 'low' }));
      await emit(srv);             // rising edge → became_busy
      await emit(srv);             // unchanged → debounced, no duplicate
      state = 'idle';
      await emit(srv);             // falling edge → became_idle
      const kinds = srv.controlEventBus.listEvents().map((e) => e.kind);
      assert.deepEqual(kinds, ['became_busy', 'became_idle']);
    });

    it('never emits turn_ended from the coarse unbound signal', async function () {
      const srv = fakeServer(() => ({ interactionState: 'idle', confidence: 'low' }));
      await emit(srv);
      const kinds = srv.controlEventBus.listEvents().map((e) => e.kind);
      assert.ok(!kinds.includes('turn_ended'));
      assert.deepEqual(kinds, ['became_idle']);
    });

    it('_controlRecordPtyOutput records recency but skips the coarse path for bound sessions', function () {
      const bus = new ControlEventBus();
      const session = { id: 's1', active: true, agent: 'claude' };
      const srv = {
        controlEventBus: bus,
        claudeSessions: new Map([['s1', session]]),
        _stickyJsonl: new Map([['s1', {}]]), // BOUND → JSONL turn detector is authoritative
        _controlEmitInteractionTransition: () => { throw new Error('bound sessions must not use the coarse edge path'); },
      };
      proto._controlRecordPtyOutput.call(srv, 's1');
      assert.equal(typeof session._ctlLastOutputAt, 'number'); // recency still recorded
      assert.ok(!session._ctlIdleTimer);                       // no coarse idle-debounce timer
      assert.equal(bus.listEvents().length, 0);                       // no coarse edge emitted
    });

    it('_controlRecordPtyOutput skips the rising-edge re-derive while already busy (no per-chunk flood)', function () {
      const bus = new ControlEventBus();
      const session = { id: 's1', active: true, agent: 'terminal', _lastInteractionState: 'busy' };
      let emitCalls = 0;
      const srv = {
        controlEventBus: bus,
        claudeSessions: new Map([['s1', session]]),
        _stickyJsonl: new Map(), // unbound
        _controlEmitInteractionTransition: () => { emitCalls++; return Promise.resolve(); },
      };
      proto._controlRecordPtyOutput.call(srv, 's1');
      assert.equal(emitCalls, 0);                              // already busy → no expensive re-derive
      assert.equal(typeof session._ctlLastOutputAt, 'number'); // recency still refreshed
      assert.ok(session._ctlIdleTimer);                        // idle timer still re-armed
      clearTimeout(session._ctlIdleTimer);
    });
  });

  describe('F16 — per-session steering mutex (_controlSteeringLock)', function () {
    it('serialises ops per session in submission order; a failure never wedges the queue', async function () {
      const srv = {};
      const log = [];
      const op = (label, ms, fail) => () => new Promise((resolve, reject) => {
        log.push(`${label}:start`);
        setTimeout(() => { log.push(`${label}:end`); fail ? reject(new Error(label)) : resolve(label); }, ms);
      });
      const p1 = proto._controlSteeringLock.call(srv, 's1', op('A', 20, false));
      const p2 = proto._controlSteeringLock.call(srv, 's1', op('B', 5, true)).catch(() => 'B-failed');
      const p3 = proto._controlSteeringLock.call(srv, 's1', op('C', 5, false));
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.equal(r1, 'A');
      assert.equal(r2, 'B-failed');           // B rejected, but the queue kept draining
      assert.equal(r3, 'C');
      assert.deepEqual(log, ['A:start', 'A:end', 'B:start', 'B:end', 'C:start', 'C:end']); // no overlap
    });

    it('different sessions are NOT serialised against each other', async function () {
      const srv = {};
      const log = [];
      const op = (label, ms) => () => new Promise((resolve) => { log.push(`${label}:s`); setTimeout(() => { log.push(`${label}:e`); resolve(); }, ms); });
      await Promise.all([
        proto._controlSteeringLock.call(srv, 'x', op('X', 25)),
        proto._controlSteeringLock.call(srv, 'y', op('Y', 5)),
      ]);
      assert.ok(log.indexOf('Y:e') < log.indexOf('X:e'), 'session y finished while x was still running');
    });

    it('two concurrent send_message to ONE session do not interleave bytes', async function () {
      this.timeout(4000);
      const inputs = [];
      const srv = {
        inputs,
        claudeSessions: new Map([['s1', { id: 's1', active: true, agent: 'terminal' }]]),
        _stickyJsonl: new Map(),
        _controlWithIdempotency: (id, key, fn) => fn(), // distinct keys → both ops actually run
        _controlSteeringLock: proto._controlSteeringLock,
        _controlInputBridge: () => ({ sendInput: async (id, data) => {
          inputs.push(`${data}#s`);
          await new Promise((r) => setTimeout(r, 15)); // widen the overlap window
          inputs.push(`${data}#e`);
        } }),
        _controlClampInt: proto._controlClampInt,
        _controlIsTurnAgent: proto._controlIsTurnAgent,
        _controlDerivedStatus: async () => ({ interactionState: 'idle' }),
        _controlSessionSeqFor: () => 0,
        controlEventBus: null,
      };
      await Promise.all([
        proto._controlSendMessage.call(srv, { sessionId: 's1', message: 'AAA', awaitMs: 0, idempotencyKey: 'k1' }),
        proto._controlSendMessage.call(srv, { sessionId: 's1', message: 'BBB', awaitMs: 0, idempotencyKey: 'k2' }),
      ]);
      // Each op writes text then '\r'. The mutex guarantees the first op's '\r'
      // completes before the second op's text begins (no AAA/BBB byte interleave).
      const idxAtext = inputs.indexOf('AAA#s');
      const idxBtext = inputs.indexOf('BBB#s');
      const firstText = Math.min(idxAtext, idxBtext);
      const secondText = Math.max(idxAtext, idxBtext);
      // Between the first op's text and the second op's text, the first op's '\r'
      // must have fully completed.
      const between = inputs.slice(firstText, secondText);
      assert.ok(between.includes('\r#e'), 'first op fully submitted (text + Enter) before the second op started typing');
    });
  });

  describe('F15 — _controlSnapshot atomic batch', function () {
    const { ControlEventBus } = require('../../src/control/event-bus');
    it('captures the cursor + every session status with the documented shape', async function () {
      const bus = new ControlEventBus();
      bus.append('s1', 'turn_ended'); // seq 1
      const srv = {
        controlEventBus: bus,
        claudeSessions: new Map([
          ['s1', { name: 'one', agent: 'claude', workingDir: '/w', lastActivity: 5 }],
          ['s2', { name: 'two', agent: 'terminal', workingDir: '/w', lastActivity: 6 }],
        ]),
        _stickyJsonl: new Map([['s1', {}]]),
        _controlSessionSeqFor: (id) => (id === 's1' ? 3 : 0),
        _controlDerivedStatus: async (id) => (id === 's1'
          ? { lifecycle: 'running', interactionState: 'idle', canAcceptInput: true, confidence: 'high', lastTurnEndedAt: 99, awaiting: { kind: 'next_message' } }
          : { lifecycle: 'exited', interactionState: 'exited', canAcceptInput: false, confidence: 'low' }),
      };
      const snap = await proto._controlSnapshot.call(srv);
      assert.equal(snap.cursor.seq, 1, 'cursor captured from the event bus');
      assert.equal(snap.sessions.length, 2);
      const s1 = snap.sessions.find((s) => s.sessionId === 's1');
      assert.equal(s1.bound, true);
      assert.equal(s1.sessionStateSeq, 3);
      assert.equal(s1.lastTurnEndedAt, 99);
      assert.equal(s1.interactionState, 'idle');
      assert.deepEqual(s1.awaiting, { kind: 'next_message' });
      const s2 = snap.sessions.find((s) => s.sessionId === 's2');
      assert.equal(s2.bound, false);
      assert.equal(s2.lastTurnEndedAt, null); // normalised from undefined
      assert.equal(s2.awaiting, null);
    });
  });

  describe('F19 — _controlCapabilities contract shape', function () {
    const FROZEN_CAP_VOCAB = new Set([
      'readiness_barrier', 'turn_binding', 'permission_mode', 'agent_args',
      'events_cursor', 'events_retention', 'multiplex_watch', 'session_state_seq',
    ]);

    it('returns the frozen { capabilities: string[], controlVersion: string } shape', function () {
      const { EVENT_KINDS } = require('../../src/control/event-bus');
      const { VALID_PERMISSION_MODES } = require('../../src/claude-bridge');
      const { ControlEventBus } = require('../../src/control/event-bus');
      const srv = { controlEventBus: new ControlEventBus() };
      const cap = proto._controlCapabilities.call(srv);

      // capabilities is a FLAT string[] the fleet client can `new Set(...)` over.
      assert.ok(Array.isArray(cap.capabilities), 'capabilities is an array');
      assert.doesNotThrow(() => new Set(cap.capabilities), 'new Set(capabilities) does not throw');
      for (const token of cap.capabilities) {
        assert.equal(typeof token, 'string');
        assert.ok(FROZEN_CAP_VOCAB.has(token), `'${token}' is in the frozen vocabulary`);
      }
      // The 6 expected tokens are present.
      const set = new Set(cap.capabilities);
      for (const expected of ['permission_mode', 'agent_args', 'turn_binding', 'events_cursor', 'events_retention', 'session_state_seq']) {
        assert.ok(set.has(expected), `advertises ${expected}`);
      }
      // controlVersion is a STRING.
      assert.equal(typeof cap.controlVersion, 'string');

      // Additive extras still present (the client ignores unknown keys; useful for debug).
      assert.deepEqual(cap.permissionModes, VALID_PERMISSION_MODES);
      assert.deepEqual(cap.events, EVENT_KINDS);
      assert.equal(cap.limits.eventsPerSession, srv.controlEventBus.maxEventsPerSession);
    });
  });
});
