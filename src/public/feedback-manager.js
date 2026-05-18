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
   * Auto-dismiss after 12s when there is no CTA. When a CTA IS
   * present, the toast is PERSISTENT (no auto-dismiss) per round-2
   * peer review #3 (WCAG 2.2 SC 2.2.1) — interactive content
   * shouldn't disappear mid-read.
   *
   * @param {object} failure
   * @param {string} failure.hint                   Original clicked text (truncated to 60 chars in title)
   * @param {Array<{path:string,source:string}>} failure.candidates  Stat'd candidates (rendered up to 3 + "+N more")
   * @param {object} failure.context
   * @param {string|null} failure.context.liveCwd
   * @param {string|null} failure.context.workingDir
   * @param {string|null} failure.context.repoRoot
   * @param {string|null} failure.context.bridgeType  'terminal' | 'claude' | 'codex' | 'gemini' | 'copilot' | 'agent' | null
   */
  resolverFailure(failure) {
    this._init();
    if (!failure || typeof failure !== 'object') return;
    // Round-2 review #7 (codex_critic): treat non-array candidates
    // defensively. A truthy object with .length but no .map() would
    // throw and silently swallow the entire toast.
    const rawCandidates = Array.isArray(failure.candidates) ? failure.candidates : [];
    // Round-2 review #5 (gemini_critic): bound the candidate list
    // to prevent layout explosion (a 12-permutation chain or a
    // base64-shaped accidental click should NOT blow out the toast).
    const MAX_RENDERED_CANDIDATES = 3;
    const renderedCandidates = rawCandidates.slice(0, MAX_RENDERED_CANDIDATES);
    const overflow = rawCandidates.length - renderedCandidates.length;
    // Round-2 review #5: truncate the hint at 60 chars in the title
    // (full hint still appears in console.debug for diagnosis).
    const HINT_TITLE_CAP = 60;
    const rawHint = String(failure.hint || '');
    const titleHint = rawHint.length > HINT_TITLE_CAP
      ? rawHint.slice(0, HINT_TITLE_CAP - 1) + '…'
      : rawHint;

    // Pick copy block A/B/C/D per the architect's spec.
    const ctx = failure.context || {};
    // Round-2 review #8 (gemini_critic): bridgeType is a STRICT
    // enum sourced from server-side `session.agent` (one of:
    // 'terminal' | 'claude' | 'codex' | 'gemini' | 'copilot' |
    // 'agent' | null). The dispatch uses exact match. If the
    // server ever emits a more granular value (e.g. 'claude-3-opus'),
    // this regex needs to grow OR upstream needs to normalise — see
    // test/feedback-resolver-failure.test.js "bridgeType enum
    // contract" assertion that pins the canonical set.
    const isAiCli = ctx.bridgeType && /^(claude|codex|gemini|copilot|agent)$/.test(ctx.bridgeType);
    const isTerminal = ctx.bridgeType === 'terminal';
    let title, body, cta;
    if (!renderedCandidates.length) {
      // Block D — no candidates produced (no session context at all)
      title = `Couldn't open "${titleHint}"`;
      body = 'No active session — open or create one to enable file-path clicks.';
    } else if (isTerminal && !ctx.liveCwd) {
      // Block A — Terminal bridge with no OSC 7 tracking. The user's
      // exact failure mode: cd inside the shell, no PROMPT_COMMAND
      // hook installed, clicks resolve against the spawn dir.
      const triedBody = renderedCandidates.map(c => `${c.path} — not found`).join('\n');
      const overflowSuffix = overflow > 0 ? `\n…and ${overflow} more` : '';
      title = `Couldn't open "${titleHint}"`;
      body = `Live directory tracking isn't active in this terminal. Clicks resolve against where the session started (${ctx.workingDir || 'session start dir'}), not where you've \`cd\`'d.\n\nTried:\n${triedBody}${overflowSuffix}\n\nFix: install the OSC 7 hook for your shell — one line in your shell rc.`;
      cta = {
        label: 'Show me how →',
        onClick: () => {
          // Round-2 review #2: link to a stable, server-served docs
          // path. /docs is mounted in src/server.js (express.static
          // on the repo's docs/ tree). Anchor matches the doc's
          // "Live CWD tracking (OSC 7)" §header slug.
          try { window.open('/docs/specs/file-browser.md#live-cwd-tracking-osc-7', '_blank', 'noopener'); }
          catch (_) { /* popup blocked — user can copy URL from console */ }
        },
      };
    } else if (isTerminal && ctx.liveCwd) {
      // Block B — Terminal bridge with liveCwd present, still no hit.
      // Enumerate candidates annotated by SOURCE so the user can tell
      // which dir was the wrong base.
      const annotate = (source) => {
        if (source === 'liveCwd') return 'current shell directory';
        if (source === 'workingDir') return 'session start directory';
        if (source === 'repoRoot') return 'repo root';
        if (source === 'absolute') return 'absolute path';
        // Round-2 review #6: defensive fallback for unknown enum so
        // we never render literal "undefined" in user-facing copy.
        return source || 'candidate path';
      };
      const triedBody = renderedCandidates.map(c => `• ${c.path} — not found (${annotate(c.source)})`).join('\n');
      const overflowSuffix = overflow > 0 ? `\n…and ${overflow} more` : '';
      title = `Couldn't open "${titleHint}"`;
      body = `Tried these locations:\n${triedBody}${overflowSuffix}\n\nThe file may have moved, been deleted, or you may be looking at output from a different directory.`;
    } else if (isAiCli) {
      // Block C — AI CLI bridge. liveCwd is null by design (ADR-0019)
      // since CLI tools don't chdir the host process. Educational copy
      // about why + a CTA to open the file browser for manual nav.
      const triedBody = renderedCandidates.map(c => `${c.path} — not found`).join('\n');
      const overflowSuffix = overflow > 0 ? `\n…and ${overflow} more` : '';
      title = `Couldn't open "${titleHint}"`;
      body = `Tried:\n${triedBody}${overflowSuffix}\n\nAI assistants don't track \`cd\` operations — the file is resolved relative to where the session started. If the assistant has navigated to a different directory, the click won't find the file.`;
      cta = {
        label: 'Open file browser →',
        onClick: () => {
          // Round-2 review #1: IDEMPOTENT open — never toggle. If the
          // user already has the browser open, toggling would close it,
          // which contradicts what the CTA label promises.
          if (window.app && typeof window.app.openFileBrowser === 'function') {
            window.app.openFileBrowser();
          } else if (window.app && typeof window.app.toggleFileBrowser === 'function') {
            // Legacy fallback — only fires for hosts/tests that
            // haven't migrated to the idempotent open API.
            window.app.toggleFileBrowser();
          }
        },
      };
    } else {
      // Defensive default — bridgeType null/unknown, candidates
      // present. Behave like Block B without the annotations.
      const triedBody = renderedCandidates.map(c => `• ${c.path} — not found`).join('\n');
      const overflowSuffix = overflow > 0 ? `\n…and ${overflow} more` : '';
      title = `Couldn't open "${titleHint}"`;
      body = `Tried:\n${triedBody}${overflowSuffix}\n\nThe file may have moved or you may be looking at output from a different directory.`;
    }

    // Structured log for telemetry / future analysis. Avoid surfacing
    // PII beyond what's already in the toast body.
    try { console.debug('[resolverFailure]', failure); } catch (_) { /* ignore */ }

    // Single-stack: dismiss any prior resolver-failure toast and the
    // matching queued copies. Subsequent failures REPLACE.
    this._dismissResolverFailure();

    var el = document.createElement('div');
    el.className = 'toast toast--error toast--resolver-failure';
    // Round-2 review #4 (gemini_critic, WCAG): role choice depends
    // on interactivity. With a CTA the user MUST be able to find
    // and reach the button → role=alertdialog (captures focus +
    // requires explicit dismiss). Without a CTA it's a status
    // announcement → role=status (polite live region, doesn't
    // interrupt SR users mid-task). role=alert with a 12s dismiss
    // and an interactive button was the worst of all worlds.
    el.setAttribute('role', cta ? 'alertdialog' : 'status');
    if (cta) {
      el.setAttribute('aria-labelledby', '_fb_v2_resolver_failure_title');
      el.setAttribute('aria-describedby', '_fb_v2_resolver_failure_body');
    }
    el.setAttribute('data-resolver-failure', '1');

    var html = '<span class="toast__icon toast__icon--error">' + this._icons.error + '</span>';
    html += '<div class="toast__msg toast__msg--resolver-failure">';
    html += '<div class="toast__title" id="_fb_v2_resolver_failure_title">' + this._escHtml(title) + '</div>';
    // Preserve newlines in body — block A/B/C are multi-line.
    html += '<div class="toast__body" id="_fb_v2_resolver_failure_body">' + this._escHtml(body).replace(/\n/g, '<br>') + '</div>';
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
      const actionBtn = el.querySelector('.toast__action');
      actionBtn.addEventListener('click', function() {
        try { cta.onClick(); } catch (_) { /* ignore */ }
        dismiss();
      });
      // Round-2 review #4 follow-on: for alertdialog role, move
      // focus into the toast so keyboard + SR users can act on
      // the CTA without having to hunt. Defer one tick so the
      // browser settles the appendChild before focus shifts.
      try {
        setTimeout(function () { try { actionBtn.focus(); } catch (_) {} }, 0);
      } catch (_) { /* ignore */ }
    }
    // Auto-dismiss only when there is NO CTA (round-2 review #3,
    // WCAG 2.2 SC 2.2.1). CTA-bearing toasts persist until the user
    // takes action or dismisses manually.
    if (!cta) {
      entry.timer = setTimeout(dismiss, 12000);
    }
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
