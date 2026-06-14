'use strict';

// Floating per-tab "sticky note" card: a small overlay in the top-right of the
// terminal showing the local-LLM summary for the ACTIVE session — an evolving
// Goal / Done / Remaining plus an append-only Updates log (newest first). All
// model-derived text is rendered via textContent only (untrusted output).
//
// Minimize affordance lives in the TOOLBAR (#stickyNoteBtn), not a floating chip:
// the card is hidden when collapsed (default) and the toolbar button toggles it.
// The card reports its state via onStateChange so the button can show a status dot.

class StickyNoteCard {
  constructor(app) {
    this.app = app;
    this._sessionId = null;
    this._note = null;
    this._summarizing = false;
    this._updatedAt = 0;
    this._freshnessTimer = null;
    this._collapsed = this._loadCollapsed();
    this.onStateChange = null; // (state) => void — set by the app to drive the toolbar button
    this._build();
  }

  _loadCollapsed() {
    // Always start collapsed: expanding is a deliberate "activate" that starts
    // server-side summarisation. Within a session the toggle still works.
    return true;
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'sticky-note-card';
    el.id = 'stickyNoteCard';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-labelledby', 'stickyNoteLabel');
    el.hidden = true;

    const header = document.createElement('div');
    header.className = 'sticky-note-header';

    const title = document.createElement('span');
    title.className = 'sticky-note-titlebar';
    const dot = document.createElement('span');
    dot.className = 'sticky-note-dot';
    const label = document.createElement('span');
    label.className = 'sticky-note-label';
    label.id = 'stickyNoteLabel';
    label.textContent = 'Status';
    title.appendChild(dot);
    title.appendChild(label);

    const fresh = document.createElement('span');
    fresh.className = 'sticky-note-fresh';

    const minimizeBtn = document.createElement('button');
    minimizeBtn.className = 'sticky-note-collapse';
    minimizeBtn.type = 'button';
    minimizeBtn.textContent = '–';
    minimizeBtn.setAttribute('aria-label', 'Minimize status note');
    minimizeBtn.title = 'Minimize';
    minimizeBtn.addEventListener('click', () => this.collapse());

    header.appendChild(title);
    header.appendChild(fresh);
    header.appendChild(minimizeBtn);

    const body = document.createElement('div');
    body.className = 'sticky-note-body';

    const placeholder = document.createElement('div');
    placeholder.className = 'sn-placeholder';
    placeholder.textContent = 'No status yet — a summary appears as the session works.';

    const mk = (cls, labelText, listTag) => {
      const sec = document.createElement('div');
      sec.className = 'sn-section ' + cls;
      const lab = document.createElement('div');
      lab.className = 'sn-sec-label';
      lab.textContent = labelText;
      sec.appendChild(lab);
      let content;
      if (listTag) {
        content = document.createElement('ul');
        content.className = 'sn-list';
      } else {
        content = document.createElement('div');
        content.className = 'sn-goal-text';
      }
      sec.appendChild(content);
      return { sec, content };
    };

    const goal = mk('sn-goal', 'Goal', false);
    const done = mk('sn-done', 'Done', true);
    const remaining = mk('sn-remaining', 'Remaining', true);
    const updates = mk('sn-updates', 'Updates', true);

    body.appendChild(placeholder);
    body.appendChild(goal.sec);
    body.appendChild(done.sec);
    body.appendChild(remaining.sec);
    body.appendChild(updates.sec);

    el.appendChild(header);
    el.appendChild(body);

    this.el = el;
    this._refs = {
      dot, fresh, body, placeholder, minimizeBtn,
      goalSec: goal.sec, goalText: goal.content,
      doneSec: done.sec, doneList: done.content,
      remSec: remaining.sec, remList: remaining.content,
      updSec: updates.sec, updList: updates.content,
    };
    this._syncVisibility();

    const wrapper = document.querySelector('.terminal-wrapper') || document.getElementById('terminalContainer');
    if (wrapper) wrapper.appendChild(el);
  }

  _enabled() {
    return !this.app || this.app.stickyNotesEnabled !== false;
  }

  // --- public API (used by the toolbar button) -----------------------------

  isCollapsed() {
    return this._collapsed;
  }
  expand() {
    if (this._collapsed) this._setCollapsed(false);
  }
  collapse() {
    if (!this._collapsed) this._setCollapsed(true);
  }
  toggleCollapse() {
    this._setCollapsed(!this._collapsed);
  }

  _setCollapsed(v) {
    this._collapsed = v;
    try {
      localStorage.setItem('cc-sticky-note-collapsed', v ? '1' : '0');
    } catch {
      /* ignore */
    }
    this._syncVisibility();
    if (v) {
      // Minimizing: return focus to the toolbar toggle.
      const btn = typeof document !== 'undefined' && document.getElementById('stickyNoteBtn');
      if (btn && typeof btn.focus === 'function') btn.focus();
    }
    this.reportActiveState(); // expand = activate server processing; collapse = deactivate
    this._emitState();
  }

  /**
   * Tell the server whether this browser is actively viewing (expanded) the
   * current session — the server only runs note summarisation while ≥1 viewer
   * is expanded. The cheap ai-title tail runs regardless.
   */
  reportActiveState() {
    const active = !this._collapsed && this._enabled() && !!this._sessionId;
    if (this.app && typeof this.app._reportStickyActive === 'function') {
      this.app._reportStickyActive(this._sessionId, active);
    }
  }

  setStatus(status) {
    this._summarizing = status === 'summarizing';
    if (this.el) this.el.classList.toggle('summarizing', this._summarizing);
    this._emitState();
  }

  _emitState() {
    if (typeof this.onStateChange === 'function') {
      try {
        this.onStateChange({
          collapsed: this._collapsed,
          hasNote: !!this._note,
          summarizing: this._summarizing,
          updatedAt: this._updatedAt || null,
        });
      } catch {
        /* never let the consumer break the card */
      }
    }
  }

  /** Re-render from the active session's stored note (called on tab switch). */
  notifyActiveSessionChanged(sessionId) {
    // Switching tabs while expanded: the OLD session is no longer being viewed.
    if (this._sessionId && this._sessionId !== sessionId && !this._collapsed) {
      if (this.app && typeof this.app._reportStickyActive === 'function') {
        this.app._reportStickyActive(this._sessionId, false);
      }
    }
    this._sessionId = sessionId;
    let note = null;
    try {
      const s = this.app.sessionTabManager && this.app.sessionTabManager.activeSessions.get(sessionId);
      note = (s && s.stickyNote) || null;
    } catch {
      note = null;
    }
    this.render(note);
    this.reportActiveState(); // the NEW active session is active iff the card is expanded
  }

  render(note) {
    this._note = note || null;
    const r = this._refs;
    if (r && this._note) {
      const goal = (this._note.goal || '').trim();
      r.goalText.textContent = goal;
      r.goalSec.hidden = !goal;

      this._fillList(r.doneList, this._note.done);
      r.doneSec.hidden = !(this._note.done && this._note.done.length);

      this._fillList(r.remList, this._note.remaining);
      r.remSec.hidden = !(this._note.remaining && this._note.remaining.length);

      this._fillUpdates(r.updList, this._note.updates);
      r.updSec.hidden = !(this._note.updates && this._note.updates.length);

      this._updatedAt = this._note.updatedAt ? Date.parse(this._note.updatedAt) : Date.now();
    }
    this._syncVisibility();
    this._emitState();
  }

  _syncVisibility() {
    if (!this._refs) return;
    const hidden = this._collapsed || !this._enabled();
    this.el.hidden = hidden;
    if (hidden) {
      this._stopFreshness();
      return;
    }
    // Shown: real note → content; otherwise the "No status yet" placeholder.
    const hasNote = !!this._note;
    this._refs.placeholder.hidden = hasNote;
    if (hasNote) {
      this._renderFreshness();
      this._startFreshness();
    } else {
      this._refs.goalSec.hidden = true;
      this._refs.doneSec.hidden = true;
      this._refs.remSec.hidden = true;
      this._refs.updSec.hidden = true;
      this._refs.fresh.textContent = '';
      this._stopFreshness();
    }
  }

  _fillList(ul, items) {
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = String(item);
      ul.appendChild(li);
    }
  }

  _fillUpdates(ul, updates) {
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    if (!Array.isArray(updates)) return;
    for (const u of updates) {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.className = 'sn-update-text';
      text.textContent = String((u && u.text) || '');
      li.appendChild(text);
      if (u && u.at) {
        const at = document.createElement('span');
        at.className = 'sn-update-at';
        const ms = Date.parse(u.at);
        at.textContent = Number.isFinite(ms) ? this._shortAge(Date.now() - ms) : '';
        li.appendChild(at);
      }
      ul.appendChild(li);
    }
  }

  _renderFreshness() {
    if (!this._refs || !this._updatedAt) return;
    this._refs.fresh.textContent = this._formatAge(Date.now() - this._updatedAt);
  }

  _formatAge(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `updated ${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `updated ${m}m ago`;
    const h = Math.round(m / 60);
    return `updated ${h}h ago`;
  }

  _shortAge(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.round(m / 60)}h`;
  }

  _startFreshness() {
    if (!this._freshnessTimer) {
      this._freshnessTimer = setInterval(() => this._renderFreshness(), 15000);
    }
  }
  _stopFreshness() {
    if (this._freshnessTimer) {
      clearInterval(this._freshnessTimer);
      this._freshnessTimer = null;
    }
  }

  /** Hard hide (e.g. feature disabled). Keeps collapsed state untouched. */
  hide() {
    this.el.hidden = true;
    this._stopFreshness();
    this._emitState();
  }
}

if (typeof window !== 'undefined') {
  window.StickyNoteCard = StickyNoteCard;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StickyNoteCard;
}
