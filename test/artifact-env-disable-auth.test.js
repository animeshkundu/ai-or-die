'use strict';

// Fix A: artifact-review env trio must inject for a standalone instance under
// --disable-auth (noAuth), not just an authed one — otherwise the in-tab
// agent's artifact_* tools stay dark and the viewer never opens.

const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

describe('artifact env trio (--disable-auth)', function () {
  it('injects the trio with a sentinel token when auth is disabled', function () {
    const server = new ClaudeCodeWebServer({ noAuth: true, port: 7777, https: true });
    const env = server._artifactEnvForSession('sess-1');
    assert.strictEqual(env.AIORDIE_BASE_URL, 'https://127.0.0.1:7777');
    assert.strictEqual(env.AIORDIE_TOKEN, 'noauth');
    assert.strictEqual(env.AIORDIE_SESSION_ID, 'sess-1');
  });

  it('injects the real bearer when auth is set', function () {
    const server = new ClaudeCodeWebServer({ auth: 'tok-x', port: 7777, https: false });
    const env = server._artifactEnvForSession('sess-2');
    assert.strictEqual(env.AIORDIE_BASE_URL, 'http://127.0.0.1:7777');
    assert.strictEqual(env.AIORDIE_TOKEN, 'tok-x');
    assert.strictEqual(env.AIORDIE_SESSION_ID, 'sess-2');
  });

  it('injects nothing only when both auth and noAuth are absent', function () {
    const server = new ClaudeCodeWebServer({ port: 7777 });
    assert.deepStrictEqual(server._artifactEnvForSession('sess-3'), {});
  });
});
