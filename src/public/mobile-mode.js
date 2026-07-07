'use strict';

/*
 * mobile-mode.js — hook-independent mobile client shell.
 *
 * Conversation data is read from the control-plane semantic turn stream:
 *   {id, kind:'user-text'|'assistant-text'|'tool-call'|'tool-result'|
 *    'thinking', text?, thinking?, toolUseId?, name?, input?, content?, isError?}
 * Decision sheets remain locally rendered until the hook decision channel lands.
 */
(function () {
  var controller = null;
  var TURN_PAGE_LIMIT = 200;
  var CONTROL_EVENT_KINDS = 'turn_ended,became_busy,became_idle,waiting_input';
  var CONTROL_EVENTS_TIMEOUT_MS = 25000;
  var SESSION_WATCH_MS = 500;
  var EVENT_RETRY_MS = 1200;

  var STUB_DECISIONS = {
    permission: {
      kind: 'permission',
      tool: 'Bash',
      command: 'rm -rf build/',
      cwd: 'C:\\Users\\anikundu\\Software\\ai-or-die',
      destructive: true,
      risk: 'Destructive filesystem operation',
      options: []
    },
    plan: {
      kind: 'plan',
      tool: 'ExitPlanMode',
      command: '',
      cwd: 'C:\\Users\\anikundu\\Software\\ai-or-die',
      plan: '### Goal\nValidate the mobile interaction model before backend wiring.\n\n### Plan\n- [x] Keep state local and canned for this increment.\n- [x] Render the conversation, tool cards, plan, question, and permission sheets.\n- [x] Send Channel-2 input through app.send({type:\'input\', data}).\n- [ ] Wire the turn stream and hook decision channels in a later stream.\n\n### Files touched\n```diff\n+ src/public/mobile-mode.css\n+ src/public/mobile-mode.js\n+ e2e/tests/80-mobile-mode-shell.spec.js\n```',
      question: '',
      options: []
    },
    question: {
      kind: 'question',
      tool: 'AskUserQuestion',
      command: '',
      cwd: 'C:\\Users\\anikundu\\Software\\ai-or-die',
      question: 'Which route should Claude take?',
      options: [
        { label: 'Keep prototype local', description: 'No backend calls. Use canned permission, plan, and question data.' },
        { label: 'Mirror desktop flows', description: 'Use the existing mental model, compressed for thumbs.' },
        { label: 'Experiment freely', description: 'Prioritize iPhone ergonomics even if desktop diverges.' }
      ]
    }
  };

  function MobileModeController(options) {
    options = options || {};
    this.app = options.app || null;
    this.body = document.body;
    this.root = document.documentElement;
    this.el = null;
    this.messageList = null;
    this.messageStack = null;
    this.statusChip = null;
    this.statusText = null;
    this.modeLabel = null;
    this.needsPill = null;
    this.backdrop = null;
    this.sheets = [];
    this.composerText = null;
    this.composerModeText = null;
    this.permissionSheet = null;
    this.permissionCommand = null;
    this.permissionCwd = null;
    this.permissionRisk = null;
    this.permissionTool = null;
    this.countdownText = null;
    this.countdownFill = null;
    this.rawToggle = null;
    this.rawBox = null;
    this.approvePermissionBtn = null;
    this.denyPermissionBtn = null;
    this.planDoc = null;
    this.questionTitle = null;
    this.questionOptions = null;
    this._focusTrap = null;
    this._boundKeydown = null;
    this._boundResize = null;
    this._boundOrientation = null;
    this._boundViewport = null;
    this._lastActiveElement = null;
    this.currentSessionId = null;
    this.messageCursor = null;
    this.messageEpoch = null;
    this.eventCursor = null;
    this.turnItems = [];
    this.renderedItemIds = new Map();
    this._streamGeneration = 0;
    this._sessionWatchTimer = null;
    this._eventRetryTimer = null;
    this._messageLoadInFlight = false;
    this._messageLoadQueued = false;
    this._localItemSeq = 0;
    this.decisionStubs = {
      permission: clone(STUB_DECISIONS.permission),
      plan: clone(STUB_DECISIONS.plan),
      question: clone(STUB_DECISIONS.question)
    };
    this.state = {
      activeSurface: null,
      pendingSurface: null,
      needsInput: false,
      countdownTimer: null,
      countdownDeadline: 0,
      countdownTotalMs: 45000,
      composerMode: 'plan'
    };
  }

  MobileModeController.prototype.init = function () {
    var appRoot = document.getElementById('app');
    if (!appRoot || this.el) return;

    this.el = document.createElement('section');
    this.el.className = 'mobile-mode';
    this.el.setAttribute('data-testid', 'mobile-mode-shell');
    this.el.setAttribute('aria-label', 'ai-or-die mobile mode');
    this.el.innerHTML = this._template();
    appRoot.appendChild(this.el);

    this._cacheElements();
    this._bindEvents();
    this.renderConversation([]);
    this.renderDecision(this.decisionStubs.permission);
    this.renderDecision(this.decisionStubs.plan);
    this.renderDecision(this.decisionStubs.question);
    this._syncSessionChrome();
    this.syncVisualViewport();
    this.scrollMessagesToBottom(true);

    this.body.classList.add('mobile-mode-active');
    this.startTurnStream();
  };

  MobileModeController.prototype._template = function () {
    return [
      '<div class="app-shell" data-mobile-app-shell>',
      '  <section class="conversation-pane" aria-label="Conversation">',
      '    <header class="topbar">',
      '      <div class="topbar-inner">',
      '        <div class="session-mark" aria-hidden="true">&gt;_</div>',
      '        <div class="session-title">',
      '          <div class="session-name" data-mobile-session-name>ai-or-die</div>',
      '          <div class="session-meta"><span>Claude</span><span>\u00b7</span><span data-mobile-mode-label>code mode</span><span>\u00b7</span><span class="mode-dot" aria-hidden="true"></span><span>mobile mode</span></div>',
      '        </div>',
      '        <button class="overflow-btn" type="button" aria-label="More options">\u22ee</button>',
      '      </div>',
      '    </header>',
      '    <button class="needs-pill" type="button" data-mobile-needs-pill aria-live="polite"><span class="pulse" aria-hidden="true"></span><span>Claude needs you</span></button>',
      '    <main class="message-list" data-mobile-message-list aria-label="Messages">',
      '      <div class="message-stack" data-mobile-message-stack></div>',
      '    </main>',
      '    <div class="status-line" aria-live="polite">',
      '      <div class="status-chip" data-mobile-status-chip><span class="status-dot" aria-hidden="true"></span><span data-mobile-status-text>Claude idle</span></div>',
      '    </div>',
      '    <div class="input-dock" aria-label="Message input bar">',
      '      <button class="mobile-compose-fab" data-testid="mobile-compose-fab" data-open-surface="composer" type="button" aria-haspopup="dialog" aria-label="Message Claude">\u2191</button>',
      '    </div>',
      '  </section>',
      '  <div class="backdrop" data-testid="mobile-backdrop" data-mobile-backdrop aria-hidden="true"></div>',
      '  <aside class="surface-layer" aria-label="Mobile mode surfaces">',
      '    <div class="side-placeholder" aria-hidden="true"><div><strong>Right-side panel</strong><p>On iPad, approvals and plans live here while the conversation stays visible.</p></div></div>',
      '    <section class="sheet permission-sheet" data-surface="permission" data-testid="mobile-permission-sheet" role="dialog" aria-modal="true" aria-labelledby="mobilePermissionTitle" aria-hidden="true">',
      '      <div class="sheet-grip" aria-hidden="true"></div>',
      '      <div class="sheet-head">',
      '        <div class="sheet-title">',
      '          <p class="eyebrow">Tool permission</p>',
      '          <h2 id="mobilePermissionTitle">\u26a0 Claude wants to run</h2>',
      '          <p class="sheet-subtitle">Review the exact command before letting it touch this folder.</p>',
      '        </div>',
      '      </div>',
      '      <div class="sheet-content">',
      '        <div class="command-box" aria-label="Exact command"><code data-mobile-permission-command></code></div>',
      '        <div class="cwd-line"><span>cwd</span><code data-mobile-permission-cwd></code></div>',
      '        <div class="risk-line"><span>risk</span><strong data-mobile-permission-risk></strong></div>',
      '        <div class="countdown" aria-live="polite">',
      '          <div class="countdown-row"><span data-mobile-countdown-text>falls back in 45s</span><small>fail-closed</small></div>',
      '          <div class="countdown-track" aria-hidden="true"><div class="countdown-fill" data-mobile-countdown-fill></div></div>',
      '        </div>',
      '        <button class="raw-link" data-mobile-raw-toggle type="button">Show raw</button>',
      '        <pre class="raw-box" data-mobile-raw-box hidden></pre>',
      '      </div>',
      '      <div class="sheet-actions">',
      '        <button class="btn safe" data-mobile-deny-permission data-testid="mobile-deny-permission" type="button">Deny</button>',
      '        <button class="btn" data-mobile-approve-permission data-testid="mobile-approve-permission" type="button">Approve</button>',
      '      </div>',
      '    </section>',
      '    <section class="full-sheet plan-sheet" data-surface="plan" data-testid="mobile-plan-sheet" role="dialog" aria-modal="true" aria-labelledby="mobilePlanTitle" aria-hidden="true">',
      '      <header class="plan-header">',
      '        <h2 id="mobilePlanTitle">Plan \u2014 approve to start</h2>',
      '        <button class="close-btn" type="button" data-close-surface aria-label="Close plan">\u2715</button>',
      '      </header>',
      '      <div class="plan-scroll"><article class="plan-doc" data-mobile-plan-doc></article></div>',
      '      <footer class="plan-footer">',
      '        <button class="btn ghost" data-mobile-reject-plan type="button">Reject</button>',
      '        <button class="btn warn" data-mobile-comment-plan type="button">Comment</button>',
      '        <button class="btn primary" data-mobile-approve-plan type="button">Approve</button>',
      '      </footer>',
      '    </section>',
      '    <section class="sheet question-sheet" data-surface="question" data-testid="mobile-question-sheet" role="dialog" aria-modal="true" aria-labelledby="mobileQuestionTitle" aria-hidden="true">',
      '      <div class="sheet-grip" aria-hidden="true"></div>',
      '      <div class="sheet-head">',
      '        <div class="sheet-title">',
      '          <p class="eyebrow">Question</p>',
      '          <h2 id="mobileQuestionTitle" data-mobile-question-title>Which route should Claude take?</h2>',
      '          <p class="sheet-subtitle">Choose one answer from Claude\'s structured options.</p>',
      '        </div>',
      '        <button class="close-btn" type="button" data-close-surface aria-label="Close question">\u2715</button>',
      '      </div>',
      '      <div class="sheet-content">',
      '        <div class="option-list" data-mobile-question-options role="radiogroup" aria-label="Choose one answer"></div>',
      '      </div>',
      '      <div class="sheet-actions">',
      '        <button class="btn ghost" type="button" data-close-surface>Cancel</button>',
      '        <button class="btn primary" data-mobile-send-question type="button">Send</button>',
      '      </div>',
      '    </section>',
      '    <section class="sheet composer-sheet" data-surface="composer" data-testid="mobile-composer-sheet" role="dialog" aria-modal="true" aria-labelledby="mobileComposerTitle" aria-hidden="true">',
      '      <div class="sheet-grip" aria-hidden="true"></div>',
      '      <div class="sheet-head">',
      '        <div class="sheet-title">',
      '          <p class="eyebrow">Input composer</p>',
      '          <h2 id="mobileComposerTitle">Message Claude</h2>',
      '        </div>',
      '        <button class="close-btn" type="button" data-close-surface aria-label="Close composer">\u2715</button>',
      '      </div>',
      '      <div class="sheet-content composer-body">',
      '        <textarea class="composer-textarea" data-mobile-composer-text data-testid="mobile-composer-text" rows="5" placeholder="Ask Claude to change the plan, run a safe command, or stop work\u2026" autocapitalize="sentences" autocorrect="off" autocomplete="off" spellcheck="false"></textarea>',
      '        <div class="control-row" aria-label="Structured composer controls">',
      '          <button class="control-btn slash-btn" data-mobile-slash type="button" aria-label="Slash commands">/</button>',
      '          <button class="control-btn mode-toggle" data-mobile-mode-toggle type="button"><span class="toggle-light" aria-hidden="true"></span><span data-mobile-composer-mode-text>Plan mode</span></button>',
      '          <button class="control-btn stop-btn" data-mobile-stop data-testid="mobile-stop-button" type="button">\u25a0 Stop</button>',
      '        </div>',
      '        <div class="composer-actions">',
      '          <button class="round-btn" data-mobile-composer-mic type="button" aria-label="Start voice input">mic</button>',
      '          <button class="btn primary" data-mobile-send-composer data-testid="mobile-send-composer" type="button">Send</button>',
      '        </div>',
      '      </div>',
      '    </section>',
      '  </aside>',
      '</div>'
    ].join('');
  };

  MobileModeController.prototype._cacheElements = function () {
    this.messageList = this.el.querySelector('[data-mobile-message-list]');
    this.messageStack = this.el.querySelector('[data-mobile-message-stack]');
    this.statusChip = this.el.querySelector('[data-mobile-status-chip]');
    this.statusText = this.el.querySelector('[data-mobile-status-text]');
    this.modeLabel = this.el.querySelector('[data-mobile-mode-label]');
    this.needsPill = this.el.querySelector('[data-mobile-needs-pill]');
    this.backdrop = this.el.querySelector('[data-mobile-backdrop]');
    this.sheets = toArray(this.el.querySelectorAll('[data-surface]'));
    this.composerText = this.el.querySelector('[data-mobile-composer-text]');
    this.composerModeText = this.el.querySelector('[data-mobile-composer-mode-text]');
    this.permissionSheet = this.el.querySelector('[data-surface="permission"]');
    this.permissionCommand = this.el.querySelector('[data-mobile-permission-command]');
    this.permissionCwd = this.el.querySelector('[data-mobile-permission-cwd]');
    this.permissionRisk = this.el.querySelector('[data-mobile-permission-risk]');
    this.countdownText = this.el.querySelector('[data-mobile-countdown-text]');
    this.countdownFill = this.el.querySelector('[data-mobile-countdown-fill]');
    this.rawToggle = this.el.querySelector('[data-mobile-raw-toggle]');
    this.rawBox = this.el.querySelector('[data-mobile-raw-box]');
    this.approvePermissionBtn = this.el.querySelector('[data-mobile-approve-permission]');
    this.denyPermissionBtn = this.el.querySelector('[data-mobile-deny-permission]');
    this.planDoc = this.el.querySelector('[data-mobile-plan-doc]');
    this.questionTitle = this.el.querySelector('[data-mobile-question-title]');
    this.questionOptions = this.el.querySelector('[data-mobile-question-options]');
  };

  MobileModeController.prototype._bindEvents = function () {
    var self = this;

    this.el.addEventListener('click', function (event) {
      var openButton = closest(event.target, '[data-open-surface]', self.el);
      if (openButton) {
        self.openSurface(openButton.getAttribute('data-open-surface'));
        return;
      }

      var closeButton = closest(event.target, '[data-close-surface]', self.el);
      if (closeButton) {
        self.closeSurface('Claude idle');
        return;
      }

      var summary = closest(event.target, '.tool-summary', self.el);
      if (summary) {
        self._toggleToolCard(summary);
        return;
      }

      if (closest(event.target, '[data-mobile-needs-pill]', self.el)) {
        if (self.state.pendingSurface) self.openSurface(self.state.pendingSurface);
        return;
      }

      if (closest(event.target, '[data-mobile-raw-toggle]', self.el)) {
        self.toggleRawPermission();
        return;
      }

      if (closest(event.target, '[data-mobile-deny-permission]', self.el)) {
        self.denyPermission('manual');
        return;
      }

      if (closest(event.target, '[data-mobile-approve-permission]', self.el)) {
        self.approvePermission();
        return;
      }

      if (closest(event.target, '[data-mobile-reject-plan]', self.el)) {
        self.closeSurface('Claude idle \u00b7 plan rejected');
        self.addEventChip('Plan rejected');
        return;
      }

      if (closest(event.target, '[data-mobile-approve-plan]', self.el)) {
        self.closeSurface('working\u2026 \u00b7 plan approved');
        self.addEventChip('Plan approved \u00b7 TODO(wire) hook return');
        return;
      }

      if (closest(event.target, '[data-mobile-comment-plan]', self.el)) {
        self.composerText.value = 'I want to adjust the plan: ';
        self.openSurface('composer');
        return;
      }

      if (closest(event.target, '[data-mobile-send-question]', self.el)) {
        self.sendQuestionAnswer();
        return;
      }

      if (closest(event.target, '[data-mobile-slash]', self.el)) {
        self.insertComposerText('/');
        return;
      }

      if (closest(event.target, '[data-mobile-mode-toggle]', self.el)) {
        self.insertModeText();
        return;
      }

      if (closest(event.target, '[data-mobile-stop]', self.el)) {
        self.interrupt();
        return;
      }

      if (closest(event.target, '[data-mobile-composer-mic]', self.el)) {
        self.addEventChip('Mic tapped \u00b7 voice capture TODO(wire)');
        return;
      }

      if (closest(event.target, '[data-mobile-send-composer]', self.el)) {
        self.sendComposer();
      }
    });

    this.el.addEventListener('change', function (event) {
      if (closest(event.target, '.option-card', self.el)) self.updateOptionCards();
    });

    this.backdrop.addEventListener('click', function () {
      if (self.state.activeSurface === 'permission') {
        self.nudgePermission();
        return;
      }
      self.closeSurface('Claude idle');
    });

    this._boundKeydown = function (event) {
      if (!self.state.activeSurface) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (self.state.activeSurface === 'permission') self.denyPermission('manual');
        else self.closeSurface('Claude idle');
      }
    };
    document.addEventListener('keydown', this._boundKeydown);

    this._boundViewport = function () { self.syncVisualViewport(); };
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._boundViewport);
      window.visualViewport.addEventListener('scroll', this._boundViewport);
    }
    this._boundResize = function () { self.syncVisualViewport(); };
    window.addEventListener('resize', this._boundResize);
    this._boundOrientation = function () {
      window.setTimeout(function () {
        self.syncVisualViewport();
        self.scrollMessagesToBottom(true);
      }, 250);
    };
    window.addEventListener('orientationchange', this._boundOrientation);

    this._bindDragDismiss();
  };

  MobileModeController.prototype._bindDragDismiss = function () {
    var self = this;
    this.sheets.forEach(function (sheet) {
      if (sheet.classList.contains('full-sheet')) return;
      var grip = sheet.querySelector('.sheet-grip');
      if (!grip || !window.PointerEvent) return;
      var startY = 0;
      var lastY = 0;
      var dragging = false;

      grip.addEventListener('pointerdown', function (event) {
        if (window.innerWidth >= 760 && window.innerHeight >= 620) return;
        if (!sheet.classList.contains('active')) return;
        dragging = true;
        startY = event.clientY;
        lastY = startY;
        sheet.style.transition = 'none';
        try { grip.setPointerCapture(event.pointerId); } catch (_) {}
      });

      grip.addEventListener('pointermove', function (event) {
        if (!dragging) return;
        lastY = event.clientY;
        var dy = Math.max(0, lastY - startY);
        sheet.style.transform = 'translateY(' + dy + 'px)';
      });

      function finish(event) {
        if (!dragging) return;
        dragging = false;
        var dy = Math.max(0, lastY - startY);
        sheet.style.transition = '';
        sheet.style.transform = '';
        try { grip.releasePointerCapture(event.pointerId); } catch (_) {}
        if (dy > 90) {
          if (self.state.activeSurface === 'permission') self.denyPermission('dismiss');
          else self.closeSurface('Claude idle');
        }
      }

      grip.addEventListener('pointerup', finish);
      grip.addEventListener('pointercancel', finish);
    });
  };

  MobileModeController.prototype.renderConversation = function (items) {
    this._resetConversationState();
    this._appendTurnItems(items || [], true);
  };

  MobileModeController.prototype.startTurnStream = function () {
    if (this._sessionWatchTimer) return;
    var self = this;
    this._sessionWatchTimer = window.setInterval(function () {
      self._syncTurnSession();
    }, SESSION_WATCH_MS);
    this._syncTurnSession();
  };

  MobileModeController.prototype._syncTurnSession = function () {
    var sessionId = this._currentSessionId();
    if (sessionId === this.currentSessionId) return;

    this._streamGeneration += 1;
    var generation = this._streamGeneration;
    this.currentSessionId = sessionId;
    this.eventCursor = null;
    this._messageLoadQueued = false;
    this._clearEventRetry();
    this._resetConversationState();
    this._syncSessionChrome();
    this.setNeedsInput(false);
    this.setStatus('idle');

    if (!sessionId) return;
    this._pollControlEvents(generation);
    this._scheduleMessageLoad(generation, true);
  };

  MobileModeController.prototype._currentSessionId = function () {
    var app = this.app || window.app || null;
    var sessionId = app && app.currentClaudeSessionId;
    return sessionId ? String(sessionId) : null;
  };

  MobileModeController.prototype._scheduleMessageLoad = function (generation, fromStart) {
    if (generation !== this._streamGeneration || !this.currentSessionId) return;
    if (fromStart) this._messageLoadQueued = 'reset';
    else if (!this._messageLoadQueued) this._messageLoadQueued = 'append';
    if (this._messageLoadInFlight) return;
    this._drainMessageLoads(generation);
  };

  MobileModeController.prototype._drainMessageLoads = async function (generation) {
    if (this._messageLoadInFlight) return;
    this._messageLoadInFlight = true;
    try {
      while (this._messageLoadQueued && generation === this._streamGeneration && this.currentSessionId) {
        var mode = this._messageLoadQueued;
        this._messageLoadQueued = false;
        if (mode === 'reset') this._resetConversationState();
        await this._fetchMessagePages(generation);
      }
    } catch (err) {
      if (generation === this._streamGeneration) {
        this.setStatus('idle');
        this._logStreamError('message load failed', err);
      }
    } finally {
      this._messageLoadInFlight = false;
      if (this._messageLoadQueued) {
        this._scheduleMessageLoad(this._streamGeneration, false);
      }
    }
  };

  MobileModeController.prototype._fetchMessagePages = async function (generation) {
    var sessionId = this.currentSessionId;
    if (!sessionId) return;

    for (;;) {
      if (generation !== this._streamGeneration || sessionId !== this.currentSessionId) return;
      var after = this.messageCursor ? encodeTurnCursor(this.messageCursor) : null;
      var url = '/api/control/sessions/' + encodeURIComponent(sessionId) + '/messages?limit=' + TURN_PAGE_LIMIT;
      if (after) url += '&after=' + encodeURIComponent(after);

      var data = await this._fetchJson(url);
      if (generation !== this._streamGeneration || sessionId !== this.currentSessionId) return;

      var nextEpoch = data && data.epoch;
      var epochChanged = !!(this.messageEpoch && nextEpoch && nextEpoch !== this.messageEpoch);
      if ((data.reset || epochChanged) && after) {
        this._resetConversationState();
        continue;
      }
      if (data.reset || epochChanged) this._resetConversationState();

      if (nextEpoch) this.messageEpoch = nextEpoch;
      if (data.cursor) this.messageCursor = data.cursor;
      this._appendTurnItems(data.items || [], false);
      if (!data.more) break;
    }
  };

  MobileModeController.prototype._pollControlEvents = async function (generation) {
    if (generation !== this._streamGeneration || !this.currentSessionId) return;

    var url = '/api/control/events?kinds=' + encodeURIComponent(CONTROL_EVENT_KINDS) + '&timeoutMs=' + CONTROL_EVENTS_TIMEOUT_MS;
    if (this.eventCursor) url += '&cursor=' + encodeURIComponent(this.eventCursor);

    try {
      var data = await this._fetchJson(url);
      if (generation !== this._streamGeneration || !this.currentSessionId) return;
      if (data.cursor) this.eventCursor = data.cursor;

      if (data.gaps && data.gaps.length) {
        this._scheduleMessageLoad(generation, true);
      }

      var events = data.events || [];
      var sawCurrentSession = false;
      for (var i = 0; i < events.length; i++) {
        if (String(events[i].sessionId || '') !== this.currentSessionId) continue;
        sawCurrentSession = true;
        this._applyControlEvent(events[i]);
      }
      if (sawCurrentSession) this._scheduleMessageLoad(generation, false);
      this._pollControlEvents(generation);
    } catch (err) {
      if (generation !== this._streamGeneration) return;
      this._logStreamError('event poll failed', err);
      var self = this;
      this._clearEventRetry();
      this._eventRetryTimer = window.setTimeout(function () {
        self._eventRetryTimer = null;
        self._pollControlEvents(generation);
      }, EVENT_RETRY_MS);
    }
  };

  MobileModeController.prototype._applyControlEvent = function (event) {
    if (!event || !event.kind) return;
    if (event.kind === 'became_busy') {
      this.setNeedsInput(false);
      this.setStatus('working\u2026');
    } else if (event.kind === 'waiting_input') {
      this.state.pendingSurface = 'composer';
      this.setNeedsInput(true);
      this.setStatus('needs you');
    } else if (event.kind === 'became_idle' || event.kind === 'turn_ended') {
      if (this.state.pendingSurface === 'composer') this.state.pendingSurface = null;
      this.setNeedsInput(false);
      this.setStatus('idle');
    }
  };

  MobileModeController.prototype._resetConversationState = function () {
    this.turnItems = [];
    this.renderedItemIds = new Map();
    this.messageCursor = null;
    this.messageEpoch = null;
    this._paintConversation(true);
  };

  MobileModeController.prototype._appendTurnItems = function (items, forceScroll) {
    var added = false;
    for (var i = 0; i < items.length; i++) {
      var item = normalizeTurnItem(items[i]);
      if (!item) continue;
      var key = item.id;
      if (key == null || key === '') {
        key = 'local:' + (++this._localItemSeq);
        item.id = key;
      }
      if (this.renderedItemIds.has(key)) continue;
      this.renderedItemIds.set(key, true);
      this.turnItems.push(item);
      added = true;
    }
    if (added || forceScroll) this._paintConversation(forceScroll !== false);
  };

  MobileModeController.prototype._paintConversation = function (forceScroll) {
    if (!this.messageStack) return;
    clearNode(this.messageStack);
    var grouped = this._groupTurnItems(this.turnItems || []);
    for (var i = 0; i < grouped.length; i++) {
      if (grouped[i].type === 'tool') {
        this.messageStack.appendChild(this._renderToolCard(grouped[i]));
      } else {
        this.messageStack.appendChild(this._renderTurnItem(grouped[i].item));
      }
    }
    this.scrollMessagesToBottom(forceScroll);
  };

  MobileModeController.prototype._fetchJson = async function (url) {
    var response = await this._authFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ' for ' + url);
    }
    return response.json();
  };

  MobileModeController.prototype._authFetch = function (url, options) {
    options = options || {};
    if (this.app && typeof this.app.authFetch === 'function') {
      return this.app.authFetch(url, options);
    }

    var headers = {};
    if (window.authManager && typeof window.authManager.getAuthHeaders === 'function') {
      headers = window.authManager.getAuthHeaders();
    }
    var request = merge({}, options);
    request.method = request.method || 'GET';
    request.headers = merge(headers, options.headers || {});
    return fetch(url, request);
  };

  MobileModeController.prototype._clearEventRetry = function () {
    if (!this._eventRetryTimer) return;
    window.clearTimeout(this._eventRetryTimer);
    this._eventRetryTimer = null;
  };

  MobileModeController.prototype._logStreamError = function (message, err) {
    if (window.console && console.warn) console.warn('[mobile-mode] ' + message, err && err.message ? err.message : err);
  };

  MobileModeController.prototype.renderDecision = function (data) {
    // TODO(wire): Feed this from hook/control decision payloads. Channel-1
    // allow/deny/answer transport is deliberately absent in this client-shell
    // increment; buttons only update local UI stubs.
    if (!data || !data.kind) return;
    if (data.kind === 'permission') this.renderPermission(data);
    if (data.kind === 'plan') this.renderPlan(data);
    if (data.kind === 'question') this.renderQuestion(data);
  };

  MobileModeController.prototype.setDecisionStub = function (kind, data) {
    if (typeof kind === 'object') {
      data = kind;
      kind = data && data.kind;
    }
    if (!kind || !data) return;
    this.decisionStubs[kind] = merge(clone(this.decisionStubs[kind] || {}), data);
    this.renderDecision(this.decisionStubs[kind]);
  };

  MobileModeController.prototype.openSurface = function (name) {
    if (!name) {
      this.closeSurface('Claude idle');
      return;
    }

    if (name === 'permission') this.renderPermission(this.decisionStubs.permission);
    if (name === 'plan') this.renderPlan(this.decisionStubs.plan);
    if (name === 'question') this.renderQuestion(this.decisionStubs.question);

    if (this.state.activeSurface === 'permission' && name !== 'permission') this.stopCountdown();
    this.state.activeSurface = name;
    if (isDecisionSurface(name)) this.state.pendingSurface = name;

    this.body.classList.toggle('has-surface', Boolean(name));
    this._syncNeedsPill();
    this.body.dataset.surface = name || '';

    for (var i = 0; i < this.sheets.length; i++) {
      var sheet = this.sheets[i];
      var active = sheet.getAttribute('data-surface') === name;
      sheet.classList.toggle('active', active);
      sheet.setAttribute('aria-hidden', active ? 'false' : 'true');
    }

    if (name === 'permission') {
      this.startCountdown();
      this.setStatus('working\u2026 \u00b7 waiting for permission');
      this._focusSurface(name, this.denyPermissionBtn);
    } else if (name === 'plan') {
      this.stopCountdown();
      this.setStatus('working\u2026 \u00b7 plan waiting');
      this._focusSurface(name);
    } else if (name === 'question') {
      this.stopCountdown();
      this.setStatus('working\u2026 \u00b7 question waiting');
      this._focusSurface(name);
    } else if (name === 'composer') {
      this.stopCountdown();
      this.setStatus(this._statusAfterSurfaceChange('idle'));
      this._focusSurface(name, this.composerText);
    }

    this.syncVisualViewport();
  };

  MobileModeController.prototype.closeSurface = function (nextStatus) {
    if (this.state.activeSurface === 'permission') this.stopCountdown();
    this._deactivateFocusTrap();
    if (document.activeElement && this.el.contains(document.activeElement) && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }

    this.state.activeSurface = null;
    if (!this.state.needsInput) this.state.pendingSurface = null;
    else this.state.pendingSurface = 'composer';
    this.body.classList.remove('has-surface');
    this._syncNeedsPill();
    this.body.dataset.surface = '';

    for (var i = 0; i < this.sheets.length; i++) {
      this.sheets[i].classList.remove('active', 'nudge');
      this.sheets[i].setAttribute('aria-hidden', 'true');
      this.sheets[i].style.transform = '';
      this.sheets[i].style.transition = '';
    }

    if (nextStatus) this.setStatus(this._statusAfterSurfaceChange(nextStatus));
    this.syncVisualViewport();
  };

  MobileModeController.prototype.renderPermission = function (data) {
    data = data || this.decisionStubs.permission;
    this.decisionStubs.permission = merge(clone(this.decisionStubs.permission), data);
    data = this.decisionStubs.permission;

    var destructive = data.destructive;
    if (destructive == null) destructive = this._isDestructiveCommand(data.command || '');

    this.permissionCommand.textContent = data.command || '';
    this.permissionCwd.textContent = data.cwd || '';
    this.permissionRisk.textContent = data.risk || (destructive ? 'Destructive filesystem operation' : 'Read-only-ish command');
    this.rawBox.textContent = JSON.stringify(data, null, 2);
    this.rawBox.hidden = true;
    this.rawToggle.textContent = 'Show raw';
    this.approvePermissionBtn.classList.toggle('danger', !!destructive);
    this.approvePermissionBtn.classList.toggle('primary', !destructive);
    this.approvePermissionBtn.setAttribute('data-destructive', destructive ? 'true' : 'false');
    this.permissionSheet.classList.toggle('destructive-command', !!destructive);
  };

  MobileModeController.prototype.renderPlan = function (data) {
    data = data || this.decisionStubs.plan;
    this.decisionStubs.plan = merge(clone(this.decisionStubs.plan), data);
    this._renderPlanText(this.decisionStubs.plan.plan || '');
  };

  MobileModeController.prototype.renderQuestion = function (data) {
    data = data || this.decisionStubs.question;
    this.decisionStubs.question = merge(clone(this.decisionStubs.question), data);
    data = this.decisionStubs.question;
    this.questionTitle.textContent = data.question || 'Claude has a question';
    clearNode(this.questionOptions);

    var options = data.options || [];
    for (var i = 0; i < options.length; i++) {
      var label = document.createElement('label');
      label.className = 'option-card' + (i === 0 ? ' is-selected' : '');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'mobileQuestionChoice';
      input.value = options[i].label || ('Option ' + (i + 1));
      input.checked = i === 0;
      var copy = document.createElement('span');
      var strong = document.createElement('strong');
      strong.textContent = options[i].label || ('Option ' + (i + 1));
      var desc = document.createElement('span');
      desc.textContent = options[i].description || '';
      copy.appendChild(strong);
      copy.appendChild(desc);
      label.appendChild(input);
      label.appendChild(copy);
      this.questionOptions.appendChild(label);
    }
  };

  MobileModeController.prototype.sendComposer = function () {
    var raw = this.composerText.value;
    if (!raw || !raw.replace(/\s+/g, '').length) return;

    var enter = this.encodeKey({ key: 'enter' }) || '\r';
    var data = this.normalizeLineEndings(raw) + enter;
    this.sendInput(data);
    this.addUserMessage(raw);
    this.composerText.value = '';
    this.closeSurface('Claude idle \u00b7 sent');
  };

  MobileModeController.prototype.interrupt = function () {
    var ctrlC = this.encodeKey({ char: 'c', ctrl: true }) || '\x03';
    this.sendInput(ctrlC);
    this.setStatus('Claude idle \u00b7 interrupted');
    this.addEventChip('Stop tapped \u00b7 Ctrl-C sent');
  };

  MobileModeController.prototype.insertModeText = function () {
    var text = this.state.composerMode === 'plan' ? '/plan ' : '/accept-edits ';
    this.insertComposerText(text);
    this.state.composerMode = this.state.composerMode === 'plan' ? 'accept-edits' : 'plan';
    this.composerModeText.textContent = this.state.composerMode === 'plan' ? 'Plan mode' : 'Accept edits';
  };

  MobileModeController.prototype.insertComposerText = function (text) {
    var ta = this.composerText;
    if (!ta) return;
    var start = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
    var end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    var next = start + text.length;
    try { ta.setSelectionRange(next, next); } catch (_) {}
    try { ta.focus({ preventScroll: true }); } catch (__) { ta.focus(); }
  };

  MobileModeController.prototype.sendQuestionAnswer = function () {
    var selected = this.questionOptions.querySelector('input[name="mobileQuestionChoice"]:checked');
    var answer = selected ? selected.value : 'No answer';
    this.closeSurface('Claude idle \u00b7 answered');
    this.addEventChip('Answered question \u00b7 ' + answer + ' \u00b7 TODO(wire) hook return');
  };

  MobileModeController.prototype.approvePermission = function () {
    var cmd = this.decisionStubs.permission.command || '';
    this.stopCountdown();
    this.closeSurface('working\u2026 \u00b7 approved');
    this.addEventChip('Approved \u00b7 TODO(wire) hook return: ' + cmd);
  };

  MobileModeController.prototype.denyPermission = function (reason) {
    var timeout = reason === 'timeout';
    var dismiss = reason === 'dismiss';
    var cmd = this.decisionStubs.permission.command || '';
    this.stopCountdown();
    this.closeSurface(timeout ? 'Claude idle \u00b7 denied by timeout' : 'Claude idle \u00b7 denied');
    this.addEventChip((timeout ? 'Denied by timeout' : (dismiss ? 'Denied by dismiss' : 'Denied')) + ' \u00b7 command was not run: ' + cmd);
  };

  MobileModeController.prototype.toggleRawPermission = function () {
    this.rawBox.hidden = !this.rawBox.hidden;
    this.rawToggle.textContent = this.rawBox.hidden ? 'Show raw' : 'Hide raw';
  };

  MobileModeController.prototype.nudgePermission = function () {
    if (!this.permissionSheet) return;
    this.permissionSheet.classList.remove('nudge');
    void this.permissionSheet.offsetWidth;
    this.permissionSheet.classList.add('nudge');
  };

  MobileModeController.prototype.startCountdown = function () {
    var self = this;
    this.stopCountdown();
    this.state.countdownDeadline = Date.now() + this.state.countdownTotalMs;
    this.updateCountdown();
    this.state.countdownTimer = window.setInterval(function () { self.updateCountdown(); }, 250);
  };

  MobileModeController.prototype.stopCountdown = function () {
    if (this.state.countdownTimer) {
      window.clearInterval(this.state.countdownTimer);
      this.state.countdownTimer = null;
    }
  };

  MobileModeController.prototype.updateCountdown = function () {
    var remainingMs = Math.max(0, this.state.countdownDeadline - Date.now());
    var seconds = Math.ceil(remainingMs / 1000);
    var pct = this.state.countdownTotalMs ? remainingMs / this.state.countdownTotalMs : 0;
    this.countdownText.textContent = 'falls back in ' + seconds + 's';
    this.countdownFill.style.setProperty('--mobile-countdown-pct', String(Math.max(0, Math.min(1, pct))));
    if (remainingMs <= 0) {
      this.stopCountdown();
      this.denyPermission('timeout');
    }
  };

  MobileModeController.prototype.syncVisualViewport = function () {
    var keyboardBottom = 0;
    if (window.visualViewport) {
      keyboardBottom = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
      this.root.style.setProperty('--visual-viewport-height', Math.round(window.visualViewport.height) + 'px');
    }
    this.root.style.setProperty('--keyboard-bottom', Math.round(keyboardBottom) + 'px');
    this.body.style.setProperty('--keyboard-bottom', Math.round(keyboardBottom) + 'px');
    if (this.state.activeSurface === 'composer') this.scrollMessagesToBottom(true);
  };

  MobileModeController.prototype.setStatus = function (text) {
    this.statusText.textContent = text;
    this.statusChip.classList.toggle('working', /working|waiting|running|needs/i.test(text));
  };

  MobileModeController.prototype._statusAfterSurfaceChange = function (fallback) {
    if (this.state.needsInput && (!fallback || /^Claude idle|^idle$/i.test(fallback))) return 'needs you';
    return fallback || (this.state.needsInput ? 'needs you' : 'idle');
  };

  MobileModeController.prototype.setNeedsInput = function (needsInput) {
    this.state.needsInput = !!needsInput;
    this._syncNeedsPill();
  };

  MobileModeController.prototype._syncNeedsPill = function () {
    var active = !!(this.state.needsInput || isDecisionSurface(this.state.pendingSurface) || isDecisionSurface(this.state.activeSurface));
    this.body.classList.toggle('has-decision', active);
  };

  MobileModeController.prototype.addUserMessage = function (text) {
    var row = document.createElement('div');
    row.className = 'message-row user';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    var p = document.createElement('p');
    p.textContent = text;
    bubble.appendChild(p);
    row.appendChild(bubble);
    this.messageStack.appendChild(row);
    this.scrollMessagesToBottom(true);
  };

  MobileModeController.prototype.addAssistantMessage = function (text) {
    var row = document.createElement('div');
    row.className = 'message-row assistant';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    var label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = 'Claude';
    var p = document.createElement('p');
    p.textContent = text;
    bubble.appendChild(label);
    bubble.appendChild(p);
    row.appendChild(bubble);
    this.messageStack.appendChild(row);
    this.scrollMessagesToBottom(true);
  };

  MobileModeController.prototype.addEventChip = function (text) {
    var row = document.createElement('div');
    row.className = 'message-row event-row';
    var chip = document.createElement('div');
    chip.className = 'event-chip';
    chip.textContent = text;
    row.appendChild(chip);
    this.messageStack.appendChild(row);
    this.scrollMessagesToBottom(true);
  };

  MobileModeController.prototype.scrollMessagesToBottom = function (force) {
    var list = this.messageList;
    if (!list) return;
    var distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (!force && distance > 180) return;
    window.requestAnimationFrame(function () {
      list.scrollTop = list.scrollHeight;
    });
  };

  MobileModeController.prototype.encodeKey = function (spec) {
    var encoder = (typeof window !== 'undefined' && window.KeyEncoder) ? window.KeyEncoder : null;
    if (!encoder || !encoder.encode) return null;
    return encoder.encode(spec, this._terminalModes());
  };

  MobileModeController.prototype.sendInput = function (data) {
    if (this.app && typeof this.app.send === 'function') {
      this.app.send({ type: 'input', data: data });
    }
  };

  MobileModeController.prototype.normalizeLineEndings = function (text) {
    if (typeof window.attachClipboardHandler !== 'undefined' && window.attachClipboardHandler.normalizeLineEndings) {
      return window.attachClipboardHandler.normalizeLineEndings(text);
    }
    return String(text).replace(/\r\n/g, '\r').replace(/\n/g, '\r');
  };

  MobileModeController.prototype.updateOptionCards = function () {
    var cards = this.el.querySelectorAll('.option-card');
    for (var i = 0; i < cards.length; i++) {
      var input = cards[i].querySelector('input');
      cards[i].classList.toggle('is-selected', Boolean(input && input.checked));
    }
  };

  MobileModeController.prototype._terminalModes = function () {
    var modes = {};
    var term = this.app && this.app.terminal;
    if (term && term.modes) {
      modes.applicationCursorKeys = !!term.modes.applicationCursorKeysMode;
      modes.bracketedPaste = !!term.modes.bracketedPasteMode;
    }
    return modes;
  };

  MobileModeController.prototype._syncSessionChrome = function () {
    var nameEl = this.el.querySelector('[data-mobile-session-name]');
    var name = (this.app && (this.app.currentClaudeSessionName || this.app.currentClaudeSessionId)) || 'mobile-mode shell';
    nameEl.textContent = name;
    var mode = (this.app && this.app.currentMode) || 'code';
    this.modeLabel.textContent = mode + ' mode';
  };

  MobileModeController.prototype._groupTurnItems = function (items) {
    var out = [];
    var byToolUseId = new Map();

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item) continue;
      if (item.kind === 'tool-call') {
        var group = { type: 'tool', call: item, result: null };
        out.push(group);
        if (item.toolUseId) byToolUseId.set(item.toolUseId, group);
      } else if (item.kind === 'tool-result') {
        var existing = item.toolUseId ? byToolUseId.get(item.toolUseId) : null;
        if (existing) existing.result = item;
        else out.push({ type: 'tool', call: null, result: item });
      } else {
        out.push({ type: 'item', item: item });
      }
    }
    return out;
  };

  MobileModeController.prototype._renderTurnItem = function (item) {
    if (item.kind === 'user-text') return this._renderBubble('user', null, item.text || '');
    if (item.kind === 'assistant-text') return this._renderBubble('assistant', 'Claude', item.text || '');
    if (item.kind === 'thinking') return this._renderEvent('thinking\u2026 ' + (item.text || item.thinking || ''));
    return this._renderEvent(item.text || item.kind || 'event');
  };

  MobileModeController.prototype._renderBubble = function (who, labelText, text) {
    var row = document.createElement('div');
    row.className = 'message-row ' + who;
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (labelText) {
      var label = document.createElement('div');
      label.className = 'message-label';
      label.textContent = labelText;
      bubble.appendChild(label);
    }
    var p = document.createElement('p');
    p.textContent = text;
    bubble.appendChild(p);
    row.appendChild(bubble);
    return row;
  };

  MobileModeController.prototype._renderEvent = function (text) {
    var row = document.createElement('div');
    row.className = 'message-row event-row';
    var chip = document.createElement('div');
    chip.className = 'event-chip';
    chip.textContent = text;
    row.appendChild(chip);
    return row;
  };

  MobileModeController.prototype._renderToolCard = function (group) {
    var call = group.call || {};
    var result = group.result || {};
    var name = call.name || result.name || 'tool';
    var target = this._toolTarget(call);

    var card = document.createElement('article');
    card.className = 'tool-card';
    card.setAttribute('aria-label', 'Tool card: ' + name);

    var summary = document.createElement('button');
    summary.className = 'tool-summary';
    summary.type = 'button';
    summary.setAttribute('aria-expanded', 'false');

    var disclosure = document.createElement('span');
    disclosure.className = 'tool-disclosure';
    disclosure.setAttribute('aria-hidden', 'true');
    disclosure.textContent = '\u25b8';
    summary.appendChild(disclosure);

    var line = document.createElement('span');
    line.className = 'tool-line';
    line.appendChild(document.createTextNode(name === 'Bash' ? 'Ran ' : 'Used ' + name + ' '));
    var code = document.createElement('code');
    code.textContent = target;
    line.appendChild(code);
    summary.appendChild(line);

    var status = document.createElement('span');
    status.className = 'tool-result' + (result.isError ? ' error' : '');
    status.textContent = result.isError ? '!' : '\u2713';
    summary.appendChild(status);
    card.appendChild(summary);

    var details = document.createElement('div');
    details.className = 'tool-details';
    var detailsInner = document.createElement('div');
    var body = document.createElement('div');
    body.className = 'tool-body';

    var grid = document.createElement('div');
    grid.className = 'detail-grid';
    this._appendDetail(grid, 'tool', name);
    if (call.toolUseId || result.toolUseId) this._appendDetail(grid, 'id', call.toolUseId || result.toolUseId);
    if (call.input) this._appendDetail(grid, 'input', stringify(call.input));
    body.appendChild(grid);

    if (result.content != null) {
      var pre = document.createElement('pre');
      pre.className = result.isError ? 'terminal-output error' : 'terminal-output';
      pre.textContent = stringify(result.content);
      body.appendChild(pre);
    }

    detailsInner.appendChild(body);
    details.appendChild(detailsInner);
    card.appendChild(details);
    return card;
  };

  MobileModeController.prototype._appendDetail = function (grid, labelText, value) {
    var label = document.createElement('span');
    label.textContent = labelText;
    var code = document.createElement('code');
    code.textContent = value;
    grid.appendChild(label);
    grid.appendChild(code);
  };

  MobileModeController.prototype._toolTarget = function (call) {
    if (!call) return 'result';
    var input = call.input || {};
    if (typeof input === 'string') return input;
    if (input.command) return input.command;
    if (input.file_path) return input.file_path;
    if (input.path) return input.path;
    return call.name || 'tool';
  };

  MobileModeController.prototype._toggleToolCard = function (summary) {
    var card = closest(summary, '.tool-card', this.el);
    if (!card) return;
    var expanded = !card.classList.contains('expanded');
    card.classList.toggle('expanded', expanded);
    summary.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  };

  MobileModeController.prototype._renderPlanText = function (text) {
    clearNode(this.planDoc);
    var lines = String(text || '').split(/\r?\n/);
    var list = null;
    var fence = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^```/.test(line)) {
        if (fence) {
          this.planDoc.appendChild(fence);
          fence = null;
        } else {
          fence = document.createElement('pre');
          fence.className = 'fake-diff';
        }
        list = null;
        continue;
      }
      if (fence) {
        fence.textContent += (fence.textContent ? '\n' : '') + line;
        continue;
      }
      if (!line.trim()) {
        list = null;
        continue;
      }
      var heading = line.match(/^#{1,3}\s+(.+)$/);
      if (heading) {
        var h = document.createElement('h3');
        h.textContent = heading[1];
        this.planDoc.appendChild(h);
        list = null;
        continue;
      }
      var check = line.match(/^[-*]\s+\[(x| )\]\s+(.+)$/i);
      if (check) {
        if (!list) {
          list = document.createElement('ul');
          list.className = 'checklist';
          this.planDoc.appendChild(list);
        }
        var li = document.createElement('li');
        var box = document.createElement('span');
        box.className = 'box-check';
        box.textContent = check[1].toLowerCase() === 'x' ? '\u2713' : '\u2022';
        var span = document.createElement('span');
        span.textContent = check[2];
        li.appendChild(box);
        li.appendChild(span);
        list.appendChild(li);
        continue;
      }
      var p = document.createElement('p');
      p.textContent = line;
      this.planDoc.appendChild(p);
      list = null;
    }
    if (fence) this.planDoc.appendChild(fence);
  };

  MobileModeController.prototype._focusSurface = function (name, preferred) {
    var sheet = this.el.querySelector('[data-surface="' + name + '"]');
    if (!sheet) return;
    this._activateFocusTrap(sheet);
    var target = preferred || sheet.querySelector('button, textarea, input, [tabindex]:not([tabindex="-1"])');
    if (!target) return;
    window.requestAnimationFrame(function () {
      try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
    });
  };

  MobileModeController.prototype._activateFocusTrap = function (surface) {
    this._deactivateFocusTrap();
    this._lastActiveElement = document.activeElement;
    var self = this;
    this._focusTrap = function (event) {
      if (event.key !== 'Tab') return;
      var focusable = toArray(surface.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      focusable = focusable.filter(function (el) { return el.offsetParent !== null; });
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    surface.addEventListener('keydown', this._focusTrap);
    this._focusTrapSurface = surface;
    self.syncVisualViewport();
  };

  MobileModeController.prototype._deactivateFocusTrap = function () {
    if (this._focusTrap && this._focusTrapSurface) {
      this._focusTrapSurface.removeEventListener('keydown', this._focusTrap);
    }
    this._focusTrap = null;
    this._focusTrapSurface = null;
    if (this._lastActiveElement && typeof this._lastActiveElement.focus === 'function' && document.contains(this._lastActiveElement)) {
      try { this._lastActiveElement.focus({ preventScroll: true }); } catch (_) {}
    }
    this._lastActiveElement = null;
  };

  MobileModeController.prototype._isDestructiveCommand = function (command) {
    return /\b(rm\s+-rf|del\s+\/s|rmdir\s+\/s|remove-item\b.*\b-recurse\b|git\s+clean\s+-fd|drop\s+table)\b/i.test(command || '');
  };

  function init(options) {
    options = options || {};
    if (options.isMobile !== true) return null;
    if (!document.body.classList.contains('is-mobile')) return null;
    if (controller) return controller;
    controller = new MobileModeController(options);
    controller.init();
    api.controller = controller;
    return controller;
  }

  function requireController() {
    return controller;
  }

  var api = {
    init: init,
    getController: requireController,
    openSurface: function (name) { if (controller) controller.openSurface(name); },
    closeSurface: function () { if (controller) controller.closeSurface('Claude idle'); },
    renderConversation: function (items) { if (controller) controller.renderConversation(items); },
    renderDecision: function (data) { if (controller) controller.renderDecision(data); },
    setDecisionStub: function (kind, data) { if (controller) controller.setDecisionStub(kind, data); },
    STUB_DECISIONS: STUB_DECISIONS
  };

  function isDecisionSurface(name) {
    return name === 'permission' || name === 'plan' || name === 'question';
  }

  function toArray(list) {
    return Array.prototype.slice.call(list || []);
  }

  function closest(node, selector, stopAt) {
    while (node && node !== document && node !== stopAt.parentNode) {
      if (matches(node, selector)) return node;
      if (node === stopAt) break;
      node = node.parentNode;
    }
    return null;
  }

  function matches(node, selector) {
    if (!node || node.nodeType !== 1) return false;
    var fn = node.matches || node.msMatchesSelector || node.webkitMatchesSelector;
    return fn ? fn.call(node, selector) : false;
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function encodeTurnCursor(cursor) {
    if (!cursor || !cursor.epoch) return '';
    return JSON.stringify({ epoch: String(cursor.epoch), offset: Number(cursor.offset) || 0 });
  }

  function normalizeTurnItem(item) {
    if (!item || typeof item !== 'object') return null;
    var kind = String(item.kind || '');
    if (!/^(user-text|assistant-text|tool-call|tool-result|thinking)$/.test(kind)) return null;
    var out = {
      id: item.id == null ? null : String(item.id),
      kind: kind
    };
    if (item.uuid != null) out.uuid = String(item.uuid);
    if (item.timestamp != null) out.timestamp = item.timestamp;
    if (item.text != null) out.text = String(item.text);
    if (item.thinking != null) out.thinking = String(item.thinking);
    if (item.toolUseId != null) out.toolUseId = String(item.toolUseId);
    if (item.name != null) out.name = String(item.name);
    if (Object.prototype.hasOwnProperty.call(item, 'input')) out.input = item.input;
    if (Object.prototype.hasOwnProperty.call(item, 'content')) out.content = item.content;
    if (Object.prototype.hasOwnProperty.call(item, 'isError')) out.isError = !!item.isError;
    return out;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function merge(target, source) {
    target = target || {};
    source = source || {};
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    }
    return target;
  }

  function stringify(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
  }

  window.MobileMode = api;
}());
