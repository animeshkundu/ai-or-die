// test/follow-toggle.test.js — FileBrowserPanel `_followsTerminal` toggle
// state machine, per ADR-0019 + the spec's "Live CWD follow-toggle" section.
//
// Pure-state tests (browser-stubbed, navigateTo mocked) for:
//   - default following=true on first lookup
//   - notifyCwdChanged re-roots when (following && open && active session)
//   - notifyCwdChanged stashes liveCwd silently when not following / not active
//   - manual breadcrumb / back / home navigation flips following=false
//   - setFollowsTerminal(true) re-roots immediately to last stashed liveCwd
//   - per-session boolean isolation (sessionA can be off, sessionB on)
//
// DOM-heavy paths (toggle button rendering, hover tooltip) covered by the
// e2e suite (#cwd-osc7 in test/e2e/). Same testing posture as
// test/file-browser-getcwd.test.js — minimal browser globals + stubbed
// DOM-touching prototype methods so the IIFE loads cleanly under Node.

'use strict';

const assert = require('assert');

// ---------------------------------------------------------------------------
// Browser stubs (mirrors test/file-browser-getcwd.test.js so the two suites
// can co-exist without trampling each other's globals).
// ---------------------------------------------------------------------------

let _origWindow, _origDocument;

function installBrowserStubs() {
  _origWindow = global.window;
  _origDocument = global.document;
  global.window = { innerWidth: 1280 };
  global.document = {
    createElement: () => ({
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      addEventListener() {},
      appendChild() {},
      setAttribute() {},
      style: {},
      dataset: {},
    }),
    body: { appendChild() {} },
    addEventListener() {},
  };
}

function restoreBrowserStubs() {
  if (_origWindow === undefined) delete global.window; else global.window = _origWindow;
  if (_origDocument === undefined) delete global.document; else global.document = _origDocument;
}

installBrowserStubs();
// Drop the require cache so the file-browser IIFE re-runs under our stubs.
delete require.cache[require.resolve('../src/public/file-browser')];
const { FileBrowserPanel } = require('../src/public/file-browser');

// ---------------------------------------------------------------------------
// Panel factory: stubs DOM-touching surface so we can drive the state
// machine without instantiating jsdom.
// ---------------------------------------------------------------------------

function makePanel(opts) {
  opts = opts || {};
  const calls = { navigateTo: [], refreshFollowToggleUI: 0 };

  function FakePanel(o) { FileBrowserPanel.call(this, o); }
  FakePanel.prototype = Object.create(FileBrowserPanel.prototype);
  FakePanel.prototype._buildDOM = function () {
    const el = {
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {},
      appendChild() {},
      setAttribute() {},
      style: {},
      dataset: {},
    };
    this._panelEl = el;
    this._backdropEl = el;
    this._followToggleBtn = el;
  };
  FakePanel.prototype._updateOverlayMode = function () {};
  FakePanel.prototype.navigateTo = function (p) { calls.navigateTo.push(p); };
  FakePanel.prototype._announceToScreenReader = function () {};
  FakePanel.prototype._adjustTerminal = function () {};
  // Spy on the UI-refresh hook so we can assert it's called when state flips.
  FakePanel.prototype._refreshFollowToggleUI = function () { calls.refreshFollowToggleUI++; };

  const panel = new FakePanel(opts);
  return { panel, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileBrowserPanel — _followsTerminal toggle', function () {

  before(installBrowserStubs);
  after(restoreBrowserStubs);

  describe('default state', function () {
    it('followsTerminal(sessionId) defaults to true on first lookup', function () {
      const { panel } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      assert.strictEqual(panel.followsTerminal('sess-a'), true);
      // Lookup of an unknown session also defaults true (panel hasn't seen
      // any cwd_changed for it yet — initial UX is "follow by default").
      assert.strictEqual(panel.followsTerminal('sess-other'), true);
    });

    it('followsTerminal returns true for null/empty sessionId (defensive)', function () {
      const { panel } = makePanel({ app: {} });
      assert.strictEqual(panel.followsTerminal(null), true);
      assert.strictEqual(panel.followsTerminal(''), true);
      assert.strictEqual(panel.followsTerminal(undefined), true);
    });
  });

  describe('setFollowsTerminal', function () {
    it('flips the per-session boolean independently', function () {
      const { panel } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      panel.setFollowsTerminal('sess-a', false);
      assert.strictEqual(panel.followsTerminal('sess-a'), false);
      // sess-b untouched — per-session isolation.
      assert.strictEqual(panel.followsTerminal('sess-b'), true);
    });

    it('refreshes the follow-toggle UI on flip', function () {
      const { panel, calls } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      const before = calls.refreshFollowToggleUI;
      panel.setFollowsTerminal('sess-a', false);
      assert.ok(calls.refreshFollowToggleUI > before, 'UI refresh hook should fire');
    });

    it('flipping back to true re-roots immediately to the last stashed liveCwd', function () {
      const { panel, calls } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      panel._open = true;
      // First, stash a liveCwd via notifyCwdChanged.
      panel.notifyCwdChanged('sess-a', '/Users/foo/code');
      // navigateTo fired once for the active+following+open scenario.
      const navCountAfterCwd = calls.navigateTo.length;
      // User manually navigates → flips following=false, future cwd_changed
      // updates stash silently.
      panel.setFollowsTerminal('sess-a', false);
      panel.notifyCwdChanged('sess-a', '/Users/foo/other-repo');
      // No new navigateTo while not following.
      assert.strictEqual(calls.navigateTo.length, navCountAfterCwd,
        'navigateTo must not fire while not following');
      // Re-engage → re-root to the last stashed liveCwd.
      panel.setFollowsTerminal('sess-a', true);
      assert.strictEqual(calls.navigateTo[calls.navigateTo.length - 1], '/Users/foo/other-repo');
    });

    it('flipping back to true is a no-op when no liveCwd has been stashed', function () {
      const { panel, calls } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      panel._open = true;
      panel.setFollowsTerminal('sess-a', false);
      panel.setFollowsTerminal('sess-a', true);
      assert.strictEqual(calls.navigateTo.length, 0, 'no nav without a stashed cwd');
    });
  });

  describe('notifyCwdChanged', function () {
    it('re-roots when following=true AND active session AND panel open', function () {
      const { panel, calls } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      panel._open = true;
      panel.notifyCwdChanged('sess-a', '/Users/foo/code');
      assert.strictEqual(calls.navigateTo.length, 1);
      assert.strictEqual(calls.navigateTo[0], '/Users/foo/code');
    });

    it('does NOT re-root when following=false (silent stash)', function () {
      const { panel, calls } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      panel._open = true;
      panel.setFollowsTerminal('sess-a', false);
      panel.notifyCwdChanged('sess-a', '/Users/foo/code');
      assert.strictEqual(calls.navigateTo.length, 0);
      // But the live-cwd stash must still update so re-engaging the toggle
      // can read it back.
      assert.strictEqual(panel.getLastLiveCwd('sess-a'), '/Users/foo/code');
    });

    it('does NOT re-root when sessionId is not the active session', function () {
      const { panel, calls } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      panel._open = true;
      panel.notifyCwdChanged('sess-other', '/Users/foo/elsewhere');
      assert.strictEqual(calls.navigateTo.length, 0);
      // Stash STILL updates — when the user switches to sess-other, the
      // panel should know its current liveCwd.
      assert.strictEqual(panel.getLastLiveCwd('sess-other'), '/Users/foo/elsewhere');
    });

    it('does NOT re-root when panel is closed', function () {
      const { panel, calls } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      panel._open = false;
      panel.notifyCwdChanged('sess-a', '/Users/foo/code');
      assert.strictEqual(calls.navigateTo.length, 0);
      // Stash still updates so re-open picks up the latest cwd via getCwd().
      assert.strictEqual(panel.getLastLiveCwd('sess-a'), '/Users/foo/code');
    });

    it('ignores empty / null sessionId or cwd (defensive)', function () {
      const { panel, calls } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      panel._open = true;
      panel.notifyCwdChanged(null, '/Users/foo/code');
      panel.notifyCwdChanged('sess-a', null);
      panel.notifyCwdChanged('', '');
      assert.strictEqual(calls.navigateTo.length, 0);
    });

    it('refreshes the follow-toggle UI on every event (tooltip update)', function () {
      const { panel, calls } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      const before = calls.refreshFollowToggleUI;
      panel.notifyCwdChanged('sess-a', '/Users/foo/code');
      assert.ok(calls.refreshFollowToggleUI > before);
    });
  });

  describe('manual navigation flips following off', function () {
    it('_markManualNav flips the active session to following=false', function () {
      const { panel } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      assert.strictEqual(panel.followsTerminal('sess-a'), true);
      panel._markManualNav();
      assert.strictEqual(panel.followsTerminal('sess-a'), false);
    });

    it('_markManualNav with no active session is a no-op (defensive)', function () {
      const { panel } = makePanel({ app: {} });
      // Should not throw; flag stays default.
      panel._markManualNav();
      assert.strictEqual(panel.followsTerminal('sess-a'), true);
    });
  });

  describe('per-session isolation', function () {
    it('flipping sess-a does not affect sess-b', function () {
      const { panel } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      panel.setFollowsTerminal('sess-a', false);
      panel.setFollowsTerminal('sess-b', true);
      assert.strictEqual(panel.followsTerminal('sess-a'), false);
      assert.strictEqual(panel.followsTerminal('sess-b'), true);
    });

    it('cwd updates for sess-b stash independently of sess-a state', function () {
      const { panel } = makePanel({ app: { currentClaudeSessionId: 'sess-a' } });
      panel.notifyCwdChanged('sess-a', '/a');
      panel.notifyCwdChanged('sess-b', '/b');
      assert.strictEqual(panel.getLastLiveCwd('sess-a'), '/a');
      assert.strictEqual(panel.getLastLiveCwd('sess-b'), '/b');
    });

    // -----------------------------------------------------------------------
    // Concurrency scenario (task #8 part 3): user opens 3 sessions and
    // switches fast between them. Each session keeps its own follow
    // state + its own stashed liveCwd; switching active sessions does
    // NOT bleed state between them.
    //
    // Models the real fast-switch flow:
    //   - sess-A starts, OSC 7 fires once (panel re-roots, follow=true).
    //   - User switches to sess-B (active sessionId changes), OSC 7 fires
    //     in sess-B's PTY (panel re-roots to sess-B's cwd).
    //   - User toggles "follow" off in sess-B — only sess-B is affected.
    //   - User switches to sess-C, never seen before — defaults to
    //     follow=true, no stashed liveCwd.
    //   - User switches BACK to sess-A — panel still respects sess-A's
    //     own follow state (true), and a fresh OSC 7 in sess-A re-roots.
    // -----------------------------------------------------------------------
    it('3-session fast-switch — per-session state survives session switching', function () {
      // Tiny app shim with mutable currentClaudeSessionId so we can
      // simulate session switching cleanly.
      const app = { currentClaudeSessionId: 'sess-A' };
      const { panel, calls } = makePanel({ app: app });
      panel._open = true;

      // sess-A: OSC 7 → re-root.
      panel.notifyCwdChanged('sess-A', '/Users/foo/sess-A');
      assert.deepStrictEqual(calls.navigateTo, ['/Users/foo/sess-A']);

      // Switch to sess-B (UI side).
      app.currentClaudeSessionId = 'sess-B';
      // sess-B's first OSC 7.
      panel.notifyCwdChanged('sess-B', '/Users/foo/sess-B');
      assert.deepStrictEqual(calls.navigateTo, ['/Users/foo/sess-A', '/Users/foo/sess-B']);

      // User pauses follow in sess-B only.
      panel.setFollowsTerminal('sess-B', false);
      assert.strictEqual(panel.followsTerminal('sess-A'), true,
        'sess-A follow MUST stay true');
      assert.strictEqual(panel.followsTerminal('sess-B'), false,
        'sess-B follow MUST be false');

      // sess-B fires another OSC 7 — must NOT re-root (paused).
      panel.notifyCwdChanged('sess-B', '/Users/foo/sess-B-elsewhere');
      // navigateTo count unchanged — last entry still sess-B's first.
      assert.strictEqual(calls.navigateTo.length, 2,
        'paused session must not re-root: ' + JSON.stringify(calls.navigateTo));
      // But the stash still updated.
      assert.strictEqual(panel.getLastLiveCwd('sess-B'), '/Users/foo/sess-B-elsewhere');

      // Switch to sess-C — never seen before, defaults to follow=true.
      app.currentClaudeSessionId = 'sess-C';
      assert.strictEqual(panel.followsTerminal('sess-C'), true);
      // First OSC 7 in sess-C → re-root.
      panel.notifyCwdChanged('sess-C', '/Users/foo/sess-C');
      assert.deepStrictEqual(calls.navigateTo, [
        '/Users/foo/sess-A',
        '/Users/foo/sess-B',
        '/Users/foo/sess-C',
      ]);

      // Switch back to sess-A.
      app.currentClaudeSessionId = 'sess-A';
      // sess-A's follow state preserved (true); stashed cwd still /Users/foo/sess-A.
      assert.strictEqual(panel.followsTerminal('sess-A'), true);
      assert.strictEqual(panel.getLastLiveCwd('sess-A'), '/Users/foo/sess-A');
      // A new OSC 7 in sess-A → re-roots.
      panel.notifyCwdChanged('sess-A', '/Users/foo/sess-A2');
      assert.strictEqual(calls.navigateTo[calls.navigateTo.length - 1], '/Users/foo/sess-A2');

      // sess-B's pause state STILL holds across the switch — switch
      // back and confirm it stayed false.
      app.currentClaudeSessionId = 'sess-B';
      assert.strictEqual(panel.followsTerminal('sess-B'), false,
        'sess-B paused state must survive switching');
    });

    it('per-session getLastLiveCwd is not contaminated by switching', function () {
      const app = { currentClaudeSessionId: 'sess-A' };
      const { panel } = makePanel({ app: app });
      panel.notifyCwdChanged('sess-A', '/a/here');
      panel.notifyCwdChanged('sess-B', '/b/there');
      panel.notifyCwdChanged('sess-C', '/c/elsewhere');
      // Switching active session must NOT mutate the stash.
      app.currentClaudeSessionId = 'sess-B';
      assert.strictEqual(panel.getLastLiveCwd('sess-A'), '/a/here');
      assert.strictEqual(panel.getLastLiveCwd('sess-B'), '/b/there');
      assert.strictEqual(panel.getLastLiveCwd('sess-C'), '/c/elsewhere');
      app.currentClaudeSessionId = 'sess-C';
      assert.strictEqual(panel.getLastLiveCwd('sess-A'), '/a/here');
    });
  });
});
