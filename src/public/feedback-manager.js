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
    entry.el.addEventListener('animationend', function() {
      if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    });
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
}

window.feedback = new FeedbackManager();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FeedbackManager;
}
