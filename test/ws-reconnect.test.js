'use strict';

// test/ws-reconnect.test.js — the WebSocket close -> reconnect decision.
// Regression for the bug where the heartbeat's own pong-timeout close (code
// 4000, a CLEAN client close) was NOT treated as reconnectable, so a single
// transient pong-timeout stranded the client on "Disconnected" until a manual
// refresh (app.js onclose gated reconnect on !wasClean only).

const assert = require('assert');
const path = require('path');
const modulePath = path.join(__dirname, '..', 'src', 'public', 'ws-reconnect.js');
delete require.cache[require.resolve(modulePath)];
const { isReconnectableClose } = require(modulePath);

describe('ws-reconnect: isReconnectableClose', function () {
  it('reconnects on an abnormal (non-clean) close — network drop / crash', function () {
    assert.strictEqual(isReconnectableClose({ wasClean: false, code: 1006 }), true);
  });

  it('does NOT reconnect on a normal clean close (1000)', function () {
    assert.strictEqual(isReconnectableClose({ wasClean: true, code: 1000 }), false);
  });

  it('reconnects on our own heartbeat pong-timeout close (code 4000) even though it is clean', function () {
    // THE FIX: 4000 is a clean client-initiated close; without this it dead-ended.
    assert.strictEqual(isReconnectableClose({ wasClean: true, code: 4000 }), true);
  });

  it('reconnects on a server frame-rejection (clean close + voiceRejected)', function () {
    assert.strictEqual(isReconnectableClose({ wasClean: true, code: 1009 }, true), true);
  });

  it('does NOT reconnect on a clean non-4000 close with voiceRejected=false', function () {
    assert.strictEqual(isReconnectableClose({ wasClean: true, code: 1001 }, false), false);
  });

  it('treats a missing wasClean as reconnectable (defensive)', function () {
    assert.strictEqual(isReconnectableClose({ code: 1006 }), true);
  });

  it('returns false for a null/absent event', function () {
    assert.strictEqual(isReconnectableClose(null), false);
    assert.strictEqual(isReconnectableClose(undefined), false);
  });
});
