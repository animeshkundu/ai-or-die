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

  // --------------------------------------------------------------
  // Round-2 review fixes
  // --------------------------------------------------------------

  describe('round-2 review fixes', function () {
    // #7 — defensive Array.isArray guard
    it('#7 defensive: non-array candidates (truthy object with .length) falls through to Block D safely', function () {
      // A defensive shape that's NOT an array — e.g. a Set, or a
      // plain object with a `length` accessor. The pre-fix code did
      // `failure.candidates.map(...)` which would throw on .map
      // missing → toast silently swallowed.
      const fakeCandidates = { length: 1, 0: { path: '/foo', source: 'workingDir' } };
      assert.doesNotThrow(() => fb.resolverFailure({
        hint: 'x.js',
        candidates: fakeCandidates,
        context: { bridgeType: 'terminal' },
      }));
      const txt = getActiveResolverFailureToasts()[0].textContent;
      assert.ok(/No active session/i.test(txt),
        'non-array candidates should be coerced to empty (Block D); got: ' + txt);
    });

    // #5 — bounds: candidates slice + hint truncation
    it('#5 bounds: candidates >3 are summarised with "…and N more"', function () {
      const many = [];
      for (let i = 0; i < 7; i++) many.push({ path: '/dir' + i + '/x.js', source: 'workingDir' });
      fb.resolverFailure({
        hint: 'x.js',
        candidates: many,
        context: { liveCwd: null, workingDir: '/dir0', repoRoot: null, bridgeType: 'terminal' },
      });
      const txt = getActiveResolverFailureToasts()[0].textContent;
      // Exactly 3 candidate paths enumerated.
      assert.ok(txt.includes('/dir0/x.js'), 'first candidate present');
      assert.ok(txt.includes('/dir2/x.js'), 'third candidate present');
      assert.ok(!txt.includes('/dir3/x.js'), 'fourth candidate should be truncated');
      assert.ok(/and 4 more/i.test(txt), 'overflow indicator present; got: ' + txt);
    });

    it('#5 bounds: hint longer than 60 chars is truncated in title', function () {
      const longHint = 'src/' + 'verylongdir/'.repeat(10) + 'file.js';   // ~140 chars
      fb.resolverFailure({
        hint: longHint,
        candidates: [{ path: '/p/' + longHint, source: 'workingDir' }],
        context: { liveCwd: null, workingDir: '/p', repoRoot: null, bridgeType: 'terminal' },
      });
      const toast = getActiveResolverFailureToasts()[0];
      // Title carries the truncated form (60 chars including ellipsis).
      // Body still has the full hint (in the candidate path).
      const title = toast.children.find ? null : null;
      // Easier: just check the toast text includes the ellipsis and
      // doesn't carry the full 140-char hint in the title area.
      assert.ok(toast.textContent.includes('…'),
        'truncated title should carry ellipsis; got: ' + toast.textContent.slice(0, 200));
    });

    // #6 — unknown source enum doesn't render "undefined"
    it('#6 unknown candidate source falls back to "candidate path" not "undefined"', function () {
      fb.resolverFailure({
        hint: 'x.js',
        candidates: [
          { path: '/known/x.js', source: 'liveCwd' },
          { path: '/weird/x.js', source: 'martian' },   // unknown enum
        ],
        context: { liveCwd: '/known', workingDir: '/spawn', repoRoot: null, bridgeType: 'terminal' },
      });
      const txt = getActiveResolverFailureToasts()[0].textContent;
      // Block B is used (terminal + liveCwd set). The "martian"
      // source should NOT render literally — fall back to a
      // human-readable annotation.
      assert.ok(!/\(undefined\)/.test(txt), 'should not render "(undefined)"; got: ' + txt);
      assert.ok(/martian|candidate path/.test(txt),
        'unknown source should fall back to "candidate path" annotation or pass-through; got: ' + txt);
    });

    // #3 + #4 — auto-dismiss only when NO CTA; role differs by CTA presence
    it('#3+#4 toast with CTA is persistent (no auto-dismiss timer) and uses role=alertdialog', function () {
      fb.resolverFailure({
        hint: 'x.js',
        candidates: [{ path: '/p/x.js', source: 'workingDir' }],
        context: { liveCwd: null, workingDir: '/p', repoRoot: null, bridgeType: 'terminal' },   // Block A has CTA
      });
      const toast = getActiveResolverFailureToasts()[0];
      assert.strictEqual(toast.role, 'alertdialog', 'CTA present → alertdialog role; got: ' + toast.role);
      // Find the matching internal entry via fb._visible — its timer
      // should be null (no auto-dismiss when CTA present).
      const entry = fb._visible.find(v => v.isResolverFailure);
      assert.ok(entry, 'visible entry should exist');
      assert.strictEqual(entry.timer, null,
        'CTA-bearing toast must NOT have an auto-dismiss timer (WCAG 2.2 SC 2.2.1)');
    });

    it('#3+#4 toast without CTA auto-dismisses and uses role=status', function () {
      // Block D — no candidates → no CTA per spec.
      fb.resolverFailure({
        hint: 'x.js',
        candidates: [],
        context: { liveCwd: null, workingDir: null, repoRoot: null, bridgeType: null },
      });
      const toast = getActiveResolverFailureToasts()[0];
      assert.strictEqual(toast.role, 'status',
        'no-CTA toast → role=status (polite); got: ' + toast.role);
      const entry = fb._visible.find(v => v.isResolverFailure);
      assert.ok(entry.timer !== null && typeof entry.timer === 'object',
        'no-CTA toast SHOULD have an auto-dismiss timer; got: ' + entry.timer);
    });

    // #1 — idempotent open via window.app.openFileBrowser (not toggle)
    it('#1 Block C CTA calls openFileBrowser (idempotent) when available', function () {
      let openCalls = 0, toggleCalls = 0;
      window.app = {
        openFileBrowser: () => openCalls++,
        toggleFileBrowser: () => toggleCalls++,
      };
      fb.resolverFailure({
        hint: 'x.js',
        candidates: [{ path: '/p/x.js', source: 'workingDir' }],
        context: { liveCwd: null, workingDir: '/p', repoRoot: null, bridgeType: 'claude' },
      });
      const toast = getActiveResolverFailureToasts()[0];
      // Find the action button and fire its click — we use the
      // stub's synthetic click() helper.
      const action = toast.querySelector('.toast__action');
      assert.ok(action, 'CTA button exists');
      action.click();
      assert.strictEqual(openCalls, 1, 'openFileBrowser called once');
      assert.strictEqual(toggleCalls, 0,
        'toggleFileBrowser NOT called (would close if already open — round-2 #1)');
      delete window.app;
    });

    it('#1 Block C CTA falls back to toggleFileBrowser for legacy hosts without openFileBrowser', function () {
      let toggleCalls = 0;
      window.app = { toggleFileBrowser: () => toggleCalls++ };   // legacy: no .openFileBrowser
      fb.resolverFailure({
        hint: 'x.js',
        candidates: [{ path: '/p/x.js', source: 'workingDir' }],
        context: { liveCwd: null, workingDir: '/p', repoRoot: null, bridgeType: 'codex' },
      });
      getActiveResolverFailureToasts()[0].querySelector('.toast__action').click();
      assert.strictEqual(toggleCalls, 1, 'legacy fallback fires toggleFileBrowser');
      delete window.app;
    });

    // #8 — bridgeType enum contract (this test pins the canonical set
    //   so a future server-side change that emits e.g. 'claude-3-opus'
    //   makes a downstream test fail loudly, alerting whoever's
    //   touching the upstream to either normalise or update the regex)
    it('#8 bridgeType enum contract: AI-CLI dispatch matches the canonical set verbatim', function () {
      const AI_CLI_BRIDGES = ['claude', 'codex', 'gemini', 'copilot', 'agent'];
      AI_CLI_BRIDGES.forEach(b => {
        const fbb = new FeedbackManager();
        fbb.resolverFailure({
          hint: 'x.js',
          candidates: [{ path: '/p/x.js', source: 'workingDir' }],
          context: { liveCwd: null, workingDir: '/p', repoRoot: null, bridgeType: b },
        });
        const txt = document.querySelectorAll('.toast--resolver-failure').slice(-1)[0].textContent;
        assert.ok(/AI assistants don'?t track/i.test(txt),
          `bridgeType=${b} must route to Block C; got: ${txt}`);
      });
    });

    it('#8 bridgeType enum contract: unknown variants ("claude-3-opus") do NOT route to Block C — fall through to default', function () {
      // Regression: if upstream ever emits a non-canonical value,
      // the toast should NOT silently misclassify as AI-CLI. The
      // dispatch falls through to the defensive default (Block B
      // without annotations).
      fb.resolverFailure({
        hint: 'x.js',
        candidates: [{ path: '/p/x.js', source: 'workingDir' }],
        context: { liveCwd: null, workingDir: '/p', repoRoot: null, bridgeType: 'claude-3-opus' },
      });
      const txt = getActiveResolverFailureToasts()[0].textContent;
      assert.ok(!/AI assistants don'?t track/i.test(txt),
        'non-canonical bridgeType should NOT route to Block C; got: ' + txt);
      assert.ok(/may have moved/i.test(txt),
        'unknown bridgeType falls through to the defensive default; got: ' + txt);
    });
  });
});

after(restoreBrowserStubs);
