// test/file-watcher-client.test.js — pure-JS helpers exposed by
// file-watcher-client.js (post-pivot, session+subscribe wire model
// per ADR-0017 amendment + server commit ff79038).
//
// DOM/SSE paths (WatcherClient.connect, EventSource lifecycle, reconnect
// with backoff, dispatch fan-out, refcount-based subscribe/unsubscribe
// POSTs, replay-after-`start`-event) are exercised by the Playwright
// e2e suite (#46/#48 — 17-fs-watcher.spec.js). This file covers the
// testable seam: URL composition + payload validation + path
// normalization.

'use strict';

const path = require('path');
const assert = require('assert');

const modulePath = path.join(__dirname, '..', 'src', 'public', 'file-watcher-client.js');
delete require.cache[require.resolve(modulePath)];

const wc = require(modulePath);

describe('file-watcher-client.js (pure helpers)', function () {
  describe('exports under Node', function () {
    it('exposes the wire-shape helpers', function () {
      assert.strictEqual(typeof wc.buildWatchUrl, 'function');
      assert.strictEqual(typeof wc.buildControlUrl, 'function');
      assert.strictEqual(typeof wc.normalizePath, 'function');
      assert.strictEqual(typeof wc.isValidEvent, 'function');
    });
    it('exposes the canonical endpoint constants', function () {
      assert.strictEqual(wc.WATCH_ENDPOINT, '/api/files/watch');
      assert.strictEqual(wc.SUBSCRIBE_ENDPOINT, '/api/files/watch/subscribe');
      assert.strictEqual(wc.UNSUBSCRIBE_ENDPOINT, '/api/files/watch/unsubscribe');
    });
    it('exposes KNOWN_EVENT_TYPES list including rename', function () {
      assert.ok(Array.isArray(wc.KNOWN_EVENT_TYPES));
      ['start', 'add', 'change', 'unlink', 'rename', 'error', 'end'].forEach(function (t) {
        assert.ok(wc.KNOWN_EVENT_TYPES.indexOf(t) !== -1, 'missing event type: ' + t);
      });
    });
  });

  describe('buildWatchUrl', function () {
    it('builds session-scoped URL with rootPath', function () {
      assert.strictEqual(
        wc.buildWatchUrl('sess-123', '/home/user/proj'),
        '/api/files/watch?session=sess-123&path=%2Fhome%2Fuser%2Fproj'
      );
    });
    it('appends token when provided', function () {
      var u = wc.buildWatchUrl('sess', '/x', 'tok');
      assert.ok(u.indexOf('session=sess') !== -1);
      assert.ok(u.indexOf('path=%2Fx') !== -1);
      assert.ok(u.indexOf('token=tok') !== -1);
    });
    it('URL-encodes session, path, and token', function () {
      var u = wc.buildWatchUrl('sess id', '/has space/foo', 'tok&val');
      assert.ok(u.indexOf('session=sess%20id') !== -1);
      assert.ok(u.indexOf('path=%2Fhas%20space%2Ffoo') !== -1);
      assert.ok(u.indexOf('token=tok%26val') !== -1);
    });
    it('returns empty string when session OR rootPath missing', function () {
      assert.strictEqual(wc.buildWatchUrl('', '/x'), '');
      assert.strictEqual(wc.buildWatchUrl('sess', ''), '');
      assert.strictEqual(wc.buildWatchUrl(null, '/x'), '');
    });
  });

  describe('buildControlUrl', function () {
    it('builds the subscribe endpoint with session+path', function () {
      assert.strictEqual(
        wc.buildControlUrl('subscribe', 'sess', '/abs/foo.js'),
        '/api/files/watch/subscribe?session=sess&path=%2Fabs%2Ffoo.js'
      );
    });
    it('builds the unsubscribe endpoint when action=unsubscribe', function () {
      assert.strictEqual(
        wc.buildControlUrl('unsubscribe', 'sess', '/abs/foo.js'),
        '/api/files/watch/unsubscribe?session=sess&path=%2Fabs%2Ffoo.js'
      );
    });
    it('defaults to subscribe for unknown action (safer default)', function () {
      assert.strictEqual(
        wc.buildControlUrl('typo-action', 'sess', '/x'),
        '/api/files/watch/subscribe?session=sess&path=%2Fx'
      );
    });
    it('appends token + URL-encodes everything', function () {
      var u = wc.buildControlUrl('subscribe', 'sess&val', '/has space', 'tok+1');
      assert.ok(u.indexOf('session=sess%26val') !== -1);
      assert.ok(u.indexOf('path=%2Fhas%20space') !== -1);
      assert.ok(u.indexOf('token=tok%2B1') !== -1);
    });
    it('returns empty string when session OR path missing', function () {
      assert.strictEqual(wc.buildControlUrl('subscribe', '', '/x'), '');
      assert.strictEqual(wc.buildControlUrl('subscribe', 'sess', ''), '');
    });
  });

  describe('normalizePath', function () {
    it('forward-slashes Windows paths', function () {
      assert.strictEqual(wc.normalizePath('C:\\Users\\x\\foo.js'), 'C:/Users/x/foo.js');
    });
    it('passes through forward-slashed paths unchanged', function () {
      assert.strictEqual(wc.normalizePath('/home/user/foo.js'), '/home/user/foo.js');
    });
    it('returns empty string for falsy input', function () {
      assert.strictEqual(wc.normalizePath(''), '');
      assert.strictEqual(wc.normalizePath(null), '');
      assert.strictEqual(wc.normalizePath(undefined), '');
    });
  });

  describe('isValidEvent', function () {
    it('accepts well-formed change/add/unlink/rename events with path', function () {
      assert.strictEqual(wc.isValidEvent({ type: 'change', path: '/a', mtime: 1, hash: 'x' }), true);
      assert.strictEqual(wc.isValidEvent({ type: 'add', path: '/a', mtime: 1 }), true);
      assert.strictEqual(wc.isValidEvent({ type: 'unlink', path: '/a' }), true);
      assert.strictEqual(wc.isValidEvent({ type: 'rename', path: '/a', prevPath: '/b' }), true);
    });
    it('accepts type-only lifecycle events without path', function () {
      assert.strictEqual(wc.isValidEvent({ type: 'start' }), true);
      assert.strictEqual(wc.isValidEvent({ type: 'end', reason: 'replaced' }), true);
      assert.strictEqual(wc.isValidEvent({ type: 'error', message: 'wat' }), true);
    });
    it('rejects unknown types (forward-compat guard)', function () {
      assert.strictEqual(wc.isValidEvent({ type: 'addDir', path: '/a' }), false);
      assert.strictEqual(wc.isValidEvent({ type: 'wat', path: '/a' }), false);
    });
    it('rejects path-bearing events with missing/empty path', function () {
      assert.strictEqual(wc.isValidEvent({ type: 'change' }), false);
      assert.strictEqual(wc.isValidEvent({ type: 'rename', path: '' }), false);
      assert.strictEqual(wc.isValidEvent({ type: 'add', path: 123 }), false);
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
