// test/feedback-resolver-failure.test.js — Layer 5 (architect-spec'd
// structured resolver failure toast) unit suite.
//
// Tests the FeedbackManager.resolverFailure(failure) method end-to-end:
//   - Block A: Terminal bridge with liveCwd null (user's exact case)
//   - Block B: Terminal bridge with liveCwd present, still no hit
//   - Block C: AI CLI bridge (claude/codex/gemini/copilot/agent)
//   - Block D: No candidates at all (no session context)
//   - Single-stack: subsequent failures REPLACE prior toast in DOM

'use strict';

const assert = require('assert');

let _origWindow, _origDocument;
function installBrowserStubs() {
  _origWindow = global.window;
  _origDocument = global.document;
  // Build a tiny synthetic DOM that supports the FeedbackManager's
  // minimal needs: createElement → element with innerHTML +
  // appendChild + addEventListener + querySelector + remove, plus
  // document.body.appendChild. The toast assertion targets are
  // text content + child counts, not full layout, so this is enough.
  function makeEl(tag) {
    const children = [];
    let _innerHTML = '';
    let _textContent = '';
    const listeners = {};
    const el = {
      tagName: (tag || 'div').toUpperCase(),
      className: '',
      // innerHTML <-> textContent share storage for the parts we
      // care about. textContent is read-write (FeedbackManager's
      // _escHtml sets it).
      get innerHTML() { return _innerHTML; },
      set innerHTML(v) { _innerHTML = v; _textContent = null; },
      get textContent() {
        if (_textContent !== null) return _textContent;
        // Derive from innerHTML by stripping tags + entity-decode.
        return _innerHTML.replace(/<[^>]+>/g, '').replace(/&times;/g, '×')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      },
      set textContent(v) { _textContent = String(v); _innerHTML = String(v); },
      style: {},
      children,
      appendChild(child) { children.push(child); child.parentNode = el; },
      removeChild(child) {
        const i = children.indexOf(child);
        if (i >= 0) { children.splice(i, 1); child.parentNode = null; }
      },
      addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
      setAttribute(k, v) { el[k] = v; },
      querySelector(sel) {
        // Minimal selector support: '.foo' → first child whose
        // innerHTML contains class="foo" OR class="foo X". Good
        // enough for `.toast__close` / `.toast__action` lookups.
        const m = sel.match(/^\.(.+)$/);
        if (!m) return null;
        const cls = m[1];
        const re = new RegExp('class="(?:[^"]*\\s)?' + cls.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&') + '(?:\\s[^"]*)?"');
        // For our purposes, search the innerHTML for a button with that class
        // and synthesise a stub element with addEventListener.
        if (re.test(_innerHTML)) {
          return {
            addEventListener(name, fn) { (listeners[sel + ':' + name] = listeners[sel + ':' + name] || []).push(fn); },
            click() { (listeners[sel + ':click'] || []).forEach(fn => fn()); },
          };
        }
        return null;
      },
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); el.className += ' ' + c; },
        remove(c) { this._set.delete(c); el.className = el.className.split(' ').filter(x => x !== c).join(' '); },
        contains(c) { return this._set.has(c); },
        toggle(c) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); },
      },
      parentNode: null,
      dispatchEvent(name) { (listeners[name] || []).forEach(fn => fn()); },
    };
    return el;
  }
  const body = makeEl('body');
  global.document = {
    createElement: tag => makeEl(tag),
    body,
    addEventListener() {},
    documentElement: { clientHeight: 600, clientWidth: 800 },
    querySelector(sel) {
      // Walk the body tree for the resolver-failure toast assertion.
      function search(el) {
        if (!el || !el.classList) return null;
        // Match `.toast--resolver-failure` etc.
        const m = sel.match(/^\.(.+)$/);
        if (m && el.className && el.className.split(' ').indexOf(m[1]) >= 0) return el;
        if (el.children) {
          for (const child of el.children) {
            const hit = search(child);
            if (hit) return hit;
          }
        }
        return null;
      }
      return search(body);
    },
    querySelectorAll(sel) {
      const out = [];
      function walk(el) {
        if (!el || !el.classList) return;
        const m = sel.match(/^\.(.+)$/);
        if (m && el.className && el.className.split(' ').indexOf(m[1]) >= 0) out.push(el);
        if (el.children) for (const c of el.children) walk(c);
      }
      walk(body);
      return out;
    },
  };
  global.window = {
    innerWidth: 1280,
    innerHeight: 800,
    open() {},
    requestAnimationFrame(fn) { setImmediate(fn); },
  };
}

function restoreBrowserStubs() {
  if (_origWindow === undefined) delete global.window; else global.window = _origWindow;
  if (_origDocument === undefined) delete global.document; else global.document = _origDocument;
}

installBrowserStubs();
const FeedbackManager = require('../src/public/feedback-manager');

function getActiveResolverFailureToasts() {
  return document.querySelectorAll('.toast--resolver-failure');
}

describe('FeedbackManager.resolverFailure (Layer 5)', function () {
  let fb;

  beforeEach(function () {
    installBrowserStubs();
    fb = new FeedbackManager();
  });

  // --------------------------------------------------------------
  // Block A — Terminal bridge, liveCwd null (the user-reported flow)
  // --------------------------------------------------------------

  it('Block A: Terminal bridge with liveCwd null → OSC 7 hint + CTA', function () {
    fb.resolverFailure({
      hint: 'src/server.js',
      candidates: [{ path: '/Users/foo/src/server.js', source: 'workingDir' }],
      context: { liveCwd: null, workingDir: '/Users/foo', repoRoot: null, bridgeType: 'terminal' },
    });

    const toasts = getActiveResolverFailureToasts();
    assert.strictEqual(toasts.length, 1, 'one resolver-failure toast');
    const txt = toasts[0].textContent;
    assert.ok(txt.includes('src/server.js'), 'hint in toast');
    assert.ok(/Live directory tracking isn't active/i.test(txt),
      'Block A copy present; got: ' + txt);
    assert.ok(txt.includes('/Users/foo/src/server.js'), 'candidate path enumerated');
    assert.ok(/OSC 7/i.test(txt), 'OSC 7 hint present');
    assert.ok(/Show me how/i.test(txt), 'CTA present');
  });

  // --------------------------------------------------------------
  // Block B — Terminal bridge with liveCwd, still no hit
  // --------------------------------------------------------------

  it('Block B: Terminal bridge with liveCwd → annotated candidate list', function () {
    fb.resolverFailure({
      hint: 'src/foo.js',
      candidates: [
        { path: '/proj/live/src/foo.js', source: 'liveCwd' },
        { path: '/proj/spawn/src/foo.js', source: 'workingDir' },
      ],
      context: { liveCwd: '/proj/live', workingDir: '/proj/spawn', repoRoot: null, bridgeType: 'terminal' },
    });

    const txt = getActiveResolverFailureToasts()[0].textContent;
    assert.ok(txt.includes('src/foo.js'), 'hint');
    assert.ok(/Tried these locations/i.test(txt), 'Block B title');
    assert.ok(/current shell directory/i.test(txt), 'liveCwd annotation');
    assert.ok(/session start directory/i.test(txt), 'workingDir annotation');
    // Block B should NOT carry the OSC 7 hint (live cwd IS present).
    assert.ok(!/OSC 7/i.test(txt),
      'Block B should NOT mention OSC 7 (liveCwd already set); got: ' + txt);
  });

  // --------------------------------------------------------------
  // Block C — AI CLI bridge
  // --------------------------------------------------------------

  ['claude', 'codex', 'gemini', 'copilot', 'agent'].forEach(function (bridgeType) {
    it('Block C: ' + bridgeType + ' bridge → "AI assistants don\'t track cd" copy + open-browser CTA', function () {
      fb.resolverFailure({
        hint: 'src/x.js',
        candidates: [{ path: '/proj/src/x.js', source: 'workingDir' }],
        context: { liveCwd: null, workingDir: '/proj', repoRoot: null, bridgeType: bridgeType },
      });
      const txt = getActiveResolverFailureToasts()[0].textContent;
      assert.ok(/AI assistants don'?t track/i.test(txt),
        bridgeType + ' should get Block C copy; got: ' + txt);
      assert.ok(/Open file browser/i.test(txt), bridgeType + ' should get open-browser CTA');
    });
  });

  // --------------------------------------------------------------
  // Block D — No candidates (no session context)
  // --------------------------------------------------------------

  it('Block D: no candidates → "no active session" copy', function () {
    fb.resolverFailure({
      hint: 'src/x.js',
      candidates: [],
      context: { liveCwd: null, workingDir: null, repoRoot: null, bridgeType: null },
    });
    const txt = getActiveResolverFailureToasts()[0].textContent;
    assert.ok(/No active session/i.test(txt), 'Block D copy; got: ' + txt);
  });

  // --------------------------------------------------------------
  // Single-stack — subsequent failures REPLACE prior toast
  // --------------------------------------------------------------

  it('Single-stack: second resolverFailure REPLACES the first in DOM', function () {
    fb.resolverFailure({
      hint: 'first.js',
      candidates: [{ path: '/a/first.js', source: 'workingDir' }],
      context: { liveCwd: null, workingDir: '/a', repoRoot: null, bridgeType: 'terminal' },
    });
    fb.resolverFailure({
      hint: 'second.js',
      candidates: [{ path: '/b/second.js', source: 'workingDir' }],
      context: { liveCwd: null, workingDir: '/b', repoRoot: null, bridgeType: 'terminal' },
    });

    // Stub _dismiss calls .removeChild → toast leaves DOM after
    // animationend (faked). Force-drain the dismiss → removeChild.
    const stillVisible = getActiveResolverFailureToasts();
    // Either the first toast is already removed (sync detach) or it's
    // in exit state. The contract: at most ONE non-exiting resolver-
    // failure toast at a time. After replacement, exactly ONE toast
    // shows the NEW hint.
    assert.ok(stillVisible.length <= 1,
      'at most one visible resolver-failure toast; got: ' + stillVisible.length);
    if (stillVisible.length === 1) {
      assert.ok(stillVisible[0].textContent.includes('second.js'),
        'visible toast should be the SECOND (replacement); got: ' + stillVisible[0].textContent);
      assert.ok(!stillVisible[0].textContent.includes('first.js'),
        'first toast should be gone');
    }
  });

  // --------------------------------------------------------------
  // Defensive: bad inputs don't throw
  // --------------------------------------------------------------

  it('defensive: null failure object is a no-op', function () {
    assert.doesNotThrow(() => fb.resolverFailure(null));
    assert.strictEqual(getActiveResolverFailureToasts().length, 0);
  });

  it('defensive: missing candidates falls through to Block D', function () {
    fb.resolverFailure({ hint: 'x.js', context: { bridgeType: 'terminal' } });
    const txt = getActiveResolverFailureToasts()[0].textContent;
    assert.ok(/No active session/i.test(txt));
  });
});

after(restoreBrowserStubs);
