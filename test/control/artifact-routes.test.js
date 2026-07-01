'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { ArtifactReviewStore, createArtifactReviewRouter, createAssetTokenSigner, formatFeedbackForAgent, buildArtifactPushPayload, artifactPushEnabledFromEnv } = require('../../src/artifact-review');

let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../../src/server'));
} catch (_) {
  /* optional native deps may be unavailable in some local test runs */
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function startWebServer(baseDir, options) {
  const originalCwd = process.cwd();
  try {
    process.chdir(baseDir);
    const server = new ClaudeCodeWebServer(Object.assign({
      port: 0,
      sessionStoreOptions: { storageDir: path.join(baseDir, '.sessions') },
      artifactPollHoldMs: 80,
      artifactPollHeartbeatMs: 20,
      artifactSseHeartbeatMs: 50,
    }, options || {}));
    const httpServer = await server.start();
    return { server, port: httpServer.address().port };
  } finally {
    process.chdir(originalCwd);
  }
}

function extractScopedAssetToken(html, sessionId) {
  const base = '/api/artifact/' + encodeURIComponent(sessionId) + '/asset/_auth/';
  const start = html.indexOf('<base href="' + base);
  assert.notEqual(start, -1, 'expected scoped asset token in artifact base href');
  const tokenStart = start + '<base href="'.length + base.length;
  const tokenEnd = html.indexOf('/">', tokenStart);
  assert.notEqual(tokenEnd, -1, 'expected scoped asset token terminator');
  return decodeURIComponent(html.slice(tokenStart, tokenEnd));
}

function buildApp(opts) {
  opts = opts || {};
  const app = express();
  const store = opts.store || new ArtifactReviewStore();
  const signer = opts.signer || createAssetTokenSigner(opts.assetSecret || Buffer.from('artifact-routes-test-secret'));
  const baseDir = fs.realpathSync(opts.baseDir);
  const seenPaths = [];

  function validatePath(rawPath) {
    seenPaths.push(rawPath);
    if (!rawPath || typeof rawPath !== 'string') {
      return { valid: false, error: 'Path is required' };
    }
    let canonical = path.resolve(rawPath);
    try {
      if (fs.existsSync(canonical)) {
        canonical = fs.realpathSync(canonical);
      } else {
        const parent = path.dirname(canonical);
        if (fs.existsSync(parent)) canonical = path.join(fs.realpathSync(parent), path.basename(canonical));
      }
    } catch (_) {
      /* keep lexical canonical path */
    }
    const rel = path.relative(baseDir, canonical);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { valid: false, error: 'outside base' };
    }
    return { valid: true, path: canonical };
  }

  app.use(express.json());
  app.use((req, res, next) => { // eslint-disable-line no-unused-vars
    const m = /^\/api\/artifact\/([^/]+)\/asset\/_auth\/([^/]+)(?:\/|$)/.exec(req.path);
    if (m) {
      try {
        const sessionId = decodeURIComponent(m[1]);
        const token = decodeURIComponent(m[2]);
        if (signer.verify(sessionId, token)) req.artifactAssetPathToken = token;
      } catch (_) {
        /* leave request unauthenticated */
      }
    }
    next();
  });
  app.use('/api/artifact', createArtifactReviewRouter({
    store,
    validatePath,
    mintAssetToken: (sid) => signer.mint(sid),
    broadcastToSession: () => {},
    pollHoldMs: opts.pollHoldMs == null ? 80 : opts.pollHoldMs,
    pollHeartbeatMs: opts.pollHeartbeatMs == null ? 20 : opts.pollHeartbeatMs,
    sseHeartbeatMs: opts.sseHeartbeatMs == null ? 50 : opts.sseHeartbeatMs,
    pushToAgent: opts.pushToAgent || null,
    pushTimeoutMs: opts.pushTimeoutMs,
  }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ error: err.message });
  });
  return { app, store, validatePath, seenPaths, signer };
}

async function postJson(port, pathname, body) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
}

async function getJson(port, pathname) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { status: r.status, body: await r.json() };
}

describe('artifact review routes', function () {
  let tmpDir;
  let artifactFile;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-routes-'));
    artifactFile = path.join(tmpDir, 'artifact.html');
    fs.writeFileSync(artifactFile, '<!doctype html><html><head><title>A</title></head><body><img src="img.png"></body></html>');
    fs.writeFileSync(path.join(tmpDir, 'img.png'), 'not really png');
  });

  afterEach(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('open then view returns artifact HTML with the SDK and asset base injected', async function () {
    const { app } = buildApp({ baseDir: tmpDir });
    const { server, port } = await listen(app);
    try {
      const opened = await postJson(port, '/api/artifact/s1/open', { file: artifactFile });
      assert.equal(opened.status, 200);
      assert.equal(opened.body.sessionId, 's1');
      assert.ok(opened.body.key);
      assert.equal(opened.body.viewUrl, '/api/artifact/s1/view');

      const r = await fetch(`http://127.0.0.1:${port}${opened.body.viewUrl}`);
      const html = await r.text();
      assert.equal(r.status, 200);
      assert.match(html, /data-ai-or-die-artifact-sdk/);
      assert.match(html, /__AI_OR_DIE_ARTIFACT_REVIEW__/);
      const baseMatch = html.match(/<base href="\/api\/artifact\/s1\/asset\/_auth\/([^/]+)\/">/);
      assert.ok(baseMatch, 'expected scoped asset token in artifact base href');
      assert.notEqual(baseMatch[1], 's1');
      assert.match(html, /"assetToken":"[^"]+"/);
      assert.match(html, /\/api\/artifact\/s1\/sdk\.js/);
    } finally {
      server.close();
    }
  });

  it('markdown artifact view renders a shell (not raw markdown) with the SDK injected', async function () {
    const mdFile = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(mdFile, '# My Plan\n\nFix the **footer** alignment.\n');
    const { app } = buildApp({ baseDir: tmpDir });
    const { server, port } = await listen(app);
    try {
      const opened = await postJson(port, '/api/artifact/md1/open', { file: mdFile });
      assert.equal(opened.status, 200);

      const r = await fetch(`http://127.0.0.1:${port}${opened.body.viewUrl}`);
      const html = await r.text();
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') || '', /text\/html/);

      // It is a rendered HTML shell, NOT the raw markdown bytes.
      assert.match(html, /<!doctype html>/i);
      assert.match(html, /md-artifact-root/);
      // The renderer is loaded by ABSOLUTE path so the injected <base> can't
      // redirect it through the asset route.
      assert.match(html, /<script src="\/markdown-render\.js">/);
      // Raw markdown must not be served unprocessed: the heading is carried as
      // an escaped JSON string for the client renderer, not as a top-level
      // markdown line in the document body.
      assert.ok(!/^# My Plan$/m.test(html), 'raw markdown heading must not appear unprocessed');
      assert.ok(html.includes('My Plan'), 'source is embedded for client rendering');

      // The annotation SDK + config are injected on top of the shell.
      assert.match(html, /data-ai-or-die-artifact-sdk/);
      assert.match(html, /__AI_OR_DIE_ARTIFACT_REVIEW__/);
      assert.match(html, /\/api\/artifact\/md1\/sdk\.js/);
    } finally {
      server.close();
    }
  });

  it('a non-markdown (.html) artifact keeps the raw passthrough path', async function () {
    const { app } = buildApp({ baseDir: tmpDir });
    const { server, port } = await listen(app);
    try {
      await postJson(port, '/api/artifact/h1/open', { file: artifactFile });
      const r = await fetch(`http://127.0.0.1:${port}/api/artifact/h1/view`);
      const html = await r.text();
      assert.equal(r.status, 200);
      // The original HTML body survives verbatim (only the SDK head injection is added).
      assert.match(html, /<title>A<\/title>/);
      assert.match(html, /<img src="img\.png">/);
      // No markdown shell artifacts.
      assert.ok(!html.includes('md-artifact-root'), 'html artifact must not be wrapped in the markdown shell');
      assert.ok(!html.includes('/markdown-render.js'), 'html artifact must not load the markdown renderer');
    } finally {
      server.close();
    }
  });

  it('POST prompts then GET poll returns the feedback once', async function () {
    const { app, store } = buildApp({ baseDir: tmpDir });
    const { server, port } = await listen(app);
    try {
      await postJson(port, '/api/artifact/s1/open', { file: artifactFile });
      const queued = await postJson(port, '/api/artifact/s1/prompts', {
        prompts: ['please review'],
        domSnapshot: { bodyText: 'snapshot' },
      });
      assert.equal(queued.status, 200);

      const first = await getJson(port, '/api/artifact/s1/poll');
      assert.equal(first.status, 200);
      assert.deepEqual(first.body.prompts, ['please review']);
      assert.deepEqual(first.body.dom_snapshot, { bodyText: 'snapshot' });
      assert.equal(first.body.next_step, 'review_feedback');

      assert.deepEqual(store.peekFeedback('s1').prompts, []);
    } finally {
      server.close();
    }
  });

  it('rejects traversal asset paths before serving outside the artifact directory', async function () {
    const siblingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-routes-outside-'));
    const secret = path.join(siblingDir, 'secret.txt');
    fs.writeFileSync(secret, 'secret');

    const { app, seenPaths } = buildApp({ baseDir: path.dirname(tmpDir) });
    const { server, port } = await listen(app);
    try {
      await postJson(port, '/api/artifact/s1/open', { file: artifactFile });
      const r = await fetch(`http://127.0.0.1:${port}/api/artifact/s1/asset/..%2f${encodeURIComponent(path.basename(siblingDir))}/secret.txt`);
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.match(body.error, /escapes|outside|denied/i);
      assert.ok(!seenPaths.some((p) => path.resolve(p) === secret), 'escaped asset path should not be validated for serving');
    } finally {
      server.close();
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });

  it('returns 403 for an out-of-base artifact file on open', async function () {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-routes-file-outside-'));
    const outsideFile = path.join(outsideDir, 'outside.html');
    fs.writeFileSync(outsideFile, '<html></html>');

    const { app } = buildApp({ baseDir: tmpDir });
    const { server, port } = await listen(app);
    try {
      const r = await postJson(port, '/api/artifact/s1/open', { file: outsideFile });
      assert.equal(r.status, 403);
    } finally {
      server.close();
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('poll long-holds and resolves when a prompt is posted', async function () {
    const { app } = buildApp({ baseDir: tmpDir, pollHoldMs: 500, pollHeartbeatMs: 20 });
    const { server, port } = await listen(app);
    try {
      await postJson(port, '/api/artifact/s1/open', { file: artifactFile });
      const started = Date.now();
      const pending = getJson(port, '/api/artifact/s1/poll');

      await new Promise((resolve) => setTimeout(resolve, 60));
      await postJson(port, '/api/artifact/s1/prompts', { prompts: ['wake up'], domSnapshot: { ready: true } });

      const out = await pending;
      assert.equal(out.status, 200);
      assert.deepEqual(out.body.prompts, ['wake up']);
      assert.deepEqual(out.body.dom_snapshot, { ready: true });
      assert.equal(out.body.next_step, 'review_feedback');
      assert.ok(Date.now() - started >= 40, 'poll should have held before resolving');
    } finally {
      server.close();
    }
  });

  describe('artifact push (idle-gated injection)', function () {
    it('formatFeedbackForAgent renders object + string prompts; empty when nothing actionable', function () {
      assert.equal(formatFeedbackForAgent([]), '');
      assert.equal(formatFeedbackForAgent(['   ', { text: 'x' }]), '');
      const out = formatFeedbackForAgent([
        { prompt: 'tighten this', text: 'the goal section', sourceLine: 12 },
        'also fix the title',
      ]);
      assert.match(out, /artifact_reply/);
      assert.match(out, /1\. \[line 12\] \(re: "the goal section"\) tighten this/);
      assert.match(out, /2\. also fix the title/);
    });

    it('artifactPushEnabledFromEnv defaults ON and only an explicit falsy value disables it', function () {
      // Default on: unset / empty / whitespace / any non-falsy value.
      for (const on of [undefined, null, '', '  ', '1', 'true', 'anything']) {
        assert.equal(artifactPushEnabledFromEnv(on), true, JSON.stringify(on) + ' should enable');
      }
      // Opt out: only explicit falsy tokens (case/space-insensitive).
      for (const off of ['0', 'false', ' OFF ', 'No']) {
        assert.equal(artifactPushEnabledFromEnv(off), false, JSON.stringify(off) + ' should disable');
      }
    });

    it('buildArtifactPushPayload strips ESC/control bytes and cannot break out of the paste envelope', function () {
      assert.equal(buildArtifactPushPayload(''), '');
      assert.equal(buildArtifactPushPayload(null), '');
      // A hostile string: an injected paste-end marker, a bare CR, a CSI sequence,
      // a NUL and a BEL. None may survive as control bytes in the payload.
      const hostile = 'hi\x1b[201~\rmalicious\x1b[2J\x00\x07 end';
      const payload = buildArtifactPushPayload(hostile);
      // Exactly one leading paste-start, one paste-end, one trailing CR (ours).
      assert.equal(payload.indexOf('\x1b[200~'), 0);
      assert.equal((payload.match(/\x1b\[200~/g) || []).length, 1);
      assert.equal((payload.match(/\x1b\[201~/g) || []).length, 1);
      assert.ok(payload.endsWith('\x1b[201~\r'));
      // Between the markers there are NO ESC bytes and NO CR (only our wrapper).
      const inner = payload.slice('\x1b[200~'.length, payload.length - '\x1b[201~\r'.length);
      assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(inner), 'inner text must be free of C0/DEL controls');
      assert.match(inner, /hi.*malicious.*end/);
    });

    it('pushes to the agent and consumes the queue when no poll is in flight', async function () {
      const calls = [];
      const pushToAgent = async (sessionId, text) => { calls.push({ sessionId, text }); return true; };
      const { app, store } = buildApp({ baseDir: tmpDir, pushToAgent });
      const { server, port } = await listen(app);
      try {
        await postJson(port, '/api/artifact/s1/open', { file: artifactFile });
        const r = await postJson(port, '/api/artifact/s1/prompts', {
          prompts: [{ prompt: 'please tighten the plan', text: 'goal' }],
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.pushed, true);
        assert.equal(r.body.queued, 0);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].sessionId, 's1');
        assert.match(calls[0].text, /please tighten the plan/);
        // Consumed: a later poll has nothing to deliver.
        assert.deepEqual(store.peekFeedback('s1').prompts, []);
      } finally {
        server.close();
      }
    });

    it('does NOT push when a poll is already in flight (the poll delivers it)', async function () {
      const calls = [];
      const pushToAgent = async (sessionId, text) => { calls.push({ sessionId, text }); return true; };
      const { app } = buildApp({ baseDir: tmpDir, pushToAgent, pollHoldMs: 500, pollHeartbeatMs: 20 });
      const { server, port } = await listen(app);
      try {
        await postJson(port, '/api/artifact/s1/open', { file: artifactFile });
        const pending = getJson(port, '/api/artifact/s1/poll');
        await new Promise((resolve) => setTimeout(resolve, 60)); // let the poll register
        const r = await postJson(port, '/api/artifact/s1/prompts', { prompts: ['delivered by poll'] });
        const out = await pending;

        assert.equal(out.status, 200);
        assert.deepEqual(out.body.prompts, ['delivered by poll']);
        assert.equal(calls.length, 0, 'must not inject while a poll is in flight');
        assert.equal(r.body.pushed, false);
      } finally {
        server.close();
      }
    });

    it('leaves the queue intact when the push hook declines (returns falsy)', async function () {
      const pushToAgent = async () => false; // e.g. PTY not idle / no live session
      const { app, store } = buildApp({ baseDir: tmpDir, pushToAgent });
      const { server, port } = await listen(app);
      try {
        await postJson(port, '/api/artifact/s1/open', { file: artifactFile });
        const r = await postJson(port, '/api/artifact/s1/prompts', { prompts: ['still queued'] });
        assert.equal(r.body.pushed, false);
        assert.equal(r.body.queued, 1);
        // Not consumed: the poll path still works.
        const poll = await getJson(port, '/api/artifact/s1/poll');
        assert.deepEqual(poll.body.prompts, ['still queued']);
      } finally {
        server.close();
      }
    });

    it('without a push hook, behaviour is unchanged (queued for the poll)', async function () {
      const { app } = buildApp({ baseDir: tmpDir }); // no pushToAgent
      const { server, port } = await listen(app);
      try {
        await postJson(port, '/api/artifact/s1/open', { file: artifactFile });
        const r = await postJson(port, '/api/artifact/s1/prompts', { prompts: ['queued only'] });
        assert.equal(r.body.pushed, false);
        assert.equal(r.body.queued, 1);
      } finally {
        server.close();
      }
    });

    it('treats a hung push as failed (timeout) and restores the queue', async function () {
      let resolveLate;
      const pushToAgent = () => new Promise((resolve) => { resolveLate = resolve; }); // never resolves in time
      const { app, store } = buildApp({ baseDir: tmpDir, pushToAgent, pushTimeoutMs: 60 });
      const { server, port } = await listen(app);
      try {
        await postJson(port, '/api/artifact/s1/open', { file: artifactFile });
        const r = await postJson(port, '/api/artifact/s1/prompts', { prompts: ['hung push'] });
        assert.equal(r.body.pushed, false, 'a push that exceeds the timeout is reported as not pushed');
        assert.equal(r.body.queued, 1, 'the claimed feedback is restored to the queue on timeout');
        assert.deepEqual(store.peekFeedback('s1').prompts, ['hung push']);
        if (resolveLate) resolveLate(true); // let the dangling push settle
      } finally {
        server.close();
      }
    });

    it('claims feedback before the push await so a poll arriving mid-push cannot double-deliver', async function () {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const calls = [];
      const pushToAgent = async (sessionId, text) => { calls.push(text); await gate; return true; };
      const { app } = buildApp({ baseDir: tmpDir, pushToAgent, pollHoldMs: 250, pollHeartbeatMs: 20 });
      const { server, port } = await listen(app);
      try {
        await postJson(port, '/api/artifact/s1/open', { file: artifactFile });
        // No active poll: /prompts claims the feedback, then blocks on the gated push.
        const promptsP = postJson(port, '/api/artifact/s1/prompts', { prompts: ['only once'] });
        await new Promise((r) => setTimeout(r, 40)); // let the claim + push start
        // A poll now arrives DURING the push window; the feedback was already
        // claimed, so this poll must hold and return empty (no double-delivery).
        const pollP = getJson(port, '/api/artifact/s1/poll');
        await new Promise((r) => setTimeout(r, 40));
        release();
        const prompts = await promptsP;
        const poll = await pollP;

        assert.equal(calls.length, 1);
        assert.equal(prompts.body.pushed, true);
        assert.equal(poll.body.next_step, 'poll', 'poll should time out empty, not deliver claimed feedback');
        assert.ok(!poll.body.prompts || poll.body.prompts.length === 0);
      } finally {
        server.close();
      }
    });
  });
});
