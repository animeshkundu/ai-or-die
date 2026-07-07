'use strict';

// Express router for the fleet control plane: GET /api/control/* on each
// ai-or-die instance. The github-router `fleet` MCP group calls these over the
// instance's authed tunnel (the router is mounted AFTER server.js's Bearer
// middleware, so every route here is already token-gated).
//
// Decoupled from server.js by an injected `deps` object so it unit-tests without
// a live PTY (see test/control/routes.test.js):
//   deps.sessions               Map<id, session>  (this.claudeSessions)
//   deps.getStatusSignal(id)    -> { jsonl, renderedTail, exit, hadOutput }  (server-computed)
//   deps.readTail(id, lines)    -> Promise<{ text, truncated, source }>
//   deps.readMessages(id, cursor, limit) -> Promise<{ bound, items, cursor, epoch, reset, more }>
//   deps.eventBus               ControlEventBus
//   deps.createSession(opts)    -> Promise<{ sessionId, lifecycle }>
//   deps.stopSession(id, mode, idempotencyKey) -> Promise<{ stopped, lifecycle }>
//   deps.sendMessage(opts)      -> Promise<object>
//   deps.sendKeys(opts)         -> Promise<object>
//   deps.respond(opts)          -> Promise<object>

const express = require('express');
const { DecisionStore } = require('./decision-store');
const { deriveStatus } = require('./session-status');

const DEFAULT_READ_LINES = 80;
const MAX_READ_LINES = 2000;
const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LIMIT = 1000;
const DEFAULT_EVENTS_TIMEOUT_MS = 25000;
const MAX_EVENTS_TIMEOUT_MS = 60000;
const DEFAULT_DECISION_AWAIT_TIMEOUT_MS = 25000;
const MAX_DECISION_AWAIT_TIMEOUT_MS = 60000;
const ROUTE_IDEMPOTENCY_CAP = 500;
const DEFAULT_RATE_LIMIT_MAX = 600;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_IDENTITY_CAP = 2000;

function statusForSession(deps, id, session) {
  const signal = (deps.getStatusSignal && deps.getStatusSignal(id)) || {};
  if (signal && typeof signal.then === 'function') {
    return signal.then((resolved) => deriveStatusForSignal(resolved || {}, session));
  }
  return deriveStatusForSignal(signal, session);
}

function deriveStatusForSignal(signal, session) {
  return deriveStatus({
    session: { ...session, hadOutput: signal.hadOutput },
    jsonl: signal.jsonl,
    renderedTail: signal.renderedTail,
    exit: signal.exit,
  });
}

function sessionSummary(deps, id, session) {
  const status = statusForSession(deps, id, session);
  if (status && typeof status.then === 'function') return status.then((resolved) => summaryFromStatus(id, session, resolved));
  return summaryFromStatus(id, session, status);
}

function summaryFromStatus(id, session, status) {
  return {
    sessionId: id,
    name: session.name,
    agent: session.agent || null,
    workingDir: session.workingDir,
    lifecycle: status.lifecycle,
    interactionState: status.interactionState,
    canAcceptInput: status.canAcceptInput,
    lastActivity: session.lastActivity,
  };
}

function parseCursor(raw) {
  if (!raw) return undefined;
  // Accept either "epoch:seq" or a base64url JSON blob. A valid seq is a
  // non-negative safe integer (FIX C: reject -5, 1.5, NaN so a present-but-invalid
  // cursor is a client bug surfaced as 400, not a silent fresh tail-follow).
  if (typeof raw === 'string' && raw.includes(':')) {
    const idx = raw.lastIndexOf(':');
    const epoch = raw.slice(0, idx);
    const seq = Number(raw.slice(idx + 1));
    if (epoch && Number.isSafeInteger(seq) && seq >= 0) return { epoch, seq };
  }
  try {
    const obj = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
    if (obj && typeof obj.epoch === 'string' && Number.isSafeInteger(obj.seq) && obj.seq >= 0) return obj;
  } catch {
    /* fall through */
  }
  return undefined;
}

function encodeCursor(cursor) {
  return `${cursor.epoch}:${cursor.seq}`;
}

function parseTurnCursor(raw) {
  if (!raw) return undefined;
  if (typeof raw === 'object') return normalizeTurnCursor(raw);
  const s = String(raw).trim();
  if (!s) return undefined;

  if (s[0] === '{') {
    try { return normalizeTurnCursor(JSON.parse(s)); } catch (_) { return undefined; }
  }

  if (s.includes(':')) {
    const idx = s.lastIndexOf(':');
    const epoch = s.slice(0, idx);
    const offset = Number(s.slice(idx + 1));
    if (epoch && Number.isSafeInteger(offset) && offset >= 0) return { epoch, offset };
  }

  try {
    const obj = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
    return normalizeTurnCursor(obj);
  } catch {
    return undefined;
  }
}

function normalizeTurnCursor(obj) {
  if (!obj || typeof obj.epoch !== 'string') return undefined;
  const offset = Number(obj.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  return { epoch: obj.epoch, offset };
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizeRateLimit(raw) {
  raw = raw || {};
  return {
    max: clampInt(raw.max, DEFAULT_RATE_LIMIT_MAX, 0, Number.MAX_SAFE_INTEGER),
    windowMs: clampInt(raw.windowMs, DEFAULT_RATE_LIMIT_WINDOW_MS, 0, Number.MAX_SAFE_INTEGER),
  };
}

function isRateLimitExempt(req) {
  if (req.method !== 'GET') return false;
  const path = String(req.path || req.url || '').split('?')[0];
  const originalPath = String(req.originalUrl || '').split('?')[0];
  return path === '/events' || originalPath.endsWith('/api/control/events');
}

function bearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header) return null;
  const value = String(Array.isArray(header) ? header[0] : header).trim();
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return (match ? match[1] : value).trim() || null;
}

function rateLimitIdentity(req) {
  const bearer = bearerToken(req);
  if (bearer) return `token:${bearer}`;
  if (req.query && req.query.token) return `token:${String(req.query.token)}`;
  return `ip:${req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'}`;
}

function checkRateLimit(buckets, limit, identity) {
  const now = Date.now();
  const cutoff = now - limit.windowMs;
  pruneRateLimitBuckets(buckets, cutoff);

  const bucket = buckets.get(identity) || [];
  if (bucket.length >= limit.max) {
    return { retryAfterMs: Math.max(1, bucket[0] + limit.windowMs - now) };
  }

  bucket.push(now);
  buckets.delete(identity);
  buckets.set(identity, bucket);
  while (buckets.size > RATE_LIMIT_IDENTITY_CAP) buckets.delete(buckets.keys().next().value);
  return null;
}

function pruneRateLimitBuckets(buckets, cutoff) {
  for (const [identity, bucket] of buckets) {
    while (bucket.length && bucket[0] <= cutoff) bucket.shift();
    if (!bucket.length) buckets.delete(identity);
  }
}

function createControlRouter(deps) {
  const router = express.Router();
  const routeIdempotency = new Map();
  const rateLimitBuckets = new Map();
  const rateLimit = normalizeRateLimit(deps.rateLimit);
  const decisionStore = deps.decisionStore || new DecisionStore({ eventBus: deps.eventBus });

  router.use((req, res, next) => {
    if (isRateLimitExempt(req) || !rateLimit.max || !rateLimit.windowMs) return next();
    const limited = checkRateLimit(rateLimitBuckets, rateLimit, rateLimitIdentity(req));
    if (limited) {
      // F21: a CLASSIFIABLE 429 so the fleet client can back off precisely rather
      // than hammer. Stable error.code='RATE_LIMITED' + retryAfterMs in the body,
      // and the standard Retry-After header (whole seconds, min 1).
      const retryAfterSec = Math.max(1, Math.ceil(limited.retryAfterMs / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many control requests; retry after the current rate-limit window',
          retryAfterMs: limited.retryAfterMs,
          retryAfterSec,
        },
      });
    }
    next();
  });

  // GET /capabilities — F19 cross-repo capability negotiation. The fleet client
  // reads this ONCE per instance and fails closed on a missing capability, so a
  // newer client never silently assumes an older instance supports a field/event.
  router.get('/capabilities', (req, res, next) => {
    try {
      res.json(deps.capabilities ? deps.capabilities() : { capabilities: [], controlVersion: '0' });
    } catch (err) {
      next(err);
    }
  });

  router.get('/mesh/peers', (req, res) => {
    res.json({ peers: deps.getMeshPeers ? deps.getMeshPeers() : [] });
  });

  // GET /snapshot — F15 atomic batch resync. Returns every session's derived
  // status PLUS the event cursor, captured atomically (cursor first, then
  // statuses), so after a gap/overflow the controller resyncs in ONE call and
  // resumes the long-poll from `cursor` with zero lost events (a boundary event
  // may be redelivered — safe/idempotent — but never dropped).
  router.get('/snapshot', async (req, res, next) => {
    try {
      const snap = deps.snapshot ? await deps.snapshot() : { sessions: [], cursor: null, capturedAt: Date.now() };
      res.json({
        sessions: snap.sessions || [],
        cursor: snap.cursor ? encodeCursor(snap.cursor) : null,
        capturedAt: snap.capturedAt,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /sessions — list with derived status (light).
  router.get('/sessions', async (req, res, next) => {
    try {
      const sessions = [];
      for (const [id, session] of deps.sessions) sessions.push(await sessionSummary(deps, id, session));
      res.json({ sessions });
    } catch (err) {
      next(err);
    }
  });

  // GET /sessions/:id/status — canonical state (the lines=0 case).
  router.get('/sessions/:id/status', async (req, res, next) => {
    try {
      const session = deps.sessions.get(req.params.id);
      if (!session) return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } });
      res.json({ sessionId: req.params.id, status: await statusForSession(deps, req.params.id, session) });
    } catch (err) {
      next(err);
    }
  });

  // GET /sessions/:id/read?lines=80 — plain-text tail + status.
  router.get('/sessions/:id/read', async (req, res, next) => {
    try {
      const id = req.params.id;
      const session = deps.sessions.get(id);
      if (!session) return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } });
      const lines = clampInt(req.query.lines, DEFAULT_READ_LINES, 0, MAX_READ_LINES);
      const status = await statusForSession(deps, id, session);
      if (lines === 0) return res.json({ sessionId: id, text: '', truncated: false, source: 'none', status });
      const tail = await deps.readTail(id, lines);
      res.json({ sessionId: id, text: tail.text, truncated: !!tail.truncated, source: tail.source, status });
    } catch (err) {
      next(err);
    }
  });

  // GET /sessions/:id/messages?after=&limit= — durable semantic transcript stream.
  router.get('/sessions/:id/messages', async (req, res, next) => {
    try {
      const id = req.params.id;
      const session = deps.sessions.get(id);
      if (!session) return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } });
      const after = parseTurnCursor(req.query.after);
      if (req.query.after && after === undefined) {
        return res.status(400).json({ error: { code: 'INVALID_ARGUMENT', message: 'invalid cursor' } });
      }
      const limit = clampInt(req.query.limit, DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT);
      const out = deps.readMessages
        ? await deps.readMessages(id, after, limit)
        : { bound: false, items: [], cursor: null, epoch: null, reset: false, more: false };
      res.json({
        sessionId: id,
        bound: !!out.bound,
        items: out.items || [],
        cursor: out.cursor || null,
        epoch: out.epoch || null,
        reset: !!out.reset,
        more: !!out.more,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /sessions/create
  router.post('/sessions/create', async (req, res, next) => {
    try {
      const out = await deps.createSession(req.body || {});
      res.json(out);
    } catch (err) {
      if (err && err.code === 'INVALID_WORKDIR') {
        return res.status(403).json({ error: { code: 'CAPABILITY_DENIED', message: err.message } });
      }
      if (err && err.code) {
        return res.status(err.statusCode || statusForErrorCode(err.code)).json({
          error: { code: err.code, message: err.message },
        });
      }
      next(err);
    }
  });

  // POST /sessions/:id/stop
  router.post('/sessions/:id/stop', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!deps.sessions.has(id)) {
        return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } });
      }
      const mode = req.body && req.body.mode === 'kill' ? 'kill' : 'graceful';
      const out = await deps.stopSession(id, mode, req.body && req.body.idempotencyKey);
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  // POST /sessions/:id/decision — register a structured mobile-mode decision.
  router.post('/sessions/:id/decision', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!deps.sessions.has(id)) {
        return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } });
      }
      const body = req.body || {};
      const out = await routeIdempotent(routeIdempotency, 'decision', id, body.idempotencyKey, () => {
        const decision = decisionStore.register(id, body);
        if (deps.eventBus) deps.eventBus.append(id, 'decision_pending', decision);
        return { decisionId: decision.decisionId };
      });
      sendControlResult(res, out);
    } catch (err) {
      sendControlError(res, next, err);
    }
  });

  // GET /sessions/:id/decisions — currently pending structured decisions.
  router.get('/sessions/:id/decisions', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!deps.sessions.has(id)) {
        return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } });
      }
      res.json({ decisions: decisionStore.listPending(id) });
    } catch (err) {
      sendControlError(res, next, err);
    }
  });

  // POST /sessions/:id/message — send a user message and optionally await a turn end.
  router.post('/sessions/:id/message', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!deps.sessions.has(id)) {
        return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } });
      }
      const body = req.body || {};
      const out = await routeIdempotent(routeIdempotency, 'message', id, body.idempotencyKey, () =>
        deps.sendMessage({
          sessionId: id,
          message: body.message,
          idempotencyKey: body.idempotencyKey,
          awaitMs: body.awaitMs,
        })
      );
      sendControlResult(res, out);
    } catch (err) {
      sendControlError(res, next, err);
    }
  });

  // POST /sessions/:id/keys — send raw or named key input.
  router.post('/sessions/:id/keys', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!deps.sessions.has(id)) {
        return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } });
      }
      const body = req.body || {};
      const out = await routeIdempotent(routeIdempotency, 'keys', id, body.idempotencyKey, () =>
        deps.sendKeys({
          sessionId: id,
          keys: body.keys,
          idempotencyKey: body.idempotencyKey,
          raw: body.raw,
        })
      );
      sendControlResult(res, out);
    } catch (err) {
      sendControlError(res, next, err);
    }
  });

  // POST /sessions/:id/respond — answer the currently pending interaction.
  router.post('/sessions/:id/respond', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!deps.sessions.has(id)) {
        return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Unknown session' } });
      }
      const body = req.body || {};
      const out = await routeIdempotent(routeIdempotency, 'respond', id, body.idempotencyKey, () =>
        deps.respond({
          sessionId: id,
          choice: body.choice,
          optionValue: body.optionValue,
          keys: body.keys,
          idempotencyKey: body.idempotencyKey,
        })
      );
      sendControlResult(res, out);
    } catch (err) {
      sendControlError(res, next, err);
    }
  });

  // POST /decisions/:decisionId/answer — structured answer from a human client.
  router.post('/decisions/:decisionId/answer', async (req, res, next) => {
    try {
      const out = decisionStore.answer(req.params.decisionId, req.body || {});
      res.json(out);
    } catch (err) {
      sendControlError(res, next, err);
    }
  });

  // GET /decisions/:decisionId/await?timeoutMs= — bounded long-poll for a structured answer.
  router.get('/decisions/:decisionId/await', async (req, res, next) => {
    const controller = new AbortController();
    let responseOpen = true;
    const onClose = () => {
      if (responseOpen) controller.abort();
    };
    res.once('close', onClose);
    try {
      const timeoutMs = clampInt(req.query.timeoutMs, DEFAULT_DECISION_AWAIT_TIMEOUT_MS, 0, MAX_DECISION_AWAIT_TIMEOUT_MS);
      const out = await decisionStore.awaitAnswer(req.params.decisionId, timeoutMs, { signal: controller.signal });
      responseOpen = false;
      res.removeListener('close', onClose);
      if (!out || out.status === 'missing') {
        return res.status(404).json({ error: { code: 'DECISION_NOT_FOUND', message: 'Unknown or expired decision' } });
      }
      if (out.status === 'canceled') return;
      if (out.status === 'answered') {
        return res.json(Object.assign({ answered: true }, out.decision || {}));
      }
      const viewers = deps.getSessionViewerCount ? deps.getSessionViewerCount(out.sessionId) : 0;
      res.json({ answered: false, viewers });
    } catch (err) {
      responseOpen = false;
      res.removeListener('close', onClose);
      sendControlError(res, next, err);
    }
  });

  // GET /events?cursor=&timeoutMs= — long-poll (the await_turn backend).
  router.get('/events', async (req, res, next) => {
    try {
      const cursor = parseCursor(req.query.cursor);
      // FIX C: ABSENT cursor → fresh watcher (ok); PRESENT-but-INVALID → client bug.
      if (req.query.cursor && cursor === undefined) {
        return res.status(400).json({ error: { code: 'INVALID_ARGUMENT', message: 'invalid cursor' } });
      }
      const timeoutMs = clampInt(req.query.timeoutMs, DEFAULT_EVENTS_TIMEOUT_MS, 0, MAX_EVENTS_TIMEOUT_MS);
      const filter = {};
      if (req.query.sessionIds) filter.sessionIds = String(req.query.sessionIds).split(',').filter(Boolean);
      if (req.query.kinds) filter.kinds = String(req.query.kinds).split(',').filter(Boolean);
      const out = await deps.eventBus.waitFor(cursor, timeoutMs, filter);
      res.json({ events: out.events, gaps: out.gaps, cursor: encodeCursor(out.cursor), more: out.more });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function routeIdempotent(cache, kind, sessionId, idempotencyKey, fn) {
  const key = idempotencyKey ? `${kind}:${sessionId}:${idempotencyKey}` : null;
  if (key && cache.has(key)) return Promise.resolve({ ...cache.get(key), duplicated: true });
  return Promise.resolve()
    .then(fn)
    .then((out) => {
      if (key && !(out && out.error)) {
        cache.set(key, { ...out, duplicated: false });
        trimCache(cache, ROUTE_IDEMPOTENCY_CAP);
      }
      return out;
    });
}

function trimCache(cache, cap) {
  while (cache.size > cap) cache.delete(cache.keys().next().value);
}

function sendControlResult(res, out) {
  if (out && out.error) {
    return res.status(statusForErrorCode(out.error.code)).json(out);
  }
  res.json(out);
}

function sendControlError(res, next, err) {
  const status = (err && (err.statusCode || err.status)) || null;
  const code = err && err.code;
  if (status || code === 'SESSION_NOT_FOUND' || code === 'PRECONDITION_FAILED' || code === 'INVALID_ARGUMENT') {
    return res.status(status || statusForErrorCode(code)).json({
      error: {
        code: code || 'ERROR',
        message: (err && err.message) || 'Request failed',
      },
    });
  }
  next(err);
}

function statusForErrorCode(code) {
  if (code === 'SESSION_NOT_FOUND') return 404;
  if (code === 'PRECONDITION_FAILED') return 409;
  if (code === 'INVALID_ARGUMENT') return 400;
  return 500;
}

module.exports = { createControlRouter, parseCursor, encodeCursor, sessionSummary, statusForSession };
