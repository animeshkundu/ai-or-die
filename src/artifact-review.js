'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_POLL_HOLD_MS = 25000;
const DEFAULT_POLL_HEARTBEAT_MS = 5000;
const DEFAULT_SSE_HEARTBEAT_MS = 15000;

function realpathOrResolve(file) {
  let resolved = path.resolve(file);
  try {
    resolved = fs.realpathSync(resolved);
  } catch (_) {
    /* keep resolved lexical path */
  }
  return resolved;
}

function artifactKeyForFile(file) {
  return crypto
    .createHash('sha256')
    .update(realpathOrResolve(file))
    .digest('hex')
    .slice(0, 16);
}

function createAssetTokenSigner(secret) {
  function mint(sessionId) {
    return crypto
      .createHmac('sha256', secret)
      .update(String(sessionId))
      .digest('base64url');
  }

  function verify(sessionId, token) {
    if (typeof token !== 'string') return false;
    try {
      const expected = Buffer.from(mint(sessionId));
      const actual = Buffer.from(token);
      if (expected.length !== actual.length) return false;
      return crypto.timingSafeEqual(expected, actual);
    } catch (_) {
      return false;
    }
  }

  return { mint, verify };
}

function cloneArray(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function nowIso() {
  return new Date().toISOString();
}

function feedbackSnapshot(review) {
  const prompts = cloneArray(review.queuedPrompts);
  const layoutWarnings = cloneArray(review.layoutWarnings);
  return {
    prompts,
    layout_warnings: layoutWarnings,
    dom_snapshot: review.domSnapshot,
    _ack: {
      promptCount: prompts.length,
      promptsJson: JSON.stringify(prompts),
      warningsJson: JSON.stringify(layoutWarnings),
    },
  };
}

function feedbackHasData(snapshot) {
  return !!snapshot && (
    (Array.isArray(snapshot.prompts) && snapshot.prompts.length > 0) ||
    (Array.isArray(snapshot.layout_warnings) && snapshot.layout_warnings.length > 0)
  );
}

class ArtifactReviewStore extends EventEmitter {
  constructor() {
    super();
    this._reviews = new Map();
  }

  open(aiSessionId, file) {
    if (!aiSessionId || typeof aiSessionId !== 'string') {
      throw new TypeError('aiSessionId is required');
    }
    if (!file || typeof file !== 'string') {
      throw new TypeError('file is required');
    }

    const resolvedFile = realpathOrResolve(file);
    const existing = this._reviews.get(aiSessionId);
    const review = existing || {
      aiSessionId,
      file: resolvedFile,
      key: artifactKeyForFile(resolvedFile),
      status: 'open',
      queuedPrompts: [],
      layoutWarnings: [],
      domSnapshot: null,
      chat: [],
      presence: { connected: false, lastSeen: null },
      updatedAt: nowIso(),
    };

    review.aiSessionId = aiSessionId;
    review.file = resolvedFile;
    review.key = artifactKeyForFile(resolvedFile);
    review.status = 'open';
    if (!Array.isArray(review.queuedPrompts)) review.queuedPrompts = [];
    if (!Array.isArray(review.layoutWarnings)) review.layoutWarnings = [];
    if (!Array.isArray(review.chat)) review.chat = [];
    if (!review.presence || typeof review.presence !== 'object') {
      review.presence = { connected: false, lastSeen: null };
    }
    review.updatedAt = nowIso();

    this._reviews.set(aiSessionId, review);
    return review;
  }

  queuePrompts(aiSessionId, prompts, domSnapshot) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    const queued = cloneArray(prompts);
    if (queued.length > 0) {
      review.queuedPrompts.push(...queued);
    }
    if (domSnapshot !== undefined) {
      review.domSnapshot = domSnapshot;
    }
    review.updatedAt = nowIso();

    if (queued.length > 0) {
      this.emit('feedback', { aiSessionId, kind: 'prompts', review });
    }
    return review;
  }

  recordLayoutWarnings(aiSessionId, warnings) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    const nextWarnings = cloneArray(warnings);
    const currentJson = JSON.stringify(review.layoutWarnings || []);
    const nextJson = JSON.stringify(nextWarnings);
    const changed = currentJson !== nextJson;

    if (changed) {
      review.layoutWarnings = nextWarnings;
      review.updatedAt = nowIso();
    }

    if (changed && nextWarnings.length > 0) {
      this.emit('feedback', { aiSessionId, kind: 'layout-warnings', review });
    }

    return { review, changed };
  }

  takeFeedback(aiSessionId) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    const snapshot = feedbackSnapshot(review);
    review.queuedPrompts = [];
    review.layoutWarnings = [];
    review.updatedAt = nowIso();

    return {
      prompts: snapshot.prompts,
      layout_warnings: snapshot.layout_warnings,
      dom_snapshot: snapshot.dom_snapshot,
    };
  }

  peekFeedback(aiSessionId) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;
    return feedbackSnapshot(review);
  }

  ackFeedback(aiSessionId, snapshot) {
    const review = this._reviews.get(aiSessionId);
    if (!review || !snapshot) return null;

    const ack = snapshot._ack || {};
    const promptCount = Number.isFinite(ack.promptCount)
      ? Math.max(0, ack.promptCount)
      : cloneArray(snapshot.prompts).length;
    const promptsJson = typeof ack.promptsJson === 'string'
      ? ack.promptsJson
      : JSON.stringify(cloneArray(snapshot.prompts));
    if (promptCount > 0 && JSON.stringify(review.queuedPrompts.slice(0, promptCount)) === promptsJson) {
      review.queuedPrompts.splice(0, promptCount);
    }

    const warningsJson = typeof ack.warningsJson === 'string'
      ? ack.warningsJson
      : JSON.stringify(cloneArray(snapshot.layout_warnings));
    if (warningsJson !== '[]' && JSON.stringify(review.layoutWarnings || []) === warningsJson) {
      review.layoutWarnings = [];
    }

    review.updatedAt = nowIso();
    return review;
  }

  addAgentReply(aiSessionId, text) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    const reply = {
      role: 'agent',
      text: text == null ? '' : String(text),
      at: nowIso(),
    };
    review.chat.push(reply);
    review.updatedAt = nowIso();

    this.emit('agent-reply', { aiSessionId, text: reply.text, reply, review });
    return reply;
  }

  setPresence(aiSessionId, presence) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    review.presence = Object.assign({}, review.presence || {}, presence || {});
    review.updatedAt = nowIso();
    this.emit('presence', { aiSessionId, presence: review.presence, review });
    return review.presence;
  }

  end(aiSessionId) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    review.status = 'ended';
    review.updatedAt = nowIso();
    this.emit('ended', { aiSessionId, review });
    return review;
  }

  get(aiSessionId) {
    return this._reviews.get(aiSessionId) || null;
  }
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

function injectLavishSdk(html, options) {
  options = options || {};
  const sessionId = options.sessionId;
  const key = options.key;
  const assetBase = options.assetBase;
  const sdkSrc = options.sdkSrc;
  const eventsUrl = options.eventsUrl;
  const assetToken = options.assetToken;
  const config = {
    sessionId,
    key,
    assetBase,
    assetToken: assetToken || null,
    eventsUrl,
    promptsMessageType: 'artifact-prompts',
    layoutWarningsMessageType: 'artifact-layout-warnings',
  };
  const tags = [
    '<meta name="ai-or-die-artifact-review" content="' + escapeAttr(sessionId || '') + '">',
    assetBase ? '<base href="' + escapeAttr(assetBase) + '">' : '',
    '<script data-ai-or-die-artifact-config>window.__AI_OR_DIE_ARTIFACT_REVIEW__=' + safeJson(config) + ';</script>',
    sdkSrc ? '<script data-ai-or-die-artifact-sdk src="' + escapeAttr(sdkSrc) + '"></script>' : '',
  ].filter(Boolean).join('\n');

  if (typeof html !== 'string') html = String(html || '');
  if (html.includes('data-ai-or-die-artifact-sdk')) return html;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, '<head$1>\n' + tags + '\n');
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, '<html$1>\n<head>\n' + tags + '\n</head>\n');
  }
  return tags + '\n' + html;
}

function hasTraversalSegment(assetPath) {
  return String(assetPath).split(/[\\/]+/).some((segment) => segment === '..');
}

function isAbsoluteAssetPath(assetPath) {
  return path.isAbsolute(assetPath) ||
    path.posix.isAbsolute(assetPath) ||
    path.win32.isAbsolute(assetPath);
}

function decodeAssetPath(rawAssetPath) {
  let out = String(rawAssetPath || '');
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch (_) {
      break;
    }
  }
  return out;
}

function pathEscapes(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

function resolveArtifactAsset(reviewFile, rawAssetPath, validatePath) {
  const assetPath = decodeAssetPath(rawAssetPath);
  if (!assetPath || assetPath.includes('\0')) {
    return { valid: false, status: 403, error: 'Invalid asset path' };
  }
  if (isAbsoluteAssetPath(assetPath) || hasTraversalSegment(assetPath)) {
    return { valid: false, status: 403, error: 'Asset path escapes artifact directory' };
  }

  const baseDir = path.dirname(reviewFile);
  const resolvedAsset = path.resolve(baseDir, assetPath);
  if (pathEscapes(baseDir, resolvedAsset)) {
    return { valid: false, status: 403, error: 'Asset path escapes artifact directory' };
  }

  const validation = validatePath(resolvedAsset);
  if (!validation || !validation.valid) {
    return {
      valid: false,
      status: 403,
      error: (validation && validation.error) || 'Access denied',
    };
  }

  let realBase = baseDir;
  try {
    realBase = fs.realpathSync(baseDir);
  } catch (_) {
    realBase = path.resolve(baseDir);
  }
  if (pathEscapes(realBase, validation.path)) {
    return { valid: false, status: 403, error: 'Asset path escapes artifact directory' };
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(validation.path);
  } catch (_) {
    realTarget = validation.path;
  }
  if (pathEscapes(realBase, realTarget)) {
    return { valid: false, status: 403, error: 'Asset path escapes artifact directory' };
  }

  return { valid: true, path: realTarget };
}

function publicFeedback(snapshot) {
  const out = {
    prompts: cloneArray(snapshot && snapshot.prompts),
    layout_warnings: cloneArray(snapshot && snapshot.layout_warnings),
  };
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, 'dom_snapshot')) {
    out.dom_snapshot = snapshot.dom_snapshot;
  }
  return out;
}

function tokenQuery(req) {
  const token = req && req.query && req.query.token;
  if (!token || typeof token !== 'string') return '';
  return '?token=' + encodeURIComponent(token);
}

function artifactPath(sessionId, suffix, req) {
  return '/api/artifact/' + encodeURIComponent(sessionId) + suffix + tokenQuery(req);
}

function artifactAssetBase(sessionId, assetToken) {
  const base = '/api/artifact/' + encodeURIComponent(sessionId) + '/asset/';
  if (assetToken && typeof assetToken === 'string') {
    return base + '_auth/' + encodeURIComponent(assetToken) + '/';
  }
  return base;
}

function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  } catch (_) {
    return false;
  }
}

function assetTokenFromRawPath(rawAssetPath) {
  const raw = String(rawAssetPath || '');
  if (!raw.startsWith('_auth/')) return '';
  const rest = raw.slice('_auth/'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return '';
  return rest.slice(0, slash);
}

function stripAssetAuthPrefix(rawAssetPath, req) {
  const raw = String(rawAssetPath || '');
  if (!req || !req.artifactAssetPathToken || !raw.startsWith('_auth/')) return raw;
  const rest = raw.slice('_auth/'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return '';
  return rest.slice(slash + 1);
}

function pollPayload(review, snapshot, nextStep) {
  const feedback = publicFeedback(snapshot || {});
  const payload = {
    status: review ? review.status : 'missing',
    prompts: feedback.prompts,
    next_step: nextStep,
  };
  if (feedback.layout_warnings.length > 0 || nextStep !== 'poll') {
    payload.layout_warnings = feedback.layout_warnings;
  }
  if (Object.prototype.hasOwnProperty.call(feedback, 'dom_snapshot')) {
    payload.dom_snapshot = feedback.dom_snapshot;
  }
  return payload;
}

function sendJsonWithAck(res, store, sessionId, payload, snapshot) {
  if (snapshot && feedbackHasData(snapshot)) {
    res.once('finish', () => {
      store.ackFeedback(sessionId, snapshot);
    });
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.end(JSON.stringify(payload));
}

function createArtifactReviewRouter(options) {
  options = options || {};
  const store = options.store;
  const validatePath = options.validatePath;
  const mintAssetToken = options.mintAssetToken;
  const broadcastToSession = typeof options.broadcastToSession === 'function'
    ? options.broadcastToSession
    : () => {};
  const pollHoldMs = typeof options.pollHoldMs === 'number'
    ? options.pollHoldMs
    : DEFAULT_POLL_HOLD_MS;
  const pollHeartbeatMs = typeof options.pollHeartbeatMs === 'number'
    ? options.pollHeartbeatMs
    : DEFAULT_POLL_HEARTBEAT_MS;
  const sseHeartbeatMs = typeof options.sseHeartbeatMs === 'number'
    ? options.sseHeartbeatMs
    : DEFAULT_SSE_HEARTBEAT_MS;

  if (!store) throw new TypeError('Artifact review store is required');
  if (typeof validatePath !== 'function') throw new TypeError('validatePath is required');
  if (typeof mintAssetToken !== 'function') throw new TypeError('mintAssetToken is required');

  // Auto live-reload: one chokidar watcher per session, scoped to the canonical
  // artifact file. On a settled write we broadcast a reload SIGNAL (the panel
  // cache-busts the iframe; the feedback box lives outside it and survives).
  // Capped, replaced on re-open, and torn down on /end. Best-effort: chokidar
  // is loaded lazily so tests/headless runs without it degrade to no reload.
  const MAX_WATCHERS = 64;
  const watchers = new Map(); // sessionId -> { watcher, file }
  function stopWatch(sessionId) {
    const w = watchers.get(sessionId);
    if (!w) return;
    watchers.delete(sessionId);
    try { w.watcher.close(); } catch (_) { /* already closed */ }
  }
  function startWatch(sessionId, file) {
    const existing = watchers.get(sessionId);
    if (existing) { if (existing.file === file) return; stopWatch(sessionId); }
    if (watchers.size >= MAX_WATCHERS) { const first = watchers.keys().next().value; if (first) stopWatch(first); }
    let chokidar;
    try { chokidar = require('chokidar'); } catch (_) { return; }
    let watcher;
    try {
      watcher = chokidar.watch(file, {
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 30 },
      });
    } catch (_) { return; }
    const onChange = () => {
      if (!store.get(sessionId)) { stopWatch(sessionId); return; }
      broadcastToSession(sessionId, { type: 'artifact_review_reload', sessionId });
    };
    watcher.on('change', onChange);
    watcher.on('add', onChange);
    watcher.on('error', () => stopWatch(sessionId));
    watchers.set(sessionId, { watcher, file });
  }

  const router = express.Router();


  router.post('/:sessionId/open', (req, res) => {
    const sessionId = req.params.sessionId;
    const file = req.body && req.body.file;
    if (!file || typeof file !== 'string') {
      return res.status(400).json({ error: 'file is required' });
    }

    const validation = validatePath(file);
    if (!validation || !validation.valid) {
      return res.status(403).json({ error: (validation && validation.error) || 'Access denied' });
    }

    try {
      const stat = fs.statSync(validation.path);
      if (!stat.isFile()) return res.status(400).json({ error: 'file must be a regular file' });
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
      return res.status(500).json({ error: 'stat failed', message: err.message });
    }

    const review = store.open(sessionId, validation.path);
    startWatch(sessionId, validation.path);
    const viewUrl = artifactPath(sessionId, '/view', req);
    broadcastToSession(sessionId, {
      type: 'artifact_review_opened',
      sessionId,
      key: review.key,
      file: review.file,
      viewUrl,
    });
    res.json({ sessionId, key: review.key, viewUrl });
  });

  router.get('/:sessionId/view', (req, res) => {
    const sessionId = req.params.sessionId;
    const review = store.get(sessionId);
    if (!review) return res.status(404).json({ error: 'artifact review not found' });

    const validation = validatePath(review.file);
    if (!validation || !validation.valid) {
      return res.status(403).json({ error: (validation && validation.error) || 'Access denied' });
    }

    let html;
    try {
      const stat = fs.statSync(validation.path);
      if (!stat.isFile()) return res.status(400).json({ error: 'file must be a regular file' });
      html = fs.readFileSync(validation.path, 'utf8');
      review.file = validation.path;
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
      return res.status(500).json({ error: 'read failed', message: err.message });
    }

    const assetToken = mintAssetToken(sessionId);
    const injected = injectLavishSdk(html, {
      sessionId,
      key: review.key,
      assetBase: artifactAssetBase(sessionId, assetToken),
      assetToken,
      sdkSrc: artifactPath(sessionId, '/sdk.js', req),
      eventsUrl: artifactPath(sessionId, '/events', req),
    });
    store.setPresence(sessionId, { viewedAt: nowIso() });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  });

  router.get('/:sessionId/sdk.js', (req, res) => {
    const review = store.get(req.params.sessionId);
    if (!review) return res.status(404).type('text/plain').send('artifact review not found');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'artifact-sdk-client.js'));
  });

  router.get('/:sessionId/asset/*', (req, res) => {
    const sessionId = req.params.sessionId;
    const review = store.get(sessionId);
    if (!review) return res.status(404).json({ error: 'artifact review not found' });

    const fileValidation = validatePath(review.file);
    if (!fileValidation || !fileValidation.valid) {
      return res.status(403).json({ error: (fileValidation && fileValidation.error) || 'Access denied' });
    }

    const rawAssetPath = String(req.params[0] || '');
    if (rawAssetPath.startsWith('_auth/')) {
      const assetToken = assetTokenFromRawPath(rawAssetPath);
      if (!assetToken ||
          !req.artifactAssetPathToken ||
          !safeEqualString(assetToken, req.artifactAssetPathToken) ||
          !safeEqualString(assetToken, mintAssetToken(sessionId))) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const assetPath = stripAssetAuthPrefix(rawAssetPath, req);
    const resolved = resolveArtifactAsset(fileValidation.path, assetPath, validatePath);
    if (!resolved.valid) {
      return res.status(resolved.status || 403).json({ error: resolved.error || 'Access denied' });
    }

    try {
      const stat = fs.statSync(resolved.path);
      if (!stat.isFile()) return res.status(404).json({ error: 'asset not found' });
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'asset not found' });
      return res.status(500).json({ error: 'stat failed', message: err.message });
    }
    res.sendFile(resolved.path);
  });

  router.post('/:sessionId/prompts', (req, res) => {
    const sessionId = req.params.sessionId;
    if (!store.get(sessionId)) return res.status(404).json({ error: 'artifact review not found' });

    const prompts = req.body && req.body.prompts;
    if (!Array.isArray(prompts)) return res.status(400).json({ error: 'prompts must be an array' });

    const review = store.queuePrompts(sessionId, prompts, req.body ? req.body.domSnapshot : undefined);
    res.json({ ok: true, queued: review ? review.queuedPrompts.length : 0 });
  });

  router.post('/:sessionId/layout-warnings', (req, res) => {
    const sessionId = req.params.sessionId;
    if (!store.get(sessionId)) return res.status(404).json({ error: 'artifact review not found' });

    const warnings = req.body && req.body.layout_warnings;
    if (!Array.isArray(warnings)) return res.status(400).json({ error: 'layout_warnings must be an array' });

    const result = store.recordLayoutWarnings(sessionId, warnings);
    res.json({ ok: true, changed: !!(result && result.changed) });
  });

  router.get('/:sessionId/events', (req, res) => {
    const sessionId = req.params.sessionId;
    if (!store.get(sessionId)) return res.status(404).json({ error: 'artifact review not found' });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    function send(event, obj) {
      if (closed) return;
      try {
        res.write('event: ' + event + '\n');
        res.write('data: ' + JSON.stringify(obj) + '\n\n');
      } catch (_) {
        cleanup();
      }
    }
    function onAgentReply(evt) {
      if (!evt || evt.aiSessionId !== sessionId) return;
      send('agent-reply', { type: 'agent-reply', text: evt.text, reply: evt.reply });
    }
    function onPresence(evt) {
      if (!evt || evt.aiSessionId !== sessionId) return;
      send('presence', { type: 'presence', presence: evt.presence });
    }
    function onEnded(evt) {
      if (!evt || evt.aiSessionId !== sessionId) return;
      send('ended', { type: 'ended', status: 'ended' });
      cleanup();
      try { res.end(); } catch (_) { /* ignore */ }
    }
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      store.removeListener('agent-reply', onAgentReply);
      store.removeListener('presence', onPresence);
      store.removeListener('ended', onEnded);
    }

    store.on('agent-reply', onAgentReply);
    store.on('presence', onPresence);
    store.on('ended', onEnded);
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (_) { cleanup(); }
    }, sseHeartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const presence = store.setPresence(sessionId, { connected: true, lastSeen: nowIso() });
    send('presence', { type: 'presence', presence });

    req.on('close', () => {
      cleanup();
      store.setPresence(sessionId, { connected: false, lastSeen: nowIso() });
    });
  });

  router.post('/:sessionId/end', (req, res) => {
    const sessionId = req.params.sessionId;
    const review = store.end(sessionId);
    stopWatch(sessionId);
    if (!review) return res.status(404).json({ error: 'artifact review not found' });
    broadcastToSession(sessionId, { type: 'artifact_review_ended', sessionId });
    res.json({ ok: true, status: review.status });
  });

  router.get('/:sessionId/poll', (req, res) => {
    const sessionId = req.params.sessionId;
    const review = store.get(sessionId);
    if (!review) return res.status(404).json({ error: 'artifact review not found' });

    const immediate = store.peekFeedback(sessionId);
    if (feedbackHasData(immediate)) {
      return sendJsonWithAck(
        res,
        store,
        sessionId,
        pollPayload(review, immediate, 'review_feedback'),
        immediate
      );
    }
    if (review.status === 'ended') {
      return sendJsonWithAck(res, store, sessionId, pollPayload(review, null, 'ended'), null);
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let done = false;
    let snapshotToAck = null;
    let timeout = null;
    let heartbeat = null;
    function cleanup() {
      if (timeout) clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      store.removeListener('feedback', onFeedback);
      store.removeListener('ended', onEnded);
    }
    function finish(payload, snapshot) {
      if (done) return;
      done = true;
      snapshotToAck = snapshot || null;
      cleanup();
      try { res.end(JSON.stringify(payload)); } catch (_) { /* client already gone */ }
    }
    function onFeedback(evt) {
      if (!evt || evt.aiSessionId !== sessionId) return;
      const snapshot = store.peekFeedback(sessionId);
      if (!feedbackHasData(snapshot)) return;
      const current = store.get(sessionId) || review;
      finish(pollPayload(current, snapshot, 'review_feedback'), snapshot);
    }
    function onEnded(evt) {
      if (!evt || evt.aiSessionId !== sessionId) return;
      const current = store.get(sessionId) || review;
      finish(pollPayload(current, null, 'ended'), null);
    }

    res.once('finish', () => {
      if (snapshotToAck && feedbackHasData(snapshotToAck)) {
        store.ackFeedback(sessionId, snapshotToAck);
      }
      cleanup();
    });
    req.once('close', () => {
      if (!done) cleanup();
    });

    timeout = setTimeout(() => {
      const current = store.get(sessionId) || review;
      finish(pollPayload(current, null, 'poll'), null);
    }, pollHoldMs);
    heartbeat = setInterval(() => {
      try { res.write(' '); } catch (_) { cleanup(); }
    }, pollHeartbeatMs);
    if (typeof timeout.unref === 'function') timeout.unref();
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    store.on('feedback', onFeedback);
    store.on('ended', onEnded);
  });

  router.post('/:sessionId/agent-reply', (req, res) => {
    const sessionId = req.params.sessionId;
    if (!store.get(sessionId)) return res.status(404).json({ error: 'artifact review not found' });

    const text = req.body && req.body.text;
    if (typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

    const reply = store.addAgentReply(sessionId, text);
    broadcastToSession(sessionId, { type: 'artifact_agent_reply', sessionId, text });
    res.json({ ok: true, reply });
  });

  return router;
}

module.exports = {
  ArtifactReviewStore,
  artifactKeyForFile,
  createAssetTokenSigner,
  createArtifactReviewRouter,
  feedbackHasData,
  injectLavishSdk,
  resolveArtifactAsset,
};
