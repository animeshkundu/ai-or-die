// test/file-watcher-client.test.js — pure-JS helpers exposed by
// file-watcher-client.js.
//
// DOM/SSE paths (WatcherClient.connect, EventSource lifecycle, reconnect
// with backoff, dispatch fan-out) are exercised by the Playwright e2e
// suite (tracked in #46/#48 — 17-fs-watcher.spec.js). This file covers
// the testable seam: URL composition + payload validation.

'use strict';

const path = require('path');
const assert = require('assert');

const modulePath = path.join(__dirname, '..', 'src', 'public', 'file-watcher-client.js');
delete require.cache[require.resolve(modulePath)];

const wc = require(modulePath);

describe('file-watcher-client.js (pure helpers)', function () {
  describe('exports under Node', function () {
    it('exposes buildWatchUrl, isValidEvent, WATCH_ENDPOINT', function () {
      assert.strictEqual(typeof wc.buildWatchUrl, 'function');
      assert.strictEqual(typeof wc.isValidEvent, 'function');
      assert.strictEqual(wc.WATCH_ENDPOINT, '/api/files/watch');
    });
    it('exposes KNOWN_EVENT_TYPES list', function () {
      assert.ok(Array.isArray(wc.KNOWN_EVENT_TYPES));
      assert.ok(wc.KNOWN_EVENT_TYPES.indexOf('change') !== -1);
      assert.ok(wc.KNOWN_EVENT_TYPES.indexOf('add') !== -1);
      assert.ok(wc.KNOWN_EVENT_TYPES.indexOf('unlink') !== -1);
    });
  });

  describe('buildWatchUrl', function () {
    it('builds URL with path query param', function () {
      assert.strictEqual(wc.buildWatchUrl('/home/user/proj'),
        '/api/files/watch?path=%2Fhome%2Fuser%2Fproj');
    });
    it('appends token when provided (EventSource auth path)', function () {
      var u = wc.buildWatchUrl('/x', 'tok123');
      assert.ok(u.indexOf('path=%2Fx') !== -1);
      assert.ok(u.indexOf('token=tok123') !== -1);
    });
    it('URL-encodes both path and token', function () {
      var u = wc.buildWatchUrl('/has space/foo', 'tok&val');
      assert.ok(u.indexOf('path=%2Fhas%20space%2Ffoo') !== -1);
      assert.ok(u.indexOf('token=tok%26val') !== -1);
    });
    it('returns empty string for falsy path', function () {
      assert.strictEqual(wc.buildWatchUrl(''), '');
      assert.strictEqual(wc.buildWatchUrl(null), '');
    });
    it('omits token when empty/null/undefined', function () {
      assert.strictEqual(wc.buildWatchUrl('/x'),
        '/api/files/watch?path=%2Fx');
      assert.strictEqual(wc.buildWatchUrl('/x', ''),
        '/api/files/watch?path=%2Fx');
      assert.strictEqual(wc.buildWatchUrl('/x', null),
        '/api/files/watch?path=%2Fx');
    });
  });

  describe('isValidEvent', function () {
    it('accepts well-formed change/add/unlink events with path', function () {
      assert.strictEqual(wc.isValidEvent({ type: 'change', path: '/a', mtime: 1, hash: 'x' }), true);
      assert.strictEqual(wc.isValidEvent({ type: 'add', path: '/a', mtime: 1 }), true);
      assert.strictEqual(wc.isValidEvent({ type: 'unlink', path: '/a' }), true);
    });
    it('accepts type-only events (start/end/error) without path', function () {
      assert.strictEqual(wc.isValidEvent({ type: 'start' }), true);
      assert.strictEqual(wc.isValidEvent({ type: 'end', reason: 'client-disconnect' }), true);
      assert.strictEqual(wc.isValidEvent({ type: 'error', message: 'wat' }), true);
    });
    it('rejects unknown types (forward-compat guard)', function () {
      assert.strictEqual(wc.isValidEvent({ type: 'rename', path: '/a' }), false);
      assert.strictEqual(wc.isValidEvent({ type: 'wat', path: '/a' }), false);
      assert.strictEqual(wc.isValidEvent({ type: '', path: '/a' }), false);
    });
    it('rejects path-bearing events with missing/empty path', function () {
      assert.strictEqual(wc.isValidEvent({ type: 'change' }), false);
      assert.strictEqual(wc.isValidEvent({ type: 'change', path: '' }), false);
      assert.strictEqual(wc.isValidEvent({ type: 'change', path: 123 }), false);
      assert.strictEqual(wc.isValidEvent({ type: 'add', path: null }), false);
    });
    it('rejects null/undefined/non-object input (defensive)', function () {
      assert.strictEqual(wc.isValidEvent(null), false);
      assert.strictEqual(wc.isValidEvent(undefined), false);
      assert.strictEqual(wc.isValidEvent('hello'), false);
      assert.strictEqual(wc.isValidEvent(42), false);
    });
  });
});
