'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const DEFAULT_DECISION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const DECISION_KINDS = Object.freeze([
  'tool_approval',
  'plan_approval',
  'choice_question',
]);
const SESSION_CLEAR_EVENT_KINDS = new Set(['exited', 'crashed', 'session_deleted']);

class DecisionStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(0);
    this._ttlMs = positiveInt(options.ttlMs, DEFAULT_DECISION_TTL_MS);
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this._byId = new Map();
    this._bySession = new Map();

    const cleanupIntervalMs = positiveInt(options.cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS);
    this._cleanupTimer = cleanupIntervalMs > 0
      ? setInterval(() => this.cleanupExpired(), cleanupIntervalMs)
      : null;
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref();

    this._eventBus = null;
    this._onControlEvent = null;
    if (options.eventBus) this.attachEventBus(options.eventBus);
  }

  attachEventBus(eventBus) {
    if (!eventBus || typeof eventBus.on !== 'function') return;
    if (this._eventBus && this._onControlEvent && typeof this._eventBus.removeListener === 'function') {
      this._eventBus.removeListener('event', this._onControlEvent);
    }
    this._eventBus = eventBus;
    this._onControlEvent = (event) => {
      if (!event || !event.sessionId || !SESSION_CLEAR_EVENT_KINDS.has(event.kind)) return;
      this.clearSession(event.sessionId);
    };
    eventBus.on('event', this._onControlEvent);
  }

  close() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = null;
    if (this._eventBus && this._onControlEvent && typeof this._eventBus.removeListener === 'function') {
      this._eventBus.removeListener('event', this._onControlEvent);
    }
    this._eventBus = null;
    this._onControlEvent = null;
    for (const record of this._byId.values()) {
      this._finishWaiters(record, { status: 'missing' });
    }
    this._byId.clear();
    this._bySession.clear();
  }

  register(sessionId, request) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw controlError('INVALID_ARGUMENT', 'sessionId is required', 400);
    }
    this.cleanupExpired();
    const normalized = normalizeDecisionRequest(request || {});
    const now = this._now();
    const decisionId = this._newDecisionId();
    const record = {
      decisionId,
      sessionId,
      kind: normalized.kind,
      request: normalized,
      status: 'pending',
      answer: null,
      createdAt: now,
      expiresAt: now + this._ttlMs,
      answeredAt: null,
      waiters: new Set(),
    };
    this._byId.set(decisionId, record);
    let ids = this._bySession.get(sessionId);
    if (!ids) {
      ids = new Set();
      this._bySession.set(sessionId, ids);
    }
    ids.add(decisionId);
    this.emit('registered', this.snapshot(record));
    return this.snapshot(record);
  }

  listPending(sessionId) {
    this.cleanupExpired();
    const ids = this._bySession.get(sessionId);
    if (!ids) return [];
    const out = [];
    for (const decisionId of ids) {
      const record = this._byId.get(decisionId);
      if (record && record.status === 'pending') out.push(this.snapshot(record));
    }
    out.sort((a, b) => a.createdAt - b.createdAt || a.decisionId.localeCompare(b.decisionId));
    return out;
  }

  get(decisionId) {
    this.cleanupExpired();
    const record = this._byId.get(decisionId);
    return record ? this.snapshot(record) : null;
  }

  answer(decisionId, body) {
    this.cleanupExpired();
    const record = this._byId.get(decisionId);
    if (!record) throw controlError('DECISION_NOT_FOUND', 'Unknown or expired decision', 404);
    if (record.status !== 'pending') {
      throw controlError('PRECONDITION_FAILED', 'Decision has already been answered', 409);
    }

    const answer = normalizeAnswer(body || {});
    const now = this._now();
    record.status = 'answered';
    record.answer = answer;
    record.answeredAt = now;
    // Keep the answered tombstone long enough for racing await/retry callers to
    // observe the first answer / 409, while removing it from the pending list.
    record.expiresAt = Math.max(record.expiresAt, now + this._ttlMs);
    const payload = { status: 'answered', decision: this.answerSnapshot(record), sessionId: record.sessionId };
    this._finishWaiters(record, payload);
    this.emit('answered', this.snapshot(record));
    return { ok: true };
  }

  // Mark every pending decision for a session as resolved EXTERNALLY — the human
  // answered Claude's native prompt directly (the desktop terminal), signalled by
  // the tool actually running (PostToolUse). No keystroke is injected (the native
  // answer already drove the terminal); this only clears the mirrored card and
  // stops the decision from resurfacing on a later /decisions poll. Claude prompts
  // serially, so at most one decision is pending. Returns the resolved ids.
  externalResolve(sessionId, reason) {
    this.cleanupExpired();
    const ids = this._bySession.get(sessionId);
    if (!ids) return [];
    const resolved = [];
    const now = this._now();
    for (const decisionId of Array.from(ids)) {
      const record = this._byId.get(decisionId);
      if (!record || record.status !== 'pending') continue;
      record.status = 'answered';
      record.answer = { external: true, reason: reason || 'resolved' };
      record.answeredAt = now;
      record.expiresAt = Math.max(record.expiresAt, now + this._ttlMs);
      this._finishWaiters(record, { status: 'answered', decision: this.answerSnapshot(record), sessionId: record.sessionId });
      this.emit('answered', this.snapshot(record));
      resolved.push(decisionId);
    }
    return resolved;
  }

  awaitAnswer(decisionId, timeoutMs, options = {}) {
    this.cleanupExpired();
    const record = this._byId.get(decisionId);
    if (!record) return Promise.resolve({ status: 'missing' });
    if (record.status === 'answered') {
      return Promise.resolve({ status: 'answered', decision: this.answerSnapshot(record), sessionId: record.sessionId });
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve({ status: 'timeout', sessionId: record.sessionId });
    }

    const signal = options.signal;
    if (signal && signal.aborted) return Promise.resolve({ status: 'canceled', sessionId: record.sessionId });

    return new Promise((resolve) => {
      let settled = false;
      const waiter = { resolve: null, timer: null, onAbort: null, signal };
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        record.waiters.delete(waiter);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort && typeof waiter.signal.removeEventListener === 'function') {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
        resolve(payload);
      };
      waiter.resolve = finish;
      waiter.timer = setTimeout(() => finish({ status: 'timeout', sessionId: record.sessionId }), Math.trunc(timeoutMs));
      if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
      if (signal && typeof signal.addEventListener === 'function') {
        waiter.onAbort = () => finish({ status: 'canceled', sessionId: record.sessionId });
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      record.waiters.add(waiter);
    });
  }

  clearSession(sessionId) {
    const ids = this._bySession.get(sessionId);
    if (!ids) return 0;
    let count = 0;
    for (const decisionId of Array.from(ids)) {
      const record = this._byId.get(decisionId);
      if (record) {
        this._deleteRecord(record, { status: 'missing' });
        count++;
      }
    }
    this._bySession.delete(sessionId);
    return count;
  }

  cleanupExpired() {
    const now = this._now();
    let count = 0;
    for (const record of Array.from(this._byId.values())) {
      if (record.expiresAt <= now) {
        this._deleteRecord(record, { status: 'missing' });
        count++;
      }
    }
    return count;
  }

  snapshot(record) {
    const out = Object.assign({
      decisionId: record.decisionId,
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    }, cloneJson(record.request));
    if (record.status === 'answered') {
      out.answeredAt = record.answeredAt;
    }
    return out;
  }

  answerSnapshot(record) {
    const answer = record.answer || {};
    const out = {};
    if (hasOwn(answer, 'choice')) out.choice = cloneJson(answer.choice);
    if (hasOwn(answer, 'optionValue')) out.optionValue = cloneJson(answer.optionValue);
    return out;
  }

  _newDecisionId() {
    let id;
    do {
      id = 'dec_' + crypto.randomBytes(16).toString('hex');
    } while (this._byId.has(id));
    return id;
  }

  _deleteRecord(record, waiterPayload) {
    this._finishWaiters(record, waiterPayload || { status: 'missing' });
    this._byId.delete(record.decisionId);
    const ids = this._bySession.get(record.sessionId);
    if (ids) {
      ids.delete(record.decisionId);
      if (ids.size === 0) this._bySession.delete(record.sessionId);
    }
  }

  _finishWaiters(record, payload) {
    if (!record.waiters || record.waiters.size === 0) return;
    const waiters = Array.from(record.waiters);
    record.waiters.clear();
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      try { waiter.resolve(payload); } catch (_) { /* ignore */ }
    }
  }
}

function normalizeDecisionRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw controlError('INVALID_ARGUMENT', 'Decision body must be an object', 400);
  }
  const kind = typeof body.kind === 'string' ? body.kind : '';
  if (!DECISION_KINDS.includes(kind)) {
    throw controlError('INVALID_ARGUMENT', 'Decision kind must be tool_approval, plan_approval, or choice_question', 400);
  }

  const out = { kind };
  for (const field of ['tool', 'command', 'cwd', 'plan', 'question']) {
    if (hasOwn(body, field)) out[field] = cloneJson(body[field]);
  }
  if (hasOwn(body, 'options')) {
    if (!Array.isArray(body.options)) {
      throw controlError('INVALID_ARGUMENT', 'Decision options must be an array', 400);
    }
    out.options = body.options.map((option, index) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) {
        throw controlError('INVALID_ARGUMENT', `Decision option ${index} must be an object`, 400);
      }
      const label = typeof option.label === 'string' ? option.label.trim() : '';
      if (!label) throw controlError('INVALID_ARGUMENT', `Decision option ${index} requires a label`, 400);
      const normalized = { label };
      if (hasOwn(option, 'description')) normalized.description = option.description == null ? '' : String(option.description);
      return normalized;
    });
  }
  return out;
}

function normalizeAnswer(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw controlError('INVALID_ARGUMENT', 'Decision answer body must be an object', 400);
  }
  const hasChoice = hasOwn(body, 'choice');
  const hasOptionValue = hasOwn(body, 'optionValue');
  if (!hasChoice && !hasOptionValue) {
    throw controlError('INVALID_ARGUMENT', 'Decision answer requires choice or optionValue', 400);
  }
  const out = {};
  if (hasChoice) out.choice = cloneJson(body.choice);
  if (hasOptionValue) out.optionValue = cloneJson(body.optionValue);
  return out;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function controlError(code, message, statusCode) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

module.exports = {
  DecisionStore,
  DECISION_KINDS,
  DEFAULT_DECISION_TTL_MS,
  DEFAULT_CLEANUP_INTERVAL_MS,
};
