'use strict';

// Floating per-tab "sticky note" card: a small overlay in the top-right of the
// terminal showing the local-LLM summary (Goal / Done / Waiting on) for the
// ACTIVE session. All model-derived text is rendered via textContent only —
// the model output is untrusted, so we never use innerHTML.

class StickyNoteCard {
  constructor(app) {
    this.app = app;
    this._sessionId = null;
    this._note = null;
    this._freshnessTimer = null;
    this._collapsed = this._loadCollapsed();
    this._build();
  }

  _loadCollapsed() {
    try {
      return localStorage.getItem('cc-sticky-note-collapsed') === '1';
    } catch {
      return false;
    }
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'sticky-note-card';
    el.hidden = true;

    const header = document.createElement('div');
    header.className = 'sticky-note-header';

    const title = document.createElement('span');
    title.className = 'sticky-note-titlebar';
    const dot = document.createElement('span');
    dot.className = 'sticky-note-dot';
    const label = document.createElement('span');
    label.className = 'sticky-note-label';
    label.textContent = 'Status';
    title.appendChild(dot);
    title.appendChild(label);

    const fresh = document.createElement('span');
    fresh.className = 'sticky-note-fresh';

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'sticky-note-collapse';
    collapseBtn.type = 'button';
    collapseBtn.setAttribute('aria-label', 'Collapse status note');
    collapseBtn.textContent = this._collapsed ? '+' : '–';
    collapseBtn.addEventListener('click', () => this.toggleCollapse());

    header.appendChild(title);
    header.appendChild(fresh);
    header.appendChild(collapseBtn);

    const body = document.createElement('div');
    body.className = 'sticky-note-body';

    const goalSec = document.createElement('div');
    goalSec.className = 'sn-section sn-goal';
    const goalLabel = document.createElement('div');
    goalLabel.className = 'sn-sec-label';
    goalLabel.textContent = 'Goal';
    const goalText = document.createElement('div');
    goalText.className = 'sn-goal-text';
    goalSec.appendChild(goalLabel);
    goalSec.appendChild(goalText);

    const progSec = document.createElement('div');
    progSec.className = 'sn-section sn-progress';
    const progLabel = document.createElement('div');
    progLabel.className = 'sn-sec-label';
    progLabel.textContent = 'Done';
    const progList = document.createElement('ul');
    progList.className = 'sn-list sn-progress-list';
    progSec.appendChild(progLabel);
    progSec.appendChild(progList);

    const waitSec = document.createElement('div');
    waitSec.className = 'sn-section sn-waiting';
    const waitLabel = document.createElement('div');
    waitLabel.className = 'sn-sec-label';
    waitLabel.textContent = 'Waiting on';
    const waitList = document.createElement('ul');
    waitList.className = 'sn-list sn-waiting-list';
    waitSec.appendChild(waitLabel);
    waitSec.appendChild(waitList);

    const placeholder = document.createElement('div');
    placeholder.className = 'sn-placeholder';
    placeholder.textContent = 'Gathering context…';

    body.appendChild(placeholder);
    body.appendChild(goalSec);
    body.appendChild(progSec);
    body.appendChild(waitSec);

    el.appendChild(header);
    el.appendChild(body);

    this.el = el;
    this._refs = { dot, fresh, body, goalSec, goalText, progSec, progList, waitSec, waitList, placeholder, collapseBtn };
    this._applyCollapsed();

    const wrapper = document.querySelector('.terminal-wrapper') || document.getElementById('terminalContainer');
    if (wrapper) wrapper.appendChild(el);
  }

  _enabled() {
    return !this.app || this.app.stickyNotesEnabled !== false;
  }

  toggleCollapse() {
    this._collapsed = !this._collapsed;
    try {
      localStorage.setItem('cc-sticky-note-collapsed', this._collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
    this._applyCollapsed();
  }

  _applyCollapsed() {
    if (!this._refs) return;
    this.el.classList.toggle('collapsed', this._collapsed);
    const btn = this._refs.collapseBtn;
    btn.textContent = this._collapsed ? '+' : '–';
    btn.setAttribute('aria-label', this._collapsed ? 'Expand status note' : 'Collapse status note');
    btn.title = this._collapsed ? 'Expand status' : 'Collapse status';
  }

  setStatus(status) {
    if (!this._refs) return;
    this.el.classList.toggle('summarizing', status === 'summarizing');
  }

  /** Re-render from the active session's stored note (called on tab switch). */
  notifyActiveSessionChanged(sessionId) {
    this._sessionId = sessionId;
    let note = null;
    try {
      const s = this.app.sessionTabManager && this.app.sessionTabManager.activeSessions.get(sessionId);
      note = (s && s.stickyNote) || null;
    } catch {
      note = null;
    }
    this.render(note);
  }

  render(note) {
    if (!this._enabled()) {
      this.hide();
      return;
    }
    this._note = note;
    const r = this._refs;

    if (!note) {
      // No note yet (model still downloading/loading in the background, or none
      // generated): keep the card HIDDEN so it never implies work is blocked.
      // It appears only once the local model is working and produces a summary.
      this.hide();
      return;
    }

    r.placeholder.hidden = true;

    const goal = (note.goal || '').trim();
    r.goalSec.hidden = !goal;
    r.goalText.textContent = goal;

    this._fillList(r.progList, note.progress);
    r.progSec.hidden = !(note.progress && note.progress.length);

    this._fillList(r.waitList, note.waitingOn);
    r.waitSec.hidden = !(note.waitingOn && note.waitingOn.length);

    this._updatedAt = note.updatedAt ? Date.parse(note.updatedAt) : Date.now();
    this._renderFreshness();
    this.show();
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

  show() {
    this.el.hidden = false;
    if (!this._freshnessTimer) {
      this._freshnessTimer = setInterval(() => this._renderFreshness(), 15000);
    }
  }

  hide() {
    this.el.hidden = true;
    if (this._freshnessTimer) {
      clearInterval(this._freshnessTimer);
      this._freshnessTimer = null;
    }
  }
}

if (typeof window !== 'undefined') {
  window.StickyNoteCard = StickyNoteCard;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StickyNoteCard;
}
