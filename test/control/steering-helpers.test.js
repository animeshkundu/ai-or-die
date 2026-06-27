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
        _controlInputBridge: () => ({ sendInput: async (id, data) => { inputs.push(data); } }),
        _controlClampInt: proto._controlClampInt,
        _controlDerivedStatus: async () => statusSequence[Math.min(pollIdx++, statusSequence.length - 1)],
        _stickyJsonl: new Map(),
        _controlSessionSeqFor: () => 0,
        controlEventBus: null, // no cursor → the confirm waitFor is skipped (keeps the test fast)
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
});
