(function () {
  'use strict';

  var config = window.__AI_OR_DIE_ARTIFACT_REVIEW__ || {};
  var targetOrigin = '*';
  var pending = Object.create(null);
  var nextId = 1;

  function clone(value) {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function post(type, payload) {
    var id = 'artifact-' + Date.now() + '-' + (nextId++);
    var message = {
      source: 'ai-or-die-artifact-sdk',
      type: type,
      id: id,
      sessionId: config.sessionId || null,
      key: config.key || null,
      payload: payload || {},
    };
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, targetOrigin);
    } else {
      window.postMessage(message, targetOrigin);
    }
    return id;
  }

  function request(type, payload, timeoutMs) {
    var id = post(type, payload);
    return new Promise(function (resolve, reject) {
      var timeout = setTimeout(function () {
        delete pending[id];
        reject(new Error('Timed out waiting for artifact host response'));
      }, typeof timeoutMs === 'number' ? timeoutMs : 30000);
      pending[id] = {
        resolve: resolve,
        reject: reject,
        timeout: timeout,
      };
    });
  }

  function readDomSnapshot() {
    try {
      return {
        title: document.title || '',
        url: String(window.location.href || ''),
        bodyText: document.body ? document.body.innerText.slice(0, 20000) : '',
        html: document.documentElement ? document.documentElement.outerHTML.slice(0, 200000) : '',
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        },
      };
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
  }

  function normalizePrompts(prompts) {
    if (Array.isArray(prompts)) return prompts;
    if (prompts == null) return [];
    return [String(prompts)];
  }

  function queuePrompts(prompts, options) {
    options = options || {};
    return post(config.promptsMessageType || 'artifact-prompts', {
      prompts: normalizePrompts(prompts),
      domSnapshot: Object.prototype.hasOwnProperty.call(options, 'domSnapshot')
        ? clone(options.domSnapshot)
        : readDomSnapshot(),
    });
  }

  function recordLayoutWarnings(warnings) {
    return post(config.layoutWarningsMessageType || 'artifact-layout-warnings', {
      layout_warnings: Array.isArray(warnings) ? clone(warnings) : [],
    });
  }

  function handleMessage(event) {
    var data = event && event.data;
    if (!data || data.source !== 'ai-or-die-artifact-host') return;
    if (data.sessionId && config.sessionId && data.sessionId !== config.sessionId) return;

    var waiter = data.replyTo && pending[data.replyTo];
    if (waiter) {
      clearTimeout(waiter.timeout);
      delete pending[data.replyTo];
      if (data.error) waiter.reject(new Error(data.error));
      else waiter.resolve(data.payload);
    }

    if (data.type === 'agent-reply') {
      window.dispatchEvent(new CustomEvent('ai-or-die-artifact-agent-reply', {
        detail: data.payload || {},
      }));
    }
    if (data.type === 'presence') {
      window.dispatchEvent(new CustomEvent('ai-or-die-artifact-presence', {
        detail: data.payload || {},
      }));
    }
  }

  window.addEventListener('message', handleMessage);

  var api = {
    config: clone(config),
    post: post,
    request: request,
    prompt: queuePrompts,
    queuePrompts: queuePrompts,
    ask: queuePrompts,
    warnLayout: recordLayoutWarnings,
    recordLayoutWarnings: recordLayoutWarnings,
    snapshot: readDomSnapshot,
  };

  window.lavish = window.lavish || api;
  window.aiOrDieArtifact = api;
  post('artifact-ready', { domSnapshot: readDomSnapshot() });
})();
