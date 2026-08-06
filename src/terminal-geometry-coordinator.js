'use strict';

const GEOMETRY_LIMITS = Object.freeze({
  minCols: 20,
  maxCols: 1000,
  minRows: 5,
  maxRows: 500,
});
const MAX_VIEWS_PER_CONNECTION = 16;

function normalizeGeometry(cols, rows) {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols < GEOMETRY_LIMITS.minCols || cols > GEOMETRY_LIMITS.maxCols) return null;
  if (rows < GEOMETRY_LIMITS.minRows || rows > GEOMETRY_LIMITS.maxRows) return null;
  return { cols, rows };
}

function normalizeViewId(viewId) {
  if (typeof viewId !== 'string') return 'main';
  const value = viewId.trim();
  return value && value.length <= 128 ? value : 'main';
}

function attachmentKey(connectionId, viewId) {
  return `${connectionId}\u0000${normalizeViewId(viewId)}`;
}

class TerminalGeometryCoordinator {
  constructor(options = {}) {
    this._states = new Map();
    this._coalesceMs = Number.isFinite(options.coalesceMs)
      ? Math.max(0, options.coalesceMs)
      : 0;
    this._setTimeout = options.setTimeout || setTimeout;
    this._clearTimeout = options.clearTimeout || clearTimeout;
    this._applyResize = options.applyResize || (async () => {});
    this._broadcast = options.broadcast || (() => {});
    this._afterBroadcast = options.afterBroadcast || (() => {});
    this._afterFailure = options.afterFailure || (() => {});
    this._markDirty = options.markDirty || (() => {});
    this._isActive = options.isActive || (() => false);
    this._reject = options.reject || (() => {});
  }

  initializeSession(sessionId, session, options = {}) {
    const restored = options.restored === true;
    const persisted = session.terminalGeometry && typeof session.terminalGeometry === 'object'
      ? session.terminalGeometry
      : {};
    const priorEpoch = Number.isInteger(persisted.epoch) && persisted.epoch >= 0
      ? persisted.epoch
      : 0;
    const applied = persisted.applied
      ? normalizeGeometry(persisted.applied.cols, persisted.applied.rows)
      : null;
    session.terminalGeometry = {
      epoch: restored ? priorEpoch + 1 : Math.max(1, priorEpoch),
      revision: restored ? 0 : (
        Number.isInteger(persisted.revision) && persisted.revision >= 0
          ? persisted.revision
          : 0
      ),
      applied,
    };
    const state = {
      sessionId,
      session,
      persisted: session.terminalGeometry,
      attachments: new Map(),
      ownerKey: null,
      attachmentSeq: 0,
      deliberateSeq: 0,
      automaticLeaseAvailable: !restored,
      ownerApplyTimer: null,
      queue: Promise.resolve(),
    };
    this._states.set(sessionId, state);
    if (restored) this._markDirty(sessionId);
    return this.getFrame(sessionId);
  }

  removeSession(sessionId) {
    const state = this._states.get(sessionId);
    if (state) this._cancelOwnerApply(state);
    this._states.delete(sessionId);
  }

  clear() {
    for (const state of this._states.values()) this._cancelOwnerApply(state);
    this._states.clear();
  }

  getFrame(sessionId) {
    const state = this._states.get(sessionId);
    if (!state || !state.persisted.applied) return null;
    const owner = state.ownerKey ? state.attachments.get(state.ownerKey) : null;
    return {
      type: 'geometry_applied',
      sessionId,
      epoch: state.persisted.epoch,
      revision: state.persisted.revision,
      cols: state.persisted.applied.cols,
      rows: state.persisted.applied.rows,
      owner: owner ? {
        connectionId: owner.connectionId,
        viewId: owner.viewId,
      } : null,
    };
  }

  getCapacity(sessionId, connectionId, viewId) {
    const state = this._states.get(sessionId);
    const record = state && state.attachments.get(attachmentKey(connectionId, viewId));
    return record && record.eligible ? { ...record.capacity } : null;
  }

  getOwnerCapacity(sessionId) {
    const state = this._states.get(sessionId);
    if (!state || !state.ownerKey) return null;
    const owner = state.attachments.get(state.ownerKey);
    return owner && owner.eligible ? { ...owner.capacity } : null;
  }

  advertise(sessionId, connectionId, viewId, cols, rows) {
    const state = this._states.get(sessionId);
    if (!state) return Promise.resolve(false);
    const capacity = normalizeGeometry(cols, rows);
    if (!capacity) {
      this._reject(connectionId, {
        type: 'geometry_rejected',
        reason: 'invalid_geometry',
        limits: GEOMETRY_LIMITS,
      });
      return Promise.resolve(false);
    }
    const record = this._ensureAttachment(state, connectionId, viewId);
    if (!record) {
      this._reject(connectionId, {
        type: 'geometry_rejected',
        reason: 'too_many_views',
      });
      return Promise.resolve(false);
    }
    record.capacity = capacity;
    record.eligible = true;

    let ownerChanged = false;
    if (!state.ownerKey && state.automaticLeaseAvailable) {
      const successor = this._chooseSuccessor(state);
      state.ownerKey = successor ? successor.key : null;
      ownerChanged = !!successor;
      if (successor) state.automaticLeaseAvailable = false;
    }
    if (state.ownerKey !== record.key) return Promise.resolve(true);
    if (ownerChanged) {
      this._cancelOwnerApply(state);
      return this._enqueue(state, async () => {
        await this._applyOwner(state, { ownerChanged: true });
        return true;
      });
    }
    return this._scheduleOwnerApply(state);
  }

  withdraw(sessionId, connectionId, viewId) {
    const state = this._states.get(sessionId);
    if (!state) return Promise.resolve(false);
    const record = this._ensureAttachment(state, connectionId, viewId);
    if (!record) return Promise.resolve(false);
    record.eligible = false;
    record.capacity = null;
    const wasOwner = state.ownerKey === record.key;
    if (wasOwner) {
      this._cancelOwnerApply(state);
      state.ownerKey = null;
      const successor = this._chooseSuccessor(state);
      state.ownerKey = successor ? successor.key : null;
    }
    return this._enqueue(state, async () => {
      if (wasOwner && state.ownerKey) {
        await this._applyOwner(state, { ownerChanged: true });
      } else if (wasOwner && state.persisted.applied) {
        this._commitAndBroadcast(state);
      }
      return true;
    });
  }

  takeControl(sessionId, connectionId, viewId) {
    return this.withDeliberateAction(sessionId, connectionId, viewId, null);
  }

  runSerialized(sessionId, action) {
    const state = this._states.get(sessionId);
    if (!state) return Promise.resolve().then(action);
    return this._enqueue(state, action);
  }

  withDeliberateAction(sessionId, connectionId, viewId, action) {
    const state = this._states.get(sessionId);
    if (!state) return action ? Promise.resolve().then(action) : Promise.resolve(false);
    const key = attachmentKey(connectionId, viewId);
    const candidate = state.attachments.get(key);
    const hasEligibleCapacity = !!(candidate
      && candidate.eligible
      && candidate.capacity);
    if (hasEligibleCapacity) {
      this._cancelOwnerApply(state);
    }
    return this._enqueue(state, async () => {
      const record = state.attachments.get(key);
      if (!record || !record.eligible || !record.capacity) {
        if (action) await action();
        return false;
      }
      record.lastDeliberateSeq = ++state.deliberateSeq;
      const ownerChanged = state.ownerKey !== key;
      if (ownerChanged) {
        state.ownerKey = key;
        state.automaticLeaseAvailable = false;
        await this._applyOwner(state, { ownerChanged: true });
      } else {
        await this._applyOwner(state);
      }
      if (action) await action();
      return true;
    });
  }

  detachConnection(sessionId, connectionId) {
    const state = this._states.get(sessionId);
    if (!state) return Promise.resolve(false);
    let ownerRemoved = false;
    for (const [key, record] of state.attachments) {
      if (record.connectionId !== connectionId) continue;
      if (state.ownerKey === key) ownerRemoved = true;
      state.attachments.delete(key);
    }
    if (ownerRemoved) {
      this._cancelOwnerApply(state);
      state.ownerKey = null;
      const successor = this._chooseSuccessor(state);
      state.ownerKey = successor ? successor.key : null;
    }
    return this._enqueue(state, async () => {
      if (ownerRemoved && state.ownerKey) {
        await this._applyOwner(state, { ownerChanged: true });
      } else if (ownerRemoved && state.persisted.applied) {
        this._commitAndBroadcast(state);
      }
      return true;
    });
  }

  commitSpawn(sessionId, cols, rows) {
    const state = this._states.get(sessionId);
    const applied = normalizeGeometry(cols, rows);
    if (!state || !applied) return Promise.resolve(false);
    this._cancelOwnerApply(state);
    return this._enqueue(state, async () => {
      state.persisted.applied = applied;
      this._commitAndBroadcast(state);
      return true;
    });
  }

  reconcile(sessionId) {
    const state = this._states.get(sessionId);
    if (!state) return Promise.resolve(false);
    this._cancelOwnerApply(state);
    return this._enqueue(state, () => this._applyOwner(state));
  }

  _ensureAttachment(state, connectionId, viewId) {
    const normalizedViewId = normalizeViewId(viewId);
    const key = attachmentKey(connectionId, normalizedViewId);
    let record = state.attachments.get(key);
    if (!record) {
      const viewCount = Array.from(state.attachments.values()).filter(
        (entry) => entry.connectionId === connectionId
      ).length;
      if (viewCount >= MAX_VIEWS_PER_CONNECTION) return null;
      record = {
        key,
        connectionId,
        viewId: normalizedViewId,
        attachmentSeq: ++state.attachmentSeq,
        lastDeliberateSeq: 0,
        eligible: false,
        capacity: null,
      };
      state.attachments.set(key, record);
    }
    return record;
  }

  _chooseSuccessor(state) {
    const eligible = Array.from(state.attachments.values()).filter(
      (record) => record.eligible && record.capacity
    );
    eligible.sort((a, b) => (
      b.lastDeliberateSeq - a.lastDeliberateSeq
      || b.attachmentSeq - a.attachmentSeq
      || a.connectionId.localeCompare(b.connectionId)
      || a.viewId.localeCompare(b.viewId)
    ));
    return eligible[0] || null;
  }

  _enqueue(state, task) {
    const run = state.queue.then(task, task);
    state.queue = run.catch(() => {});
    return run;
  }

  _scheduleOwnerApply(state) {
    if (this._coalesceMs === 0) {
      return this._enqueue(state, async () => {
        await this._applyOwner(state);
        return true;
      });
    }
    this._cancelOwnerApply(state);
    state.ownerApplyTimer = this._setTimeout(() => {
      state.ownerApplyTimer = null;
      this._enqueue(state, () => this._applyOwner(state)).catch(() => {});
    }, this._coalesceMs);
    return Promise.resolve(true);
  }

  _cancelOwnerApply(state) {
    if (!state || state.ownerApplyTimer == null) return;
    this._clearTimeout(state.ownerApplyTimer);
    state.ownerApplyTimer = null;
  }

  async _applyOwner(state, options = {}) {
    if (!state.ownerKey) return false;
    const owner = state.attachments.get(state.ownerKey);
    if (!owner || !owner.eligible || !owner.capacity) return false;
    const current = state.persisted.applied;
    const unchanged = current
      && current.cols === owner.capacity.cols
      && current.rows === owner.capacity.rows;
    if (unchanged) {
      if (options.ownerChanged) this._commitAndBroadcast(state);
      return true;
    }
    if (!this._isActive(state.sessionId)) return false;
    try {
      await this._applyResize(state.sessionId, owner.capacity);
    } catch (error) {
      this._afterFailure(state.sessionId, error);
      throw error;
    }
    state.persisted.applied = { ...owner.capacity };
    this._commitAndBroadcast(state);
    return true;
  }

  _commitAndBroadcast(state) {
    state.persisted.revision += 1;
    this._markDirty(state.sessionId);
    const frame = this.getFrame(state.sessionId);
    try {
      if (frame) this._broadcast(state.sessionId, frame);
    } finally {
      this._afterBroadcast(state.sessionId, frame);
    }
  }
}

module.exports = {
  GEOMETRY_LIMITS,
  MAX_VIEWS_PER_CONNECTION,
  TerminalGeometryCoordinator,
  attachmentKey,
  normalizeGeometry,
};
