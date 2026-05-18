// feedback-manager.js — Toast notification system for ai-or-die
'use strict';

class FeedbackManager {
  constructor() {
    this._container = null;
    this._queue = [];
    this._visible = [];
    this._maxVisible = 3;
    this._defaults = { info: 4000, success: 4000, warning: 6000, error: 0 };
    this._icons = {
      info: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><text x="8" y="12" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">i</text></svg>',
      success: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      warning: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5L14.5 13.5H1.5L8 1.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><text x="8" y="12" text-anchor="middle" font-size="9" font-weight="600" fill="currentColor">!</text></svg>',
      error: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    };
  }

  _init() {
    if (this._container) return;
    this._container = document.createElement('div');
    this._container.className = 'toast-container';
    document.body.appendChild(this._container);
  }

  _isDuplicate(message) {
    return this._visible.some(function(t) { return t.msg === message; });
  }

  _show(type, message, opts) {
    this._init();
    opts = opts || {};
    if (this._isDuplicate(message)) return;
    if (this._visible.length >= this._maxVisible) {
      // If all visible slots are occupied by persistent (no-timer) toasts,
      // evict the oldest persistent one to prevent the queue from stalling.
      // Push the current toast to the front of the queue so it gets shown
      // when _dismiss dequeues the next item.
      var allPersistent = this._visible.every(function(v) { return !v.timer; });
      if (allPersistent && this._visible.length > 0) {
        this._queue.unshift({ type: type, message: message, opts: opts });
        this._dismiss(this._visible[0]);
        return;
      }
      this._queue.push({ type: type, message: message, opts: opts });
      return;
    }
    var duration = opts.duration !== undefined ? opts.duration : this._defaults[type];
    var el = document.createElement('div');
    el.className = 'toast toast--' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');

    var html = '<span class="toast__icon toast__icon--' + type + '">' + this._icons[type] + '</span>';
    html += '<span class="toast__msg">' + this._escHtml(message) + '</span>';
    if (opts.action && opts.onAction) {
      html += '<button class="toast__action" type="button">' + this._escHtml(opts.action) + '</button>';
    }
    html += '<button class="toast__close" type="button" aria-label="Dismiss">&times;</button>';
    el.innerHTML = html;

    var entry = { el: el, msg: message, timer: null };
    this._visible.push(entry);
    this._container.appendChild(el);

    var self = this;
    var dismiss = function() { self._dismiss(entry); };

    el.querySelector('.toast__close').addEventListener('click', dismiss);
    if (opts.action && opts.onAction) {
      el.querySelector('.toast__action').addEventListener('click', function() {
        opts.onAction();
        dismiss();
      });
    }
    if (duration > 0) {
      entry.timer = setTimeout(dismiss, duration);
    }
  }

  _dismiss(entry) {
    if (!entry.el.parentNode) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.el.classList.add('toast--exit');
    var removeEl = function() {
      if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    };
    entry.el.addEventListener('animationend', removeEl);
    // Fallback: if animationend doesn't fire (e.g. tab backgrounded, animation
    // disabled, or reduced-motion preference), force removal after 500ms.
    setTimeout(removeEl, 500);
    this._visible = this._visible.filter(function(v) { return v !== entry; });
    if (this._queue.length > 0) {
      var next = this._queue.shift();
      this._show(next.type, next.message, next.opts);
    }
  }

  _escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  info(message, opts) { this._show('info', message, opts); }
  success(message, opts) { this._show('success', message, opts); }
  warning(message, opts) { this._show('warning', message, opts); }
  error(message, opts) { this._show('error', message, opts); }

  /**
   * Structured failure toast for the terminal-path resolver (Layer 5
   * per the file-browser-v2-followup architect+team-lead design).
   *
   * Unlike the generic .error() one-liner, this surfaces a title +
   * body + optional CTA tailored to the FAILURE CONTEXT (which
   * candidates were tried, which bridge type, whether OSC 7 is
   * tracked). Single-stack: subsequent failures REPLACE the prior
   * toast — clicking another path immediately after one fails should
   * surface THAT path's diagnosis, not stack a second toast on top.
   *
   * Auto-dismiss after 12s OR user-dismiss via the close button.
   *
   * @param {object} failure
   * @param {string} failure.hint                   Original clicked text
   * @param {Array<{path:string,source:string}>} failure.candidates  Stat'd candidates
   * @param {object} failure.context
   * @param {string|null} failure.context.liveCwd
   * @param {string|null} failure.context.workingDir
   * @param {string|null} failure.context.repoRoot
   * @param {string|null} failure.context.bridgeType  'terminal' | 'claude' | 'codex' | 'gemini' | 'copilot' | 'agent' | null
   */
  resolverFailure(failure) {
    this._init();
    if (!failure || typeof failure !== 'object') return;
    // Pick copy block A/B/C/D per the architect's spec.
    const ctx = failure.context || {};
    const isAiCli = ctx.bridgeType && /^(claude|codex|gemini|copilot|agent)$/.test(ctx.bridgeType);
    const isTerminal = ctx.bridgeType === 'terminal';
    let title, body, cta;
    if (!failure.candidates || !failure.candidates.length) {
      // Block D — no candidates produced (no session context at all)
      title = `Couldn't open "${failure.hint}"`;
      body = 'No active session — open or create one to enable file-path clicks.';
    } else if (isTerminal && !ctx.liveCwd) {
      // Block A — Terminal bridge with no OSC 7 tracking. The user's
      // exact failure mode: cd inside the shell, no PROMPT_COMMAND
      // hook installed, clicks resolve against the spawn dir.
      const tried = failure.candidates.map(c => `${c.path} — not found`).join('\n');
      title = `Couldn't open "${failure.hint}"`;
      body = `Live directory tracking isn't active in this terminal. Clicks resolve against where the session started (${ctx.workingDir || 'session start dir'}), not where you've \`cd\`'d.\n\nTried:\n${tried}\n\nFix: install the OSC 7 hook for your shell — one line in your shell rc.`;
      cta = { label: 'Show me how →', onClick: () => window.open('/docs/specs/file-browser.md#shell-hooks', '_blank') };
    } else if (isTerminal && ctx.liveCwd) {
      // Block B — Terminal bridge with liveCwd present, still no hit.
      // Enumerate candidates annotated by SOURCE so the user can tell
      // which dir was the wrong base.
      const tried = failure.candidates.map(c => {
        const annotation = c.source === 'liveCwd' ? 'current shell directory'
          : c.source === 'workingDir' ? 'session start directory'
          : c.source === 'repoRoot' ? 'repo root'
          : c.source === 'absolute' ? 'absolute path'
          : c.source;
        return `• ${c.path} — not found (${annotation})`;
      }).join('\n');
      title = `Couldn't open "${failure.hint}"`;
      body = `Tried these locations:\n${tried}\n\nThe file may have moved, been deleted, or you may be looking at output from a different directory.`;
    } else if (isAiCli) {
      // Block C — AI CLI bridge. liveCwd is null by design (ADR-0019)
      // since CLI tools don't chdir the host process. Educational copy
      // about why + a CTA to open the file browser for manual nav.
      const tried = failure.candidates.map(c => `${c.path} — not found`).join('\n');
      title = `Couldn't open "${failure.hint}"`;
      body = `Tried:\n${tried}\n\nAI assistants don't track \`cd\` operations — the file is resolved relative to where the session started. If the assistant has navigated to a different directory, the click won't find the file.`;
      cta = {
        label: 'Open file browser →',
        onClick: () => {
          if (window.app && typeof window.app.toggleFileBrowser === 'function') {
            window.app.toggleFileBrowser();
          }
        },
      };
    } else {
      // Defensive default — bridgeType null/unknown, candidates
      // present. Behave like Block B without the annotations.
      const tried = failure.candidates.map(c => `• ${c.path} — not found`).join('\n');
      title = `Couldn't open "${failure.hint}"`;
      body = `Tried:\n${tried}\n\nThe file may have moved or you may be looking at output from a different directory.`;
    }

    // Structured log for telemetry / future analysis. Avoid surfacing
    // PII beyond what's already in the toast body.
    try { console.debug('[resolverFailure]', failure); } catch (_) { /* ignore */ }

    // Single-stack: dismiss any prior resolver-failure toast and the
    // matching queued copies. Subsequent failures REPLACE.
    this._dismissResolverFailure();

    var el = document.createElement('div');
    el.className = 'toast toast--error toast--resolver-failure';
    el.setAttribute('role', 'alert');
    el.setAttribute('data-resolver-failure', '1');

    var html = '<span class="toast__icon toast__icon--error">' + this._icons.error + '</span>';
    html += '<div class="toast__msg toast__msg--resolver-failure">';
    html += '<div class="toast__title">' + this._escHtml(title) + '</div>';
    // Preserve newlines in body — block A/B/C are multi-line.
    html += '<div class="toast__body">' + this._escHtml(body).replace(/\n/g, '<br>') + '</div>';
    html += '</div>';
    if (cta) {
      html += '<button class="toast__action" type="button">' + this._escHtml(cta.label) + '</button>';
    }
    html += '<button class="toast__close" type="button" aria-label="Dismiss">&times;</button>';
    el.innerHTML = html;

    var entry = { el: el, msg: '__resolver-failure__', timer: null, isResolverFailure: true };
    this._visible.push(entry);
    this._container.appendChild(el);

    var self = this;
    var dismiss = function() { self._dismiss(entry); };
    el.querySelector('.toast__close').addEventListener('click', dismiss);
    if (cta) {
      el.querySelector('.toast__action').addEventListener('click', function() {
        try { cta.onClick(); } catch (_) { /* ignore */ }
        dismiss();
      });
    }
    // 12s auto-dismiss per architect's spec.
    entry.timer = setTimeout(dismiss, 12000);
  }

  /**
   * Remove any visible resolver-failure toast + any queued ones so the
   * next .resolverFailure() shows fresh. Single-stack contract.
   * Detaches SYNCHRONOUSLY (no exit animation) so the replacement
   * shows immediately — animating the prior out while the next is
   * incoming would let the user briefly see TWO toasts.
   */
  _dismissResolverFailure() {
    var self = this;
    var dups = this._visible.filter(function(v) { return v.isResolverFailure; });
    dups.forEach(function (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
      self._visible = self._visible.filter(function(v) { return v !== entry; });
    });
    this._queue = this._queue.filter(function(q) {
      return !(q.opts && q.opts._isResolverFailure);
    });
  }
}

window.feedback = new FeedbackManager();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FeedbackManager;
}
