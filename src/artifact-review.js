'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_POLL_HOLD_MS = 25000;
const DEFAULT_POLL_HEARTBEAT_MS = 5000;
const DEFAULT_SSE_HEARTBEAT_MS = 15000;
// Bound the artifact-push await so a stalled PTY write can't hold the /prompts
// HTTP response open. On timeout we treat the push as failed and re-queue.
const PUSH_TIMEOUT_MS = 4000;

function realpathOrResolve(file) {
  let resolved = path.resolve(file);
  try {
    resolved = fs.realpathSync(resolved);
  } catch (_) {
    /* keep resolved lexical path */
  }
  return resolved;
}

function artifactKeyForFile(file) {
  return crypto
    .createHash('sha256')
    .update(realpathOrResolve(file))
    .digest('hex')
    .slice(0, 16);
}

function createAssetTokenSigner(secret) {
  function mint(sessionId) {
    return crypto
      .createHmac('sha256', secret)
      .update(String(sessionId))
      .digest('base64url');
  }

  function verify(sessionId, token) {
    if (typeof token !== 'string') return false;
    try {
      const expected = Buffer.from(mint(sessionId));
      const actual = Buffer.from(token);
      if (expected.length !== actual.length) return false;
      return crypto.timingSafeEqual(expected, actual);
    } catch (_) {
      return false;
    }
  }

  return { mint, verify };
}

function cloneArray(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function nowIso() {
  return new Date().toISOString();
}

function feedbackSnapshot(review) {
  const prompts = cloneArray(review.queuedPrompts);
  const layoutWarnings = cloneArray(review.layoutWarnings);
  return {
    prompts,
    layout_warnings: layoutWarnings,
    dom_snapshot: review.domSnapshot,
    _ack: {
      promptCount: prompts.length,
      promptsJson: JSON.stringify(prompts),
      warningsJson: JSON.stringify(layoutWarnings),
    },
  };
}

function feedbackHasData(snapshot) {
  return !!snapshot && (
    (Array.isArray(snapshot.prompts) && snapshot.prompts.length > 0) ||
    (Array.isArray(snapshot.layout_warnings) && snapshot.layout_warnings.length > 0)
  );
}

// Render queued human prompts into a single message suitable for injecting into
// the CLI as a new user turn (the artifact-push path). Pure + exported so the
// gate decision and wording are unit-testable without a live PTY. Accepts both
// the panel's prompt objects ({prompt, text, sourceLine}) and bare-string prompts
// (curl/legacy). Returns '' when there is nothing actionable to push (caller
// skips injection on empty).
function normalizeFeedbackPrompt(p) {
  if (typeof p === 'string') {
    return p.trim() ? { prompt: p.trim() } : null;
  }
  if (p && typeof p.prompt === 'string' && p.prompt.trim()) {
    return {
      prompt: p.prompt.trim(),
      text: typeof p.text === 'string' ? p.text : '',
      sourceLine: typeof p.sourceLine === 'number' ? p.sourceLine : undefined,
    };
  }
  return null;
}
function formatFeedbackForAgent(prompts) {
  const items = (Array.isArray(prompts) ? prompts : [])
    .map(normalizeFeedbackPrompt)
    .filter(Boolean);
  if (items.length === 0) return '';
  const lines = items.map((p, i) => {
    const quoted = p.text && p.text.trim()
      ? ' (re: "' + p.text.trim().slice(0, 160) + '")'
      : '';
    const where = typeof p.sourceLine === 'number' ? ' [line ' + p.sourceLine + ']' : '';
    return (i + 1) + '.' + where + quoted + ' ' + p.prompt;
  });
  return (
    'Human review feedback from the artifact panel (you were idle, so this was '
    + 'delivered as a new turn instead of through artifact_poll). Address these in '
    + 'the open artifact, then reply with the artifact_reply tool:\n'
    + lines.join('\n')
  );
}

// Build the raw bytes to inject into the CLI PTY for an artifact push. Pure +
// exported so the security-sensitive sanitization is unit-testable. Strips ALL
// C0 control bytes and DEL except TAB and LF (this removes ESC, so the bracketed-
// paste markers and any other escape/CSI sequence in the human text cannot
// survive), which also drops CR so the only submit is the trailing CR we add.
// Wraps in a bracketed paste so multi-line feedback enters the composer
// atomically; size-capped to bound a single injection.
function buildArtifactPushPayload(text) {
  if (!text || typeof text !== 'string') return '';
  const safe = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, 4000);
  return '\x1b[200~' + safe + '\x1b[201~\r';
}

class ArtifactReviewStore extends EventEmitter {
  constructor() {
    super();
    this._reviews = new Map();
  }

  open(aiSessionId, file) {
    if (!aiSessionId || typeof aiSessionId !== 'string') {
      throw new TypeError('aiSessionId is required');
    }
    if (!file || typeof file !== 'string') {
      throw new TypeError('file is required');
    }

    const resolvedFile = realpathOrResolve(file);
    const existing = this._reviews.get(aiSessionId);
    const review = existing || {
      aiSessionId,
      file: resolvedFile,
      key: artifactKeyForFile(resolvedFile),
      status: 'open',
      queuedPrompts: [],
      layoutWarnings: [],
      domSnapshot: null,
      chat: [],
      presence: { connected: false, lastSeen: null },
      updatedAt: nowIso(),
    };

    review.aiSessionId = aiSessionId;
    review.file = resolvedFile;
    review.key = artifactKeyForFile(resolvedFile);
    review.status = 'open';
    if (!Array.isArray(review.queuedPrompts)) review.queuedPrompts = [];
    if (!Array.isArray(review.layoutWarnings)) review.layoutWarnings = [];
    if (!Array.isArray(review.chat)) review.chat = [];
    if (!review.presence || typeof review.presence !== 'object') {
      review.presence = { connected: false, lastSeen: null };
    }
    review.updatedAt = nowIso();

    this._reviews.set(aiSessionId, review);
    return review;
  }

  queuePrompts(aiSessionId, prompts, domSnapshot) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    const queued = cloneArray(prompts);
    if (queued.length > 0) {
      review.queuedPrompts.push(...queued);
    }
    if (domSnapshot !== undefined) {
      review.domSnapshot = domSnapshot;
    }
    review.updatedAt = nowIso();

    if (queued.length > 0) {
      this.emit('feedback', { aiSessionId, kind: 'prompts', review });
    }
    return review;
  }

  recordLayoutWarnings(aiSessionId, warnings) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    const nextWarnings = cloneArray(warnings);
    const currentJson = JSON.stringify(review.layoutWarnings || []);
    const nextJson = JSON.stringify(nextWarnings);
    const changed = currentJson !== nextJson;

    if (changed) {
      review.layoutWarnings = nextWarnings;
      review.updatedAt = nowIso();
    }

    if (changed && nextWarnings.length > 0) {
      this.emit('feedback', { aiSessionId, kind: 'layout-warnings', review });
    }

    return { review, changed };
  }

  takeFeedback(aiSessionId) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    const snapshot = feedbackSnapshot(review);
    review.queuedPrompts = [];
    review.layoutWarnings = [];
    review.updatedAt = nowIso();

    return {
      prompts: snapshot.prompts,
      layout_warnings: snapshot.layout_warnings,
      dom_snapshot: snapshot.dom_snapshot,
    };
  }

  peekFeedback(aiSessionId) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;
    return feedbackSnapshot(review);
  }

  ackFeedback(aiSessionId, snapshot) {
    const review = this._reviews.get(aiSessionId);
    if (!review || !snapshot) return null;

    const ack = snapshot._ack || {};
    const promptCount = Number.isFinite(ack.promptCount)
      ? Math.max(0, ack.promptCount)
      : cloneArray(snapshot.prompts).length;
    const promptsJson = typeof ack.promptsJson === 'string'
      ? ack.promptsJson
      : JSON.stringify(cloneArray(snapshot.prompts));
    if (promptCount > 0 && JSON.stringify(review.queuedPrompts.slice(0, promptCount)) === promptsJson) {
      review.queuedPrompts.splice(0, promptCount);
    }

    const warningsJson = typeof ack.warningsJson === 'string'
      ? ack.warningsJson
      : JSON.stringify(cloneArray(snapshot.layout_warnings));
    if (warningsJson !== '[]' && JSON.stringify(review.layoutWarnings || []) === warningsJson) {
      review.layoutWarnings = [];
    }

    review.updatedAt = nowIso();
    return review;
  }

  // Restore prompts that were claimed (acked) for a push that then failed, back to
  // the FRONT of the queue so order is preserved (FIFO) ahead of any prompts that
  // arrived during the push window. Re-emits 'feedback' so an in-flight poll picks
  // them up. Used only by the artifact-push re-queue path.
  restoreClaimedFeedback(aiSessionId, snapshot) {
    const review = this._reviews.get(aiSessionId);
    if (!review || !snapshot) return null;
    const prompts = cloneArray(snapshot.prompts);
    if (prompts.length > 0) {
      review.queuedPrompts.unshift(...prompts);
      if (snapshot.dom_snapshot !== undefined && review.domSnapshot == null) {
        review.domSnapshot = snapshot.dom_snapshot;
      }
      review.updatedAt = nowIso();
      this.emit('feedback', { aiSessionId, kind: 'prompts', review });
    }
    return review;
  }

  addAgentReply(aiSessionId, text) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    const reply = {
      role: 'agent',
      text: text == null ? '' : String(text),
      at: nowIso(),
    };
    review.chat.push(reply);
    review.updatedAt = nowIso();

    this.emit('agent-reply', { aiSessionId, text: reply.text, reply, review });
    return reply;
  }

  setPresence(aiSessionId, presence) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    review.presence = Object.assign({}, review.presence || {}, presence || {});
    review.updatedAt = nowIso();
    this.emit('presence', { aiSessionId, presence: review.presence, review });
    return review.presence;
  }

  end(aiSessionId) {
    const review = this._reviews.get(aiSessionId);
    if (!review) return null;

    review.status = 'ended';
    review.updatedAt = nowIso();
    this.emit('ended', { aiSessionId, review });
    return review;
  }

  get(aiSessionId) {
    return this._reviews.get(aiSessionId) || null;
  }
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

function isMarkdownFile(file) {
  const lower = String(file || '').toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

// Build a self-contained HTML shell that renders markdown SOURCE through the
// existing client renderer (window.markdownRender.renderInto). This is the
// fallback path for /view when an artifact is markdown rather than HTML — most
// plans arrive already-HTML, but a markdown plan must NEVER be shown as raw
// bytes. The shell is later passed through injectLavishSdk so the annotation
// SDK loads on top.
//
// Absolute script paths are load-bearing: injectLavishSdk inserts a
// <base href="/api/artifact/:id/asset/..."> and a path-relative
// "markdown-render.js" would resolve against that asset base (404). The renderer
// itself lazy-loads /vendor/marked.min.js + /vendor/purify.min.js with absolute
// paths too, so they survive the base. All three are served by the pre-auth
// express.static mount, so the sandboxed iframe loads them same-origin without a
// token.
function markdownArtifactShell(source, options) {
  options = options || {};
  const title = options.title ? String(options.title) : 'Markdown artifact';
  const src = source == null ? '' : String(source);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + escapeAttr(title) + '</title>',
    '<style>',
    ':root{color-scheme:light}',
    'html,body{margin:0;padding:0;background:#fbfbfa;color:#1f2328}',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Serif",Georgia,serif;',
    'font-size:16px;line-height:1.65;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
    '.md-reading-column{max-width:760px;margin:0 auto;padding:40px 28px 96px;box-sizing:border-box}',
    '.fb-markdown-rendered,.fb-md-fallback{overflow-wrap:break-word;word-break:break-word}',
    '.fb-markdown-rendered h1,.fb-markdown-rendered h2,.fb-markdown-rendered h3{line-height:1.25;font-weight:650;margin:1.6em 0 .6em}',
    '.fb-markdown-rendered h1{font-size:1.9em;border-bottom:1px solid #e2e2df;padding-bottom:.3em}',
    '.fb-markdown-rendered h2{font-size:1.45em;border-bottom:1px solid #e8e8e5;padding-bottom:.25em}',
    '.fb-markdown-rendered h3{font-size:1.2em}',
    '.fb-markdown-rendered p,.fb-markdown-rendered ul,.fb-markdown-rendered ol{margin:.7em 0}',
    '.fb-markdown-rendered code,.fb-markdown-rendered pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}',
    '.fb-markdown-rendered code{background:#f1f1ef;border-radius:4px;padding:.15em .35em;font-size:.88em}',
    '.fb-markdown-rendered pre{background:#f6f6f4;border:1px solid #e6e6e3;border-radius:8px;padding:14px 16px;overflow:auto;line-height:1.5}',
    '.fb-markdown-rendered pre code{background:none;padding:0;font-size:.86em}',
    '.fb-markdown-rendered blockquote{margin:.8em 0;padding:.1em 1em;border-left:3px solid #d7d7d3;color:#56595f}',
    '.fb-markdown-rendered table{border-collapse:collapse;margin:1em 0;display:block;overflow:auto}',
    '.fb-markdown-rendered th,.fb-markdown-rendered td{border:1px solid #e2e2df;padding:6px 12px}',
    '.fb-markdown-rendered img{max-width:100%}',
    '.fb-markdown-rendered a{color:#0b66c3}',
    '.fb-md-loading{color:#8a8d92;font-size:14px}',
    '.fb-md-feature-unavailable{color:#9a6b00;background:#fff7e0;border:1px solid #f0dca0;border-radius:6px;padding:8px 10px;font-size:13px;margin:0 0 10px}',
    '.fb-md-fallback pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#f6f6f4;border:1px solid #e6e6e3;border-radius:8px;padding:14px 16px;margin:0}',
    '</style>',
    '</head>',
    '<body>',
    '<main class="md-reading-column"><div id="md-artifact-root" class="fb-md-loading">Rendering markdown...</div></main>',
    '<script type="application/json" id="md-artifact-source">' + safeJson(src) + '</script>',
    '<script src="/markdown-render.js"></script>',
    '<script>(function(){',
    'function boot(){',
    'var root=document.getElementById("md-artifact-root");',
    'var raw=document.getElementById("md-artifact-source");',
    'var source="";try{source=JSON.parse(raw.textContent||\'""\');}catch(e){source=raw.textContent||"";}',
    'if(!root)return;',
    'if(window.markdownRender&&typeof window.markdownRender.renderInto==="function"){',
    'window.markdownRender.renderInto(root,source,{enableMermaid:true,enableKatex:true}).catch(function(){renderRaw(root,source);});',
    '}else{renderRaw(root,source);}',
    '}',
    'function renderRaw(root,source){',
    'while(root.firstChild)root.removeChild(root.firstChild);',
    'root.className="fb-md-fallback";',
    'var note=document.createElement("div");note.className="fb-md-feature-unavailable";',
    'note.textContent="Markdown renderer unavailable; showing source.";',
    'var pre=document.createElement("pre");pre.textContent=source;',
    'root.appendChild(note);root.appendChild(pre);',
    '}',
    'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",boot,{once:true});}else{boot();}',
    '})();</script>',
    '</body>',
    '</html>',
  ].join('\n');
}

function injectLavishSdk(html, options) {
  options = options || {};
  const sessionId = options.sessionId;
  const key = options.key;
  const assetBase = options.assetBase;
  const sdkSrc = options.sdkSrc;
  const eventsUrl = options.eventsUrl;
  const assetToken = options.assetToken;
  const config = {
    sessionId,
    key,
    assetBase,
    assetToken: assetToken || null,
    eventsUrl,
    promptsMessageType: 'artifact-prompts',
    layoutWarningsMessageType: 'artifact-layout-warnings',
  };
  const tags = [
    '<meta name="ai-or-die-artifact-review" content="' + escapeAttr(sessionId || '') + '">',
    assetBase ? '<base href="' + escapeAttr(assetBase) + '">' : '',
    '<script data-ai-or-die-artifact-config>window.__AI_OR_DIE_ARTIFACT_REVIEW__=' + safeJson(config) + ';</script>',
    sdkSrc ? '<script data-ai-or-die-artifact-sdk src="' + escapeAttr(sdkSrc) + '"></script>' : '',
  ].filter(Boolean).join('\n');

  if (typeof html !== 'string') html = String(html || '');
  if (html.includes('data-ai-or-die-artifact-sdk')) return html;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, '<head$1>\n' + tags + '\n');
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, '<html$1>\n<head>\n' + tags + '\n</head>\n');
  }
  return tags + '\n' + html;
}

function hasTraversalSegment(assetPath) {
  return String(assetPath).split(/[\\/]+/).some((segment) => segment === '..');
}

function isAbsoluteAssetPath(assetPath) {
  return path.isAbsolute(assetPath) ||
    path.posix.isAbsolute(assetPath) ||
    path.win32.isAbsolute(assetPath);
}

function decodeAssetPath(rawAssetPath) {
  let out = String(rawAssetPath || '');
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch (_) {
      break;
    }
  }
  return out;
}

function pathEscapes(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

function resolveArtifactAsset(reviewFile, rawAssetPath, validatePath) {
  const assetPath = decodeAssetPath(rawAssetPath);
  if (!assetPath || assetPath.includes('\0')) {
    return { valid: false, status: 403, error: 'Invalid asset path' };
  }
  if (isAbsoluteAssetPath(assetPath) || hasTraversalSegment(assetPath)) {
    return { valid: false, status: 403, error: 'Asset path escapes artifact directory' };
  }

  const baseDir = path.dirname(reviewFile);
  const resolvedAsset = path.resolve(baseDir, assetPath);
  if (pathEscapes(baseDir, resolvedAsset)) {
    return { valid: false, status: 403, error: 'Asset path escapes artifact directory' };
  }

  const validation = validatePath(resolvedAsset);
  if (!validation || !validation.valid) {
    return {
      valid: false,
      status: 403,
      error: (validation && validation.error) || 'Access denied',
    };
  }

  let realBase = baseDir;
  try {
    realBase = fs.realpathSync(baseDir);
  } catch (_) {
    realBase = path.resolve(baseDir);
  }
  if (pathEscapes(realBase, validation.path)) {
    return { valid: false, status: 403, error: 'Asset path escapes artifact directory' };
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(validation.path);
  } catch (_) {
    realTarget = validation.path;
  }
  if (pathEscapes(realBase, realTarget)) {
    return { valid: false, status: 403, error: 'Asset path escapes artifact directory' };
  }

  return { valid: true, path: realTarget };
}

function publicFeedback(snapshot) {
  const out = {
    prompts: cloneArray(snapshot && snapshot.prompts),
    layout_warnings: cloneArray(snapshot && snapshot.layout_warnings),
  };
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, 'dom_snapshot')) {
    out.dom_snapshot = snapshot.dom_snapshot;
  }
  return out;
}

function tokenQuery(req) {
  const token = req && req.query && req.query.token;
  if (!token || typeof token !== 'string') return '';
  return '?token=' + encodeURIComponent(token);
}

function artifactPath(sessionId, suffix, req) {
  return '/api/artifact/' + encodeURIComponent(sessionId) + suffix + tokenQuery(req);
}

function artifactAssetBase(sessionId, assetToken) {
  const base = '/api/artifact/' + encodeURIComponent(sessionId) + '/asset/';
  if (assetToken && typeof assetToken === 'string') {
    return base + '_auth/' + encodeURIComponent(assetToken) + '/';
  }
  return base;
}

function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  } catch (_) {
    return false;
  }
}

function assetTokenFromRawPath(rawAssetPath) {
  const raw = String(rawAssetPath || '');
  if (!raw.startsWith('_auth/')) return '';
  const rest = raw.slice('_auth/'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return '';
  return rest.slice(0, slash);
}

function stripAssetAuthPrefix(rawAssetPath, req) {
  const raw = String(rawAssetPath || '');
  if (!req || !req.artifactAssetPathToken || !raw.startsWith('_auth/')) return raw;
  const rest = raw.slice('_auth/'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return '';
  return rest.slice(slash + 1);
}

function pollPayload(review, snapshot, nextStep) {
  const feedback = publicFeedback(snapshot || {});
  const payload = {
    status: review ? review.status : 'missing',
    prompts: feedback.prompts,
    next_step: nextStep,
  };
  if (feedback.layout_warnings.length > 0 || nextStep !== 'poll') {
    payload.layout_warnings = feedback.layout_warnings;
  }
  if (Object.prototype.hasOwnProperty.call(feedback, 'dom_snapshot')) {
    payload.dom_snapshot = feedback.dom_snapshot;
  }
  return payload;
}

function sendJsonWithAck(res, store, sessionId, payload, snapshot) {
  if (snapshot && feedbackHasData(snapshot)) {
    res.once('finish', () => {
      store.ackFeedback(sessionId, snapshot);
    });
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.end(JSON.stringify(payload));
}

function createArtifactReviewRouter(options) {
  options = options || {};
  const store = options.store;
  const validatePath = options.validatePath;
  const mintAssetToken = options.mintAssetToken;
  const broadcastToSession = typeof options.broadcastToSession === 'function'
    ? options.broadcastToSession
    : () => {};
  const pollHoldMs = typeof options.pollHoldMs === 'number'
    ? options.pollHoldMs
    : DEFAULT_POLL_HOLD_MS;
  const pollHeartbeatMs = typeof options.pollHeartbeatMs === 'number'
    ? options.pollHeartbeatMs
    : DEFAULT_POLL_HEARTBEAT_MS;
  const sseHeartbeatMs = typeof options.sseHeartbeatMs === 'number'
    ? options.sseHeartbeatMs
    : DEFAULT_SSE_HEARTBEAT_MS;
  // Optional artifact-push hook (default off). When provided, panel feedback that
  // arrives while NO agent poll is in flight is pushed into the CLI as a new turn
  // (so an idle agent reacts without the human switching to the terminal). The
  // server supplies this only when AIORDIE_ARTIFACT_PUSH is enabled; it returns a
  // truthy value when it actually injected, so we can consume the queued prompts.
  const pushToAgent = typeof options.pushToAgent === 'function'
    ? options.pushToAgent
    : null;
  const pushTimeoutMs = typeof options.pushTimeoutMs === 'number' && options.pushTimeoutMs > 0
    ? options.pushTimeoutMs
    : PUSH_TIMEOUT_MS;

  // Count of in-flight long-poll requests per session. Non-zero means the agent
  // is actively waiting on artifact_poll, so a queued prompt is delivered by that
  // poll and must NOT be injected (injecting mid-turn would race the CLI's TUI).
  const activePolls = new Map();
  function pollDelta(sessionId, delta) {
    const next = (activePolls.get(sessionId) || 0) + delta;
    if (next > 0) activePolls.set(sessionId, next);
    else activePolls.delete(sessionId);
  }

  if (!store) throw new TypeError('Artifact review store is required');
  if (typeof validatePath !== 'function') throw new TypeError('validatePath is required');
  if (typeof mintAssetToken !== 'function') throw new TypeError('mintAssetToken is required');

  // Auto live-reload: one chokidar watcher per session, scoped to the canonical
  // artifact file. On a settled write we broadcast a reload SIGNAL (the panel
  // cache-busts the iframe; the feedback box lives outside it and survives).
  // Capped, replaced on re-open, and torn down on /end. Best-effort: chokidar
  // is loaded lazily so tests/headless runs without it degrade to no reload.
  const MAX_WATCHERS = 64;
  const watchers = new Map(); // sessionId -> { watcher, file }
  function stopWatch(sessionId) {
    const w = watchers.get(sessionId);
    if (!w) return;
    watchers.delete(sessionId);
    try { w.watcher.close(); } catch (_) { /* already closed */ }
  }
  function startWatch(sessionId, file) {
    const existing = watchers.get(sessionId);
    if (existing) { if (existing.file === file) return; stopWatch(sessionId); }
    if (watchers.size >= MAX_WATCHERS) { const first = watchers.keys().next().value; if (first) stopWatch(first); }
    let chokidar;
    try { chokidar = require('chokidar'); } catch (_) { return; }
    let watcher;
    try {
      watcher = chokidar.watch(file, {
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 30 },
      });
    } catch (_) { return; }
    const onChange = () => {
      if (!store.get(sessionId)) { stopWatch(sessionId); return; }
      broadcastToSession(sessionId, { type: 'artifact_review_reload', sessionId });
    };
    watcher.on('change', onChange);
    watcher.on('add', onChange);
    watcher.on('error', () => stopWatch(sessionId));
    watchers.set(sessionId, { watcher, file });
  }

  const router = express.Router();


  router.post('/:sessionId/open', (req, res) => {
    const sessionId = req.params.sessionId;
    const file = req.body && req.body.file;
    if (!file || typeof file !== 'string') {
      return res.status(400).json({ error: 'file is required' });
    }

    const validation = validatePath(file);
    if (!validation || !validation.valid) {
      return res.status(403).json({ error: (validation && validation.error) || 'Access denied' });
    }

    try {
      const stat = fs.statSync(validation.path);
      if (!stat.isFile()) return res.status(400).json({ error: 'file must be a regular file' });
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
      return res.status(500).json({ error: 'stat failed', message: err.message });
    }

    const review = store.open(sessionId, validation.path);
    startWatch(sessionId, validation.path);
    const viewUrl = artifactPath(sessionId, '/view', req);
    broadcastToSession(sessionId, {
      type: 'artifact_review_opened',
      sessionId,
      key: review.key,
      file: review.file,
      viewUrl,
    });
    res.json({ sessionId, key: review.key, viewUrl });
  });

  router.get('/:sessionId/view', (req, res) => {
    const sessionId = req.params.sessionId;
    const review = store.get(sessionId);
    if (!review) return res.status(404).json({ error: 'artifact review not found' });

    const validation = validatePath(review.file);
    if (!validation || !validation.valid) {
      return res.status(403).json({ error: (validation && validation.error) || 'Access denied' });
    }

    let html;
    try {
      const stat = fs.statSync(validation.path);
      if (!stat.isFile()) return res.status(400).json({ error: 'file must be a regular file' });
      const raw = fs.readFileSync(validation.path, 'utf8');
      review.file = validation.path;
      // Markdown FALLBACK: a .md/.markdown artifact is wrapped in a self-contained
      // renderer shell (never shown as raw bytes). HTML and everything else keep
      // the raw path. Both then flow through injectLavishSdk so annotation works.
      html = isMarkdownFile(validation.path)
        ? markdownArtifactShell(raw, { title: path.basename(validation.path) })
        : raw;
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
      return res.status(500).json({ error: 'read failed', message: err.message });
    }

    const assetToken = mintAssetToken(sessionId);
    const injected = injectLavishSdk(html, {
      sessionId,
      key: review.key,
      assetBase: artifactAssetBase(sessionId, assetToken),
      assetToken,
      sdkSrc: artifactPath(sessionId, '/sdk.js', req),
      eventsUrl: artifactPath(sessionId, '/events', req),
    });
    store.setPresence(sessionId, { viewedAt: nowIso() });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  });

  router.get('/:sessionId/sdk.js', (req, res) => {
    const review = store.get(req.params.sessionId);
    if (!review) return res.status(404).type('text/plain').send('artifact review not found');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'artifact-sdk-client.js'));
  });

  router.get('/:sessionId/asset/*', (req, res) => {
    const sessionId = req.params.sessionId;
    const review = store.get(sessionId);
    if (!review) return res.status(404).json({ error: 'artifact review not found' });

    const fileValidation = validatePath(review.file);
    if (!fileValidation || !fileValidation.valid) {
      return res.status(403).json({ error: (fileValidation && fileValidation.error) || 'Access denied' });
    }

    const rawAssetPath = String(req.params[0] || '');
    if (rawAssetPath.startsWith('_auth/')) {
      const assetToken = assetTokenFromRawPath(rawAssetPath);
      if (!assetToken ||
          !req.artifactAssetPathToken ||
          !safeEqualString(assetToken, req.artifactAssetPathToken) ||
          !safeEqualString(assetToken, mintAssetToken(sessionId))) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const assetPath = stripAssetAuthPrefix(rawAssetPath, req);
    const resolved = resolveArtifactAsset(fileValidation.path, assetPath, validatePath);
    if (!resolved.valid) {
      return res.status(resolved.status || 403).json({ error: resolved.error || 'Access denied' });
    }

    try {
      const stat = fs.statSync(resolved.path);
      if (!stat.isFile()) return res.status(404).json({ error: 'asset not found' });
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'asset not found' });
      return res.status(500).json({ error: 'stat failed', message: err.message });
    }
    res.sendFile(resolved.path);
  });

  router.post('/:sessionId/prompts', async (req, res) => {
    const sessionId = req.params.sessionId;
    if (!store.get(sessionId)) return res.status(404).json({ error: 'artifact review not found' });

    const prompts = req.body && req.body.prompts;
    if (!Array.isArray(prompts)) return res.status(400).json({ error: 'prompts must be an array' });

    // Snapshot whether a poll is in flight BEFORE queuing: queuePrompts emits
    // 'feedback' synchronously, which makes an in-flight poll deliver + tear down
    // (decrementing the count to 0) before we could observe it. Reading the count
    // first is the correct "was the agent waiting when this arrived?" signal.
    const hadActivePoll = (activePolls.get(sessionId) || 0) > 0;

    const review = store.queuePrompts(sessionId, prompts, req.body ? req.body.domSnapshot : undefined);

    // Artifact push (default off; pushToAgent is null unless enabled). If the
    // agent was NOT waiting on a poll, the queued feedback would otherwise sit
    // until the agent next polls. Push it into the CLI as a new turn so an idle
    // agent reacts. When a poll WAS in flight the queue path already delivers it,
    // so we never inject then (injecting mid-turn would race the TUI).
    //
    // We CLAIM the feedback (ackFeedback) synchronously BEFORE the await, so a
    // poll that arrives during the push window sees an empty queue and cannot
    // also deliver the same feedback (no double-delivery). If the push then fails
    // or times out we re-queue exactly what we claimed, so feedback is never lost
    // and the poll path still works. The server hook applies its own PTY-quiet
    // idle check and may decline.
    let pushed = false;
    if (pushToAgent && !hadActivePoll) {
      const snapshot = store.peekFeedback(sessionId);
      const text = feedbackHasData(snapshot) ? formatFeedbackForAgent(snapshot.prompts) : '';
      if (text) {
        store.ackFeedback(sessionId, snapshot); // claim before await
        try {
          pushed = !!(await Promise.race([
            Promise.resolve(pushToAgent(sessionId, text)),
            new Promise((resolve) => setTimeout(() => resolve(false), pushTimeoutMs)),
          ]));
        } catch (_) {
          pushed = false;
        }
        if (!pushed) {
          // Re-queue what we claimed (to the FRONT, preserving order) so the poll
          // path still delivers it.
          store.restoreClaimedFeedback(sessionId, snapshot);
        }
      }
    }

    res.json({
      ok: true,
      pushed,
      queued: pushed ? 0 : (review ? review.queuedPrompts.length : 0),
    });
  });

  router.post('/:sessionId/layout-warnings', (req, res) => {
    const sessionId = req.params.sessionId;
    if (!store.get(sessionId)) return res.status(404).json({ error: 'artifact review not found' });

    const warnings = req.body && req.body.layout_warnings;
    if (!Array.isArray(warnings)) return res.status(400).json({ error: 'layout_warnings must be an array' });

    const result = store.recordLayoutWarnings(sessionId, warnings);
    res.json({ ok: true, changed: !!(result && result.changed) });
  });

  router.get('/:sessionId/events', (req, res) => {
    const sessionId = req.params.sessionId;
    if (!store.get(sessionId)) return res.status(404).json({ error: 'artifact review not found' });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    function send(event, obj) {
      if (closed) return;
      try {
        res.write('event: ' + event + '\n');
        res.write('data: ' + JSON.stringify(obj) + '\n\n');
      } catch (_) {
        cleanup();
      }
    }
    function onAgentReply(evt) {
      if (!evt || evt.aiSessionId !== sessionId) return;
      send('agent-reply', { type: 'agent-reply', text: evt.text, reply: evt.reply });
    }
    function onPresence(evt) {
      if (!evt || evt.aiSessionId !== sessionId) return;
      send('presence', { type: 'presence', presence: evt.presence });
    }
    function onEnded(evt) {
      if (!evt || evt.aiSessionId !== sessionId) return;
      send('ended', { type: 'ended', status: 'ended' });
      cleanup();
      try { res.end(); } catch (_) { /* ignore */ }
    }
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      store.removeListener('agent-reply', onAgentReply);
      store.removeListener('presence', onPresence);
      store.removeListener('ended', onEnded);
    }

    store.on('agent-reply', onAgentReply);
    store.on('presence', onPresence);
    store.on('ended', onEnded);
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (_) { cleanup(); }
    }, sseHeartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const presence = store.setPresence(sessionId, { connected: true, lastSeen: nowIso() });
    send('presence', { type: 'presence', presence });

    req.on('close', () => {
      cleanup();
      store.setPresence(sessionId, { connected: false, lastSeen: nowIso() });
    });
  });

  router.post('/:sessionId/end', (req, res) => {
    const sessionId = req.params.sessionId;
    const review = store.end(sessionId);
    stopWatch(sessionId);
    if (!review) return res.status(404).json({ error: 'artifact review not found' });
    broadcastToSession(sessionId, { type: 'artifact_review_ended', sessionId });
    res.json({ ok: true, status: review.status });
  });

  router.get('/:sessionId/poll', (req, res) => {
    const sessionId = req.params.sessionId;
    const review = store.get(sessionId);
    if (!review) return res.status(404).json({ error: 'artifact review not found' });

    const immediate = store.peekFeedback(sessionId);
    if (feedbackHasData(immediate)) {
      return sendJsonWithAck(
        res,
        store,
        sessionId,
        pollPayload(review, immediate, 'review_feedback'),
        immediate
      );
    }
    if (review.status === 'ended') {
      return sendJsonWithAck(res, store, sessionId, pollPayload(review, null, 'ended'), null);
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // This request is now an in-flight poll; mark the agent as actively waiting
    // so concurrent /prompts feedback is delivered HERE (not injected into the
    // PTY). Decremented exactly once on teardown.
    let pollCounted = true;
    pollDelta(sessionId, 1);

    let done = false;
    let snapshotToAck = null;
    let timeout = null;
    let heartbeat = null;
    function cleanup() {
      if (pollCounted) { pollCounted = false; pollDelta(sessionId, -1); }
      if (timeout) clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      store.removeListener('feedback', onFeedback);
      store.removeListener('ended', onEnded);
    }
    function finish(payload, snapshot) {
      if (done) return;
      done = true;
      snapshotToAck = snapshot || null;
      cleanup();
      try { res.end(JSON.stringify(payload)); } catch (_) { /* client already gone */ }
    }
    function onFeedback(evt) {
      if (!evt || evt.aiSessionId !== sessionId) return;
      const snapshot = store.peekFeedback(sessionId);
      if (!feedbackHasData(snapshot)) return;
      const current = store.get(sessionId) || review;
      finish(pollPayload(current, snapshot, 'review_feedback'), snapshot);
    }
    function onEnded(evt) {
      if (!evt || evt.aiSessionId !== sessionId) return;
      const current = store.get(sessionId) || review;
      finish(pollPayload(current, null, 'ended'), null);
    }

    res.once('finish', () => {
      if (snapshotToAck && feedbackHasData(snapshotToAck)) {
        store.ackFeedback(sessionId, snapshotToAck);
      }
      cleanup();
    });
    req.once('close', () => {
      if (!done) cleanup();
    });

    timeout = setTimeout(() => {
      const current = store.get(sessionId) || review;
      finish(pollPayload(current, null, 'poll'), null);
    }, pollHoldMs);
    heartbeat = setInterval(() => {
      try { res.write(' '); } catch (_) { cleanup(); }
    }, pollHeartbeatMs);
    if (typeof timeout.unref === 'function') timeout.unref();
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    store.on('feedback', onFeedback);
    store.on('ended', onEnded);
  });

  router.post('/:sessionId/agent-reply', (req, res) => {
    const sessionId = req.params.sessionId;
    if (!store.get(sessionId)) return res.status(404).json({ error: 'artifact review not found' });

    const text = req.body && req.body.text;
    if (typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

    const reply = store.addAgentReply(sessionId, text);
    broadcastToSession(sessionId, { type: 'artifact_agent_reply', sessionId, text });
    res.json({ ok: true, reply });
  });

  return router;
}

module.exports = {
  ArtifactReviewStore,
  artifactKeyForFile,
  createAssetTokenSigner,
  createArtifactReviewRouter,
  feedbackHasData,
  formatFeedbackForAgent,
  buildArtifactPushPayload,
  injectLavishSdk,
  isMarkdownFile,
  markdownArtifactShell,
  resolveArtifactAsset,
};
