'use strict';

// Static wiring guard for the repaint-assist path: the unit suites prove
// the server gates, the e2e proves the live handshake, but nothing else
// would catch someone deleting the CLIENT triggers (post-replay hook,
// visibility/focus handlers, split-pane hook). These assertions pin the
// wiring points without running a browser.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
const splitsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'splits.js'), 'utf8');

describe('repaint-assist client wiring', function () {
  it('hooks canvas refresh + assist into the session_joined replay drain', function () {
    // Several `_releaseJoinRepaint(repaintGeneration)` call sites exist
    // (watchdog, barriers); the replay-drain one is the site followed by
    // a tab-switch assist request.
    const marker = 'this._releaseJoinRepaint(repaintGeneration);';
    let idx = -1;
    let found = -1;
    while ((idx = appSrc.indexOf(marker, idx + 1)) !== -1) {
      if (appSrc.slice(idx, idx + 600).includes("this._requestRepaintAssist('tab-switch')")) {
        found = idx;
        break;
      }
    }
    assert.ok(found > 0, 'a replay barrier releasing into a tab-switch assist should exist');
    const before = appSrc.slice(Math.max(0, found - 800), found);
    assert.ok(
      before.includes('this._refreshTerminalCanvas()'),
      'replay drain must invalidate the canvas before releasing'
    );
  });

  it('gates the assist on alt-screen with a per-session debounce', function () {
    assert.ok(appSrc.includes('_requestRepaintAssist(reason)'), 'assist helper should exist');
    const body = appSrc.slice(appSrc.indexOf('_requestRepaintAssist(reason)'));
    assert.ok(body.includes("buf.active.type === 'alternate'"), 'assist must be alt-screen only');
    assert.ok(body.includes('_lastRepaintAssistSid'), 'assist must debounce per session');
    assert.ok(
      body.includes("send({ type: 'request_repaint'"),
      'assist must send request_repaint on the joined socket'
    );
  });

  it('repaints on browser visible and focus without racing a replay', function () {
    assert.ok(
      appSrc.includes("this._repaintOnRefocus('browser-focus')"),
      'visible/focus path must run the refocus repaint'
    );
    const helperIdx = appSrc.indexOf('_repaintOnRefocus(reason)');
    assert.ok(helperIdx > 0, 'refocus helper should exist');
    const helperBody = appSrc.slice(helperIdx, helperIdx + 2000);
    assert.ok(
      helperBody.includes('this._refreshTerminalCanvas()'),
      'refocus must invalidate the canvas'
    );
    assert.ok(
      helperBody.includes('paintCached(this.currentClaudeSessionId)'),
      'refocus must repaint the cached (IDB) screen for alt sessions'
    );
    assert.ok(
      helperBody.includes('this._requestRepaintAssist(reason)'),
      'refocus must request the server assist on top of the cached frame'
    );
    assert.ok(
      appSrc.includes('if (!this._joinRepaintInProgress)'),
      'focus-time refresh must not race an in-flight replay'
    );
    assert.ok(
      splitsSrc.includes('this._requestSplitRepaintAssist('),
      'split panes must assist over their own socket'
    );
    assert.ok(
      splitsSrc.includes("type: 'request_repaint'"),
      'split assist must send request_repaint'
    );
  });

  it('handles the server ack explicitly instead of the unknown-message path', function () {
    assert.ok(appSrc.includes("case 'repaint_assisted':"), 'app must handle repaint_assisted');
    assert.ok(splitsSrc.includes("case 'repaint_assisted':"), 'splits must handle repaint_assisted');
  });

  it('keeps terminal resize ownership in FitCoordinator', function () {
    // The assist is a server-side PTY resize; the client must never add
    // its own terminal.resize/fit calls on this path (ADR-0046).
    for (const [name, src] of [['app.js', appSrc], ['splits.js', splitsSrc]]) {
      const lines = src.split('\n');
      const refreshIdx = lines.findIndex((l) => l.includes('_refreshTerminalCanvas() {'));
      const assistIdx = lines.findIndex((l) => l.includes('_requestRepaintAssist(reason)'));
      const scope = lines.slice(
        Math.min(...[refreshIdx, assistIdx].filter((i) => i >= 0)),
        Math.max(refreshIdx, assistIdx) + 60
      ).join('\n');
      assert.ok(
        !/\bterminal\.resize\s*\(|\bfitAddon\.fit\s*\(/.test(scope),
        `${name} repaint helpers must use refresh(), never resize()/fit()`
      );
    }
  });
});
